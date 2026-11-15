// Test only (tests/e2e.mjs). Loaded with "node --import", it points node:https at the local listener of E2E_PORT, in plain
// http, with the request otherwise unchanged: the operator's command with --production is heard on this machine and
// nothing leaves it. Only the one destination the command must use is taken: any other host or port fails the request,
// so a wrong destination cannot hide behind the redirect. The command itself has no switch for this.
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

https.request = (options, callback) => {
  if (options.host !== 'operator.ophis.fi' || options.port !== 443) throw new Error(`https-local: not the operator's address: ${options.host}:${options.port}`)
  return http.request({ ...options, host: '127.0.0.1', port: Number(process.env.E2E_PORT) }, callback)
}
syncBuiltinESMExports() // the command's "import { request } from 'node:https'" then sees this one
