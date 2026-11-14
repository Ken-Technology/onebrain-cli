import { ApiError, apiUrl, CliError, type Command, connect, unwrap } from '../client.ts';
import { writeConfig } from '../config.ts';
import { createCredentialStore, discover } from '../credentials.ts';

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

async function findIssuer(url: string, env: Record<string, string | undefined>): Promise<string> {
  if (env.OIDC_ISSUER) return env.OIDC_ISSUER;
  const response = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
  const doc = response.ok
    ? ((await response.json().catch(() => null)) as { authorization_servers?: string[] } | null)
    : null;
  const issuer = doc?.authorization_servers?.[0];
  if (!issuer) {
    throw new CliError(`Set OIDC_ISSUER: ${url} does not publish its sign-in metadata yet.`);
  }
  return issuer;
}

export default {
  name: 'login',
  describe:
    'Sign in with your browser (device authorization)\n\nUsage: onebrain login\n\nNeeds ONEBRAIN_CLI_CLIENT_ID. Reads OIDC_ISSUER (else asks the API) and OIDC_AUDIENCE.\nONEBRAIN_URL sets the API (default http://localhost:8787).',
  run: async (_args, io) => {
    const clientId = io.env.ONEBRAIN_CLI_CLIENT_ID;
    if (!clientId) {
      throw new CliError('Set ONEBRAIN_CLI_CLIENT_ID to the One Brain CLI client id.', 2);
    }
    const url = apiUrl(io.env, io.home);
    const issuer = await findIssuer(url, io.env);
    const audience = io.env.OIDC_AUDIENCE || null;
    const tokens = await deviceLogin({
      issuer,
      clientId,
      audience,
      fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      show: (uri, code) => io.stderr(`Open ${uri} and confirm the code ${code}.\n`),
    });
    const store = createCredentialStore({ home: io.home, env: io.env });
    const where = await store.save({ url, issuer, clientId, audience, ...tokens });
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
