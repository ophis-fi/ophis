import { commissionBNB } from './commission'

process.umask(0o077)
const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--certificate' || args[2] !== '--output') {
  console.error('Use --certificate /absolute/public-certificate.pem --output /absolute/new-private-directory')
  process.exitCode = 1
} else {
  try { console.log(JSON.stringify(await commissionBNB(args[1], args[3]))) }
  catch {
    console.error('Offline BNB commissioning failed. Preserve any created output; no secret values were logged.')
    process.exitCode = 1
  }
}
