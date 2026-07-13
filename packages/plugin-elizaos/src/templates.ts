// XML extraction template (elizaOS v1 pattern: composePromptFromState -> useModel ->
// parseKeyValueXml). Ophis does SAME-CHAIN swaps only; the model must not invent a
// token address — it returns the 0x address if it knows it, else the symbol, and the
// handler resolves/validates it.
export const swapTemplate = `Extract the details of a SAME-CHAIN token swap the user wants to make via Ophis (a CoW Protocol MEV-protected swap).

{{recentMessages}}

Supported chains: {{supportedChains}}. Ophis is same-chain only — it does NOT bridge across chains.
For inputToken and outputToken, output the token's 0x contract address if you are certain of it; otherwise output the token symbol (e.g. USDC, WETH). Do NOT guess or fabricate a contract address. Native ETH is not supported — use WETH.
amount is the quantity of inputToken to sell, in WHOLE units (e.g. "1.5"), never base units.

Respond with ONLY the following XML block. Use an empty tag for anything you cannot determine.
<response>
  <inputToken>0x address or token symbol</inputToken>
  <outputToken>0x address or token symbol</outputToken>
  <amount>whole-unit amount, e.g. 1.5</amount>
  <chain>one of: {{supportedChains}}</chain>
</response>

IMPORTANT: your entire response must be ONLY the <response>...</response> block, nothing else.`;
