# @ophis/agent-skills

The Ophis agent-skill family, packaged for npm. Markdown skills for AI agents
with local tool access (bash, `curl`, `jq`, Foundry's `cast`) that drive
Ophis, the non-custodial, intent-based, MEV-protected DEX aggregator, on the
chains Ophis operates itself.

An Ophis order is not a transaction: it is an off-chain, EIP-712-signed intent
with a hard minimum. Solvers compete to fill it inside a batch auction at a
uniform clearing price, the signer pays no gas at settlement, and any price
improvement beyond the signed minimum is returned to the trader as surplus.

## What is inside

```
ophis/
  SKILL.md                   Umbrella: eight safety rules + a machine-readable
                             per-chain policy block (pinned settlement and
                             vault-relayer contracts, EIP-712 domains,
                             orderbook hosts, slippage latches)
  skills/
    ophis-quote.md           Best-execution quote (read-only)
    ophis-swap.md            Execute a swap: quote, confirm, exact approval,
                             sign, submit
    ophis-order-status.md    Track an order by UID (read-only)
    ophis-cancel.md          Gasless cancellation, single or batch
    ophis-surplus-report.md  Surplus earned, total and per order (read-only)
  README.md                  Family guide: environment, verification, policy
  LICENSE                    MIT, with the retained upstream skeleton notice
index.json                   The family's slice of the canonical discovery
                             manifest: sha256 digest + canonical URL per skill
```

## Canonical source

The canonical, always-current home of these skills is
`https://ophis.fi/.well-known/agent-skills/`, with a discovery manifest at
[`index.json`](https://ophis.fi/.well-known/agent-skills/index.json) carrying
a sha256 digest per file. This package is built from those exact files at
release time: the release gate recomputes every digest against the hosted
manifest and fails on any mismatch, so the tarball can never fork from what
ophis.fi serves. If you want updates without waiting for an npm release,
fetch from ophis.fi directly.

## Install

For Claude Code:

```bash
npm i @ophis/agent-skills
rm -rf ~/.claude/skills/ophis
cp -R node_modules/@ophis/agent-skills/ophis ~/.claude/skills/ophis
```

Or without a project, into any agent's skill directory:

```bash
npm pack @ophis/agent-skills
tar -xzf ophis-agent-skills-*.tgz
rm -rf /path/to/your/agent/skills/ophis
cp -R package/ophis /path/to/your/agent/skills/ophis
```

The `rm -rf` matters when upgrading: with an existing destination, `cp -R`
would nest the new copy inside it (`ophis/ophis`) and the agent would keep
loading the old skill and its old safety policy.

The agent loads `ophis/SKILL.md` (the umbrella), which routes to the
sub-skills under `ophis/skills/` per operation.

## Verify what you installed

Every skill file's sha256 must equal the digest in the packaged `index.json`,
which is the same digest the canonical manifest at ophis.fi advertises:

```bash
shasum -a 256 ophis/SKILL.md   # compare to the digest in index.json
```

A mismatch means a stale or tampered copy: discard it and fetch from
`https://ophis.fi/.well-known/agent-skills/`.

## Requirements

- Read-only skills (`ophis-quote`, `ophis-order-status`,
  `ophis-surplus-report`): `curl` + `jq` only. No RPC, no key.
- Execution skills (`ophis-swap`, `ophis-cancel`): also Foundry's `cast`, a
  per-chain `RPC_URL`, and an encrypted keystore (`OPHIS_KEYSTORE` +
  `OPHIS_KEYSTORE_PASSWORD_FILE`). A raw private key in the environment is
  not a supported path.

See `ophis/README.md` for the full environment table.

## Safety model

The umbrella `SKILL.md` frontmatter carries a machine-readable policy
(`metadata.openclaw.web3.policy`): the allowed contracts per chain, the only
allowed `approve` spenders (the pinned vault relayer, exact amounts, never
unlimited), the EIP-712 signing domains, the pinned orderbook hosts, and
slippage latches. Policy-enforcing agent runtimes can apply it mechanically;
every other agent should treat it as the source of truth the prose rules
point back to. Repository CI pins each of those literals against the deployed
contracts and the `@ophis/sdk` maps, so the published skills cannot drift
from what is deployed.

## Hosted alternative

Agents that cannot shell out can use the hosted Ophis MCP server at
`https://mcp.ophis.fi/mcp` (discovery:
`https://ophis.fi/.well-known/mcp.json`).

## License

MIT, see `LICENSE`. It retains the required upstream copyright notice for the
skill skeleton the family was forked from.
