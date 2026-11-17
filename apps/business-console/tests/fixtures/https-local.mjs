// Test only (tests/e2e.mjs). Loaded with "node --import", it points node:https at the local listener of E2E_PORT, in plain
// http, with the request otherwise unchanged: the operator's command with --production is heard on this machine and
// nothing leaves it. Only the one destination the command must use is taken, given as the command gives it (host, port,
// method, path, headers): any other host, port or option (hostname, socketPath, agent, a URL...) fails the request, so a
// wrong destination can neither hide behind the redirect nor leave this machine. The command itself has no switch for this.
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const TAKEN = ['host', 'port', 'method', 'path', 'headers']
https.request = (options, callback) => {
  const { host, port, method, path, headers } = options ?? {}
  if (typeof options !== 'object' || Object.keys(options).some((key) => !TAKEN.includes(key)) || host !== 'operator.ophis.fi' || port !== 443) {
    throw new Error("https-local: not the operator's address, or an option this fixture does not take")
  }
  // agent false: a fresh agent of its own, never the global one, which NODE_USE_ENV_PROXY would send through a proxy (Codex).
  return http.request({ host: '127.0.0.1', port: Number(process.env.E2E_PORT), method, path, headers, agent: false }, callback)
}
syncBuiltinESMExports() // the command's "import { request } from 'node:https'" then sees this one
