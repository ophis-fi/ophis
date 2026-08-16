# Ophis Lite

Ophis Lite is a dependency-free, single-file local interface prototype. This
milestone proves deterministic bytes and an auditable content manifest; it does
not connect a wallet, sign an order, submit to an orderbook, or execute a
transaction.

From `apps/frontend`:

```sh
pnpm --filter @ophis/lite verify
```

The build writes ignored artifacts to `apps/ophis-lite/dist/` and fails if the
source contains external resources, executable scripts, mutable build tokens,
or machine-local paths. `config/expected-manifest.json` pins the reviewed source
bytes. A serving gateway must add `frame-ancestors 'none'` as an HTTP response
header because browsers do not enforce that directive from an HTML meta tag.
There is no deployment script in this package.
