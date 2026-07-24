# Ophis agent-skill family

Markdown skills for agents with **local tool access** (bash, `curl`, `jq`,
Foundry's `cast`). No server to install, no transport to configure: the agent
reads the skill and executes through its own shell. For hosted agents that
cannot shell out, use the Ophis MCP server at `https://mcp.ophis.fi/mcp`
instead (discovery: `https://ophis.fi/.well-known/mcp.json`).

## Layout

```
SKILL.md                        Umbrella: safety rules + machine-readable policy
skills/
  ophis-quote.md                Best-execution quote (read-only)
  ophis-swap.md                 Execute a swap (quote, confirm, sign, submit)
  ophis-order-status.md         Track an order by UID (read-only)
  ophis-cancel.md               Gasless cancellation, single or batch
  ophis-surplus-report.md       Surplus earned, total and per order (read-only)
```

## Install

Drop the folder wherever your agent looks for skills. For Claude Code:

```bash
mkdir -p ~/.claude/skills/ophis
curl -sS https://ophis.fi/.well-known/agent-skills/index.json |
  jq -r '.skills[] | select(.name | startswith("ophis")) | .url' |
  xargs -I{} sh -c 'curl -sS -o ~/.claude/skills/ophis/$(basename {}) {}'
```

## Verify what you downloaded

The discovery manifest at
`https://ophis.fi/.well-known/agent-skills/index.json` carries a sha256
digest per file. Verify before use; a mismatch means a stale or tampered
copy:

```bash
shasum -a 256 SKILL.md   # must equal the digest advertised in index.json
```

## The policy block

`SKILL.md`'s frontmatter carries a machine-readable policy
(`metadata.openclaw.web3.policy`): per-chain allowed contracts (the Ophis
settlement and vault relayer), the only allowed `approve` spenders, the
EIP-712 signing domains, the pinned orderbook hosts, and slippage latches.
Policy-enforcing agent runtimes can enforce it mechanically; every other
agent should treat it as the source of truth the prose rules point back to.
CI pins these addresses against the repo's deployment artifacts and the
`@ophis/sdk` maps (`scripts/check-agent-skills-invariant.mjs`), so the
published skills cannot drift from what is deployed.

## Required environment

| Var | When | Purpose |
| --- | --- | --- |
| `RPC_URL` | execution skills | per-chain RPC (approval tx, on-chain checks) |
| `OPHIS_KEYSTORE` | execution skills | encrypted Foundry keystore path |
| `OPHIS_KEYSTORE_PASSWORD_FILE` | execution skills | password file for the keystore |

Read-only skills (`ophis-quote`, `ophis-order-status`,
`ophis-surplus-report`) need only `curl` + `jq`: no RPC, no key.

Execution skills build `SIGNER_ARGS` from the keystore. A raw private key in
the environment is not documented as a supported path: child processes
inherit exported variables.

## License

MIT, see `LICENSE` (which retains the required upstream notice for the
skill skeleton this family was forked from).
