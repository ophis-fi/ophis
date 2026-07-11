# Cloudflare named tunnel for `unichain-mainnet.ophis.fi`

Stable public hostname that fronts the Unichain (chain 130) orderbook on the
sovereign VM (`root@51.158.205.9`, orderbook bound to `127.0.0.1:8400`). This
is the endpoint the frontend's `cowSdk.ts` routes chain 130 to; it replaces the
anonymous `trycloudflare.com` quick tunnel used during Gate-6 shadow validation.

The connector runs ON the Unichain VM (the orderbook is its `localhost:8400`),
so this needs its OWN named tunnel — it cannot reuse the `3615crypto` /
`rebates` tunnels, whose connectors run on other hosts.

Account: `4761b41ef352631db0ed367fea98ffdc`. Zone `ophis.fi`: `dd7588...`.

## Prerequisite (one-time, Clement)

The repo's scoped `cloudflare-api-token` has Cloudflare Tunnel **Read** but not
**Edit** (verified: `POST /cfd_tunnel` returns `10000 Authentication error`).
Pick ONE:

- **A (recommended).** Mint an API token at
  `dash.cloudflare.com/profile/api-tokens` with:
  - Account, Cloudflare Tunnel, **Edit** (account `4761b41e...`)
  - Zone, DNS, **Edit** (zone `ophis.fi`)
  Store it in the Mac keychain so the automation picks it up:
  `security add-generic-password -a "$USER" -s cloudflare-tunnel-token -w '<TOKEN>' -U`
  Then everything below is automatable from the Mac (no VM browser needed).

- **B.** On the VM, `cloudflared tunnel login` (browser, pick the ophis
  account). The resulting `~/.cloudflared/cert.pem` lets `cloudflared tunnel
  create` + `route dns` run locally without an Edit-scoped API token.

## Setup — Variant A (API token)

```bash
ACCT=4761b41ef352631db0ed367fea98ffdc
ZONE=dd7588...            # zones?name=ophis.fi
CF_TOKEN=...              # the Tunnel:Edit + DNS:Edit token

# 1. Create the remote-managed tunnel.
TID=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"unichain-mainnet","config_src":"cloudflare"}' | jq -r '.result.id')

# 2. Route ingress to the orderbook (remote config).
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel/$TID/configurations" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  -d '{"config":{"ingress":[
        {"hostname":"unichain-mainnet.ophis.fi","service":"http://localhost:8400"},
        {"service":"http_status:404"}]}}'

# 3. Proxied CNAME unichain-mainnet -> <TID>.cfargotunnel.com.
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"CNAME\",\"name\":\"unichain-mainnet\",\"content\":\"$TID.cfargotunnel.com\",\"proxied\":true,\"ttl\":1}"

# 4. Connector token (SECRET — never echo; pipe straight to the VM).
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel/$TID/token" \
  -H "Authorization: Bearer $CF_TOKEN" | jq -r '.result' \
  | ssh -p 24005 root@51.158.205.9 \
      'umask 077; mkdir -p /etc/ophis; printf "TUNNEL_TOKEN=%s\n" "$(cat)" > /etc/ophis/unichain-tunnel.env'
```

Then on the VM (`ssh -p 24005 root@51.158.205.9`):

```bash
# cloudflared present? (the quick-tunnel service already uses it)
command -v cloudflared || curl -L -o /usr/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  && chmod +x /usr/bin/cloudflared

# Install the unit (this directory's cloudflared-unichain-tunnel.service), then:
systemctl daemon-reload
systemctl enable --now cloudflared-unichain-tunnel
```

## Setup — Variant B (cloudflared login, on the VM)

```bash
cloudflared tunnel login                                   # browser; pick ophis
cloudflared tunnel create unichain-mainnet                 # writes ~/.cloudflared/<id>.json
cloudflared tunnel route dns unichain-mainnet unichain-mainnet.ophis.fi
# config.yml: tunnel:<id>; credentials-file:/root/.cloudflared/<id>.json
#   ingress: [{hostname: unichain-mainnet.ophis.fi, service: http://localhost:8400},
#             {service: http_status:404}]
# then `cloudflared tunnel run unichain-mainnet` via systemd.
```

## Verify

```bash
curl -fsS https://unichain-mainnet.ophis.fi/api/v1/version | jq
# expect the orderbook version JSON (200). DNS may take ~1 min to propagate.
```

## Note — does NOT flip production

Creating this tunnel only makes the endpoint exist. The frontend (#719) stays a
draft until the 24h Timelock + Guardian land; swap.ophis.fi does not route chain
130 here until that PR merges and deploys. Leave the quick tunnel running until
then (both ingress the same orderbook); retire it when #719 ships.

## Rotation / teardown

- Delete the CNAME and the tunnel (`DELETE /cfd_tunnel/<id>`), or `cloudflared
  tunnel delete unichain-mainnet`.
- `systemctl disable --now cloudflared-unichain-tunnel` on the VM; remove
  `/etc/ophis/unichain-tunnel.env`.
