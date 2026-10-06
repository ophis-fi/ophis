import { pathToFileURL } from 'node:url';

const API = 'https://1click.chaindefuser.com/v0';
const STARKNET = 'nep141:starknet.omft.near';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const ROUTES = [
  { name: 'Starknet STRK → Base USDC', source: STARKNET, destination: BASE_USDC, amount: 90 },
  { name: 'Base USDC → Starknet STRK', source: BASE_USDC, destination: STARKNET, amount: 10 },
];

// Public dummy addresses: this probe requests only dry quotes and never deposits.
const address = (asset) => `0x${'1'.repeat(asset === STARKNET ? 63 : 40)}`;

export async function checkNearQuotes({ fetcher = fetch, apiKey = '', report = console.log } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const tokensResponse = await fetcher(`${API}/tokens`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!tokensResponse.ok) throw new Error(`Token catalogue: HTTP ${tokensResponse.status}`);
  const tokens = await tokensResponse.json();
  const results = await Promise.allSettled(
    ROUTES.map(async (route) => {
      const token = tokens.find((item) => item.assetId === route.source);
      if (!token || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36)
        throw new Error(`${route.name}: source asset missing or invalid decimals`);
      const response = await fetcher(`${API}/quote`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          dry: true,
          swapType: 'EXACT_INPUT',
          slippageTolerance: 100,
          originAsset: route.source,
          destinationAsset: route.destination,
          amount: String(BigInt(route.amount) * 10n ** BigInt(token.decimals)),
          depositType: 'ORIGIN_CHAIN',
          refundType: 'ORIGIN_CHAIN',
          recipientType: 'DESTINATION_CHAIN',
          refundTo: address(route.source),
          recipient: address(route.destination),
          deadline: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          referral: 'ophis',
          appFees: [{ recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8', fee: 3 }],
          ...(apiKey ? { confidentiality: 'basic' } : {}),
        }),
      });
      const body = await response.json();
      const available =
        response.ok && /^\d+$/.test(body.quote?.amountOut) && BigInt(body.quote.amountOut) > 0n;
      const result = {
        route: route.name,
        available,
        status: response.status,
        correlationId: body.correlationId,
        message: body.message,
        amountOut: body.quote?.amountOut,
      };
      report(JSON.stringify(result));
      if (!available) throw new Error(`${route.name}: no positive quote (HTTP ${response.status})`);
      return result;
    }),
  );
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [`${ROUTES[index].name}: ${result.reason.message}`] : [],
  );
  if (failures.length) throw new Error(failures.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkNearQuotes({ apiKey: process.env.REACT_APP_NEAR_API_KEY }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
