// The Worker workerd.test.ts runs: every case of cases.ts, inside workerd, answered as JSON.
import { runAll } from '../cases.ts';

export default {
  async fetch(request: Request): Promise<Response> {
    const only = new URL(request.url).searchParams.get('case') ?? undefined;
    // navigator.userAgent is Cloudflare-Workers in workerd: the test checks it ran there.
    return Response.json(await runAll(only), { headers: { 'x-runtime': navigator.userAgent } });
  },
};
