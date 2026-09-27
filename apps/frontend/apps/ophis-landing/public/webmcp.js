/**
 * WebMCP (https://webmachinelearning.github.io/webmcp/) tool registration for
 * ophis.fi. Exposes Ophis's real, public capabilities to in-browser AI agents
 * via navigator.modelContext, so an agent on the page can parse a swap request
 * or open the swap app without leaving the tab.
 *
 * Loaded as an external script (script-src 'self'), so no inline CSP hash is
 * needed. Feature-detected: a no-op in browsers without navigator.modelContext.
 * No keys, no funds: the tools only normalize text (the public /api/intent) and
 * build a deep link. Order signing always happens in the user's own wallet.
 */
(function registerOphisWebMcpTools() {
  try {
    var mc = typeof navigator !== 'undefined' && navigator.modelContext
    if (!mc) return

    var tools = [
      {
        name: 'parse_swap_intent',
        description:
          'Parse a natural-language swap or bridge request into a structured intent ' +
          '(sell token, buy token, amount, chain) using Ophis. Public, no key, no funds moved.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The swap request in plain words, e.g. "swap 100 USDC for ETH on Base".',
            },
          },
          required: ['text'],
        },
        async execute(args) {
          var text = args && typeof args.text === 'string' ? args.text : ''
          var res = await fetch('/api/intent', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: text }),
          })
          var data = await res.json()
          return { content: [{ type: 'text', text: JSON.stringify(data) }] }
        },
      },
      {
        name: 'open_ophis_swap',
        description:
          'Open the Ophis swap app (swap.ophis.fi), optionally pre-filling a chain. ' +
          'Returns the URL; the user reviews and signs the order in their own wallet.',
        inputSchema: {
          type: 'object',
          properties: {
            chain: {
              type: 'string',
              description: 'Optional chain slug, e.g. "optimism", "base", "arbitrum".',
            },
          },
        },
        async execute(args) {
          var chain = args && args.chain
          var chainIds = {
            ethereum: 1, optimism: 10, bnb: 56, gnosis: 100, unichain: 130,
            polygon: 137, robinhood: 4663, arc: 5042, base: 8453, plasma: 9745,
            arbitrum: 42161, avalanche: 43114, ink: 57073, linea: 59144,
          }
          if (chain != null && typeof chain !== 'string') throw new Error('Invalid chain slug')
          var slug = chain ? chain.trim().toLowerCase() : ''
          if (slug && !Object.prototype.hasOwnProperty.call(chainIds, slug)) throw new Error('Unsupported chain slug')
          var url = 'https://swap.ophis.fi/' + (slug ? '#/' + chainIds[slug] + '/swap' : '')
          return { content: [{ type: 'text', text: url }] }
        },
      },
    ]

    if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools: tools })
    } else if (typeof mc.registerTool === 'function') {
      tools.forEach(function registerOne(t) {
        mc.registerTool(t)
      })
    }
  } catch (e) {
    /* WebMCP unavailable or registration failed: silent no-op for normal browsers */
  }
})()
