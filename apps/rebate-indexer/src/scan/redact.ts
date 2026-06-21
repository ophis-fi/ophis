// Strip secrets that can ride along in error messages before they become
// user-facing (the terminal table AND the on-disk JSON artifact via coverage.error).
//
// The leak this defends against: the Alchemy key lives in the RPC URL PATH
// (https://<net>.g.alchemy.com/v2/<KEY>), and viem's HttpRequestError echoes the
// URL in its `.message`. A hosted-chain failure (e.g. a 429) therefore carries the
// key into coverage.error, which is printed and persisted. Redact at every sink.
export function redactSecrets(s: string): string {
  let out = s
    // Provider URL `/v2/<key>` style path segment (Alchemy and lookalikes).
    .replace(/(\.g\.alchemy\.com\/v2\/)[A-Za-z0-9_-]+/g, '$1***')
    // Generic api-key query params, defensively.
    .replace(/([?&](?:apikey|api_key|key|token)=)[^&\s]+/gi, '$1***');
  // Strongest pass: redact the exact live secret values wherever they appear, in
  // any URL/message shape. These env vars are populated before any RPC call.
  for (const name of ['ALCHEMY_API_KEY', 'TELEGRAM_BOT_TOKEN']) {
    const v = process.env[name];
    if (v && v.length >= 8) out = out.split(v).join('***');
  }
  return out;
}
