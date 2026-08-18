# Release publishing controls

Ophis package and MCP releases use protected version tags. Repository ruleset
[`protect-release-tags`](https://github.com/ophis-fi/ophis/rules/21001422)
restricts creation, update, and deletion of these tags to organization admins:

- `sdk-v*`
- `skills-v*`
- `widget-v*`
- `safe-swap-v*`
- `agent-plugins-v*`
- `mcp-v*`

Every release workflow also checks that the tagged commit is reachable from
`main` and that the tag suffix exactly matches the package or manifest version.
This prevents an accidentally tagged feature branch from publishing even when
the tag creator is authorized.

## npm packages

The npm workflows install with lifecycle scripts disabled, build and test the
reviewed workspace sources, publish only prebuilt artifacts, and emit npm
provenance. `NPM_TOKEN` remains the publishing credential until npm trusted
publishing has been bootstrapped for every existing package; the protected tag
ruleset removes the arbitrary-tag trigger identified in issue #908.

Trusted publishing should be migrated package-by-package with npm CLI 11.15 or
newer and an npm account with 2FA. For example:

```sh
npm trust github @ophis/sdk \
  --repo ophis-fi/ophis \
  --file sdk-release.yml \
  --allow-publish
```

Configure the corresponding workflow for each published package, verify an
OIDC release, then remove `NODE_AUTH_TOKEN` from that workflow. Revoke
`NPM_TOKEN` only after all package trust relationships have been verified.

## MCP Registry

The Worker deploys from `main` first. An organization admin then tags the same
commit as `mcp-v<x.y.z>`. The registry workflow:

1. checks version equality and `main` ancestry;
2. runs the SDK build plus MCP typecheck and tests;
3. requires `https://mcp.ophis.fi/health` to report the tagged version;
4. reasserts the `fi.ophis/*` DNS proof using the DNS-only Cloudflare token;
5. verifies the pinned `mcp-publisher` v1.8.1 archive checksum; and
6. publishes `apps/mcp-server/server.json` with the encrypted
   `MCP_PRIVATE_KEY` repository secret.

Never create the MCP tag before the Worker deployment succeeds: the live-version
gate intentionally rejects registry metadata that is ahead of production.
