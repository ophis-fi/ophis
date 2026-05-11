# Cloudflare Tunnel binding for `rebates.ophis.fi`

## Decision (D3)
Share the existing `3615crypto` tunnel. Matches the pattern used for `allo.3615crypto.com` and `mcp-api.3615crypto.com`.

## One-time setup (executed by Clement on Aleph VM `ophis-rebates`)

1. SSH to the Aleph VM:
   `ssh root@ophis-rebates.aleph.cloud`

2. Install cloudflared (if not already present):
   `curl -L -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared`

3. Authenticate against the existing `3615crypto` tunnel:
   `cloudflared tunnel login`        # opens browser, pick 3615crypto

4. Add a public hostname route via Cloudflare API:
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/4761b41ef352631db0ed367fea98ffdc/cfd_tunnel/<TUNNEL_ID>/configurations" \
     -H "Authorization: Bearer $CF_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "config": { "ingress": [
       { "hostname": "rebates.ophis.fi", "service": "http://localhost:80" },
       { "service": "http_status:404" }
     ] } }'
   ```

5. Add a proxied CNAME `rebates.ophis.fi → <TUNNEL_ID>.cfargotunnel.com`:
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/zones/<OPHIS_FI_ZONE_ID>/dns_records" \
     -H "Authorization: Bearer $CF_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"type":"CNAME","name":"rebates","content":"<TUNNEL_ID>.cfargotunnel.com","proxied":true,"ttl":1}'
   ```

6. Verify:
   `curl -fsS https://rebates.ophis.fi/health | jq`
   Expected: `{ "ok": true, ... }`

## Rotation / teardown
- Remove the ingress entry by editing the tunnel configuration JSON.
- Delete the DNS CNAME.
- The Aleph VM and its docker stack are unaffected.
