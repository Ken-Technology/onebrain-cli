import { ApiError, type CliClient, CliError, type Io, unwrap } from '../client.ts';

/**
 * Makes sure the --into folder exists. An existing folder is used as it is, unless it is open to the
 * whole workspace (and not under me/): every member would read the import, so that needs
 * allowOpen. A missing one under me/ is the caller's own private folder. Any other missing one is
 * created restricted with a manage grant to the importer, which only a person can do.
 */
export async function ensureImportFolder(
  client: CliClient,
  into: string,
  io: Io,
  options: { allowOpen?: boolean } = {},
): Promise<'created' | 'existing'> {
  const { api, workspace } = client;
  const params = { path: { workspace } };

  try {
    const tree = unwrap(
      await api.GET('/v1/workspaces/{workspace}/tree', {
        params: { ...params, query: { path: into } },
      }),
    );
    if (tree.node) {
      const mine = into === 'me' || into.startsWith('me/');
      if (tree.node.access === 'open' && !mine && !options.allowOpen) {
        throw new CliError(
          `${into} is open to the whole workspace. Import into a restricted folder, or pass --allow-open to import where everyone can read.`,
        );
      }
      return 'existing';
    }
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'not_found')) throw error;
  }

  if (into === 'me' || into.startsWith('me/')) {
    unwrap(await api.POST('/v1/workspaces/{workspace}/folders', { params, body: { path: into } }));
    io.stderr(`Created ${into}: private.\n`);
    return 'created';
  }

  const me = unwrap(await api.GET('/v1/me'));
  if (me.principal.kind === 'agent') {
    throw new CliError(
      `An agent key cannot create ${into}: only a person can grant access. A person runs onebrain admin folders create ${into} --access restricted and onebrain admin grants put ${into} --principal <their email> --role manage; then import again.`,
    );
  }
  const email = me.principal.email;
  if (!email) throw new CliError(`Cannot grant access on ${into}: your account has no email.`);
  unwrap(
    await api.POST('/v1/workspaces/{workspace}/folders', {
      params,
      body: { path: into, access: 'restricted' },
    }),
  );
  unwrap(
    await api.PUT('/v1/workspaces/{workspace}/grants', {
      params,
      body: { path: into, principal: email, role: 'manage' },
    }),
  );
  io.stderr(`Created ${into}: restricted, manage for ${email}.\n`);
  return 'created';
}
