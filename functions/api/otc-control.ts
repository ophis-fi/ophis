interface Env {
  OPHIS_OTC_CONTROL?: R2Bucket;
}

/** A private R2 binding supplies strongly consistent reads; never use the CDN or KV here. */
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const nonce = url.searchParams.get('nonce');
  const headers = { 'cache-control': 'no-store, max-age=0', 'cdn-cache-control': 'no-store' };
  if (request.method !== 'GET')
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } });
  if (!nonce || !/^[a-f0-9]{32}$/.test(nonce)) return new Response(null, { status: 400, headers });
  try {
    // Preview deployments must never receive production authorization, even if a binding is copied.
    if (url.origin !== 'https://swap.ophis.fi' || !env.OPHIS_OTC_CONTROL)
      throw new Error('Control unavailable');
    const object = await env.OPHIS_OTC_CONTROL.get('ethereum-mainnet.json');
    if (!object || object.size > 1_024) throw new Error('Control unavailable');
    const value: unknown = await object.json();
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Control invalid');
    const control = value as Record<string, unknown>;
    const enabled =
      control.enabled === true &&
      typeof control.expiresAt === 'number' &&
      Number.isSafeInteger(control.expiresAt) &&
      control.expiresAt > Date.now();
    return Response.json({ enabled, nonce }, { headers });
  } catch {
    return Response.json({ enabled: false, nonce }, { status: 503, headers });
  }
};
