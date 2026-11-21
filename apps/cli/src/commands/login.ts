import { ApiError, apiUrl, CliError, type Command, connect, unwrap } from '../client.ts';
import { writeConfig } from '../config.ts';
import {
  createCredentialStore,
  discover,
  RefreshLockBusy,
  withRefreshLock,
} from '../credentials.ts';

type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: string };

type DeviceLoginOptions = {
  issuer: string;
  clientId: string;
  audience: string | null;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  show: (verificationUri: string, userCode: string) => void;
  now?: () => number;
};

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

/** The OAuth device authorization flow: shows a code, then polls until the person confirms it. */
export async function deviceLogin(options: DeviceLoginOptions): Promise<Tokens> {
  const now = options.now ?? Date.now;
  const { deviceEndpoint, tokenEndpoint } = await discover(options.issuer, options.fetch);
  if (!deviceEndpoint) {
    throw new CliError(
      `The identity provider at ${options.issuer} does not offer the device flow.`,
    );
  }
  const start = await options.fetch(
    deviceEndpoint,
    form({
      client_id: options.clientId,
      scope: 'openid email profile offline_access',
      ...(options.audience ? { audience: options.audience } : {}),
    }),
  );
  const grant = (await start.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };
  if (!start.ok || !grant.device_code || !grant.user_code) {
    throw new CliError(`The identity provider refused the sign-in (HTTP ${start.status}).`);
  }
  options.show(
    grant.verification_uri_complete ?? grant.verification_uri ?? options.issuer,
    grant.user_code,
  );

  let interval = grant.interval ?? 5;
  const deadline = now() + (grant.expires_in ?? 600) * 1000;
  while (now() < deadline) {
    await options.sleep(interval * 1000);
    const response = await options.fetch(
      tokenEndpoint,
      form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: options.clientId,
      }),
    );
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (response.ok && body.access_token) {
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? null,
        expiresAt: new Date(now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      };
    }
    if (body.error === 'slow_down') interval += 5;
    else if (body.error === 'access_denied') throw new CliError('Sign-in was denied.');
    else if (body.error === 'expired_token') break;
    else if (body.error !== 'authorization_pending') {
      throw new CliError(`Sign-in failed: ${body.error ?? `HTTP ${response.status}`}.`);
    }
  }
  throw new CliError('The sign-in code expired. Run onebrain login again.');
}

type SignIn = { issuer: string; clientId: string; audience: string | null };

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * The issuer, the CLI's client id and the audience. A variable wins; what it leaves unset comes
 * from the API's protected-resource document, fetched once and only when something is missing.
 */
export async function signInSettings(
  url: string,
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch,
): Promise<SignIn> {
  const set = {
    issuer: env.OIDC_ISSUER || null,
    clientId: env.ONEBRAIN_CLI_CLIENT_ID || null,
    audience: env.OIDC_AUDIENCE || null,
  };
  let doc: Record<string, unknown> | null = null;
  if (!set.issuer || !set.clientId || !set.audience) {
    const response = await fetchFn(`${url}/.well-known/oauth-protected-resource/mcp`);
    const body: unknown = response.ok ? await response.json().catch(() => null) : null;
    if (body && typeof body === 'object') doc = body as Record<string, unknown>;
  }
  const servers = doc?.authorization_servers;
  const clientId = set.clientId ?? text(doc?.onebrain_cli_client_id);
  if (!clientId) {
    throw new CliError(
      `Set ONEBRAIN_CLI_CLIENT_ID to the One Brain CLI client id, or ask the admin of ${url} to set OIDC_CLI_CLIENT_ID.`,
      2,
    );
  }
  const issuer = set.issuer ?? text(Array.isArray(servers) ? servers[0] : null);
  if (!issuer) {
    throw new CliError(`Set OIDC_ISSUER: ${url} does not publish its sign-in metadata yet.`);
  }
  return { issuer, clientId, audience: set.audience ?? text(doc?.onebrain_audience) };
}

export default {
  name: 'login',
  describe:
    'Sign in with your browser (device authorization)\n\nUsage: onebrain login\n\nONEBRAIN_URL sets the API (default http://localhost:8787). The API publishes the issuer, the CLI client id\nand the audience; ONEBRAIN_CLI_CLIENT_ID, OIDC_ISSUER and OIDC_AUDIENCE override them when set.',
  run: async (_args, io) => {
    const url = apiUrl(io.env, io.home);
    const { issuer, clientId, audience } = await signInSettings(url, io.env, fetch);
    const tokens = await deviceLogin({
      issuer,
      clientId,
      audience,
      fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      show: (uri, code) => io.stderr(`Open ${uri} and confirm the code ${code}.\n`),
    });
    const store = createCredentialStore({ home: io.home, env: io.env });
    const save = () => store.save({ url, issuer, clientId, audience, ...tokens });
    // Under the lock the CLI and the Mac app refresh under, so a refresh of an older login is
    // never written over this one. A lock that stays held does not cost the sign-in.
    const where = await withRefreshLock({ home: io.home }, save).catch((error: unknown) => {
      if (error instanceof RefreshLockBusy) return save();
      throw error;
    });
    writeConfig(io.home, { url });

    const api = connect(url, tokens.accessToken);
    try {
      const { principal } = unwrap(await api.GET('/v1/me'));
      const place = where === 'keychain' ? 'the keychain' : '~/.config/onebrain/credentials.json';
      io.stdout(
        `Signed in as ${principal.displayName} (${principal.email ?? principal.kind}). Stored in ${place}.\n`,
      );
      return 0;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_invited') {
        io.stderr('Signed in, but no One Brain workspace has invited you yet.\n');
        return 1;
      }
      throw error;
    }
  },
} satisfies Command;
