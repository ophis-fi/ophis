// The maker of the OFAC address list the console reads (M10). It turns the official SDN.XML into one small JSON file:
// the wallet addresses in it, the day it was published, the time it was made and the SHA-256 of the XML. It runs where the owner decides
// (README): the console only ever reads the file it writes, never OFAC's site.
//   node scripts/ofac-list.mjs [--from <SDN.XML file>] --out <file.json>
// Without --from it downloads the file from OFAC's Sanctions List Service (redirects followed, 120 s, 100 MB at most).
// It refuses, exit 1, and writes nothing: no <sdnList, a file that does not end with </sdnList> (a cut download), no
// publish date or more than one, a Record_Count that is not the number of <sdnEntry>, no address.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML'
/** The one address rule, shared with "operator addresses": every 0x followed by exactly 40 hex characters, in lower case, each once, in the order of the text. */
export const addressesIn = (text) => [...new Set((text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).map((address) => address.toLowerCase()))]

/** The day an SDN.XML was published, YYYY-MM-DD, or null: <Publish_Date>MM/DD/YYYY</Publish_Date>. "operator addresses" sends it with a manual load. */
export function publishedIn(text) {
  const [, month, day, year] = /<Publish_Date>(\d{2})\/(\d{2})\/(\d{4})<\/Publish_Date>/.exec(text) ?? []
  return year ? `${year}-${month}-${day}` : null
}

/** The list as the console reads it, from the bytes of an SDN.XML. `made`: now, UTC, to the second (the console warns when it is 3 days old). Throws, with the reason, for a file that is not whole. */
export function build(bytes, source) {
  const text = bytes.toString('latin1')
  const refuse = (why) => {
    throw new Error(why)
  }
  if (!text.includes('<sdnList')) refuse('no <sdnList: this is not the SDN list')
  if (!text.trimEnd().endsWith('</sdnList>')) refuse('the file does not end with </sdnList>: a cut download')
  if ((text.match(/<Publish_Date>/g) ?? []).length > 1) refuse('more than one publish date')
  const published = publishedIn(text) ?? refuse('no publish date')
  const [records, entries] = [Number(/<Record_Count>(\d+)<\/Record_Count>/.exec(text)?.[1]), text.split('<sdnEntry>').length - 1]
  if (records !== entries) refuse(`Record_Count says ${records}, and the file holds ${entries} entries`)
  const addresses = addressesIn(text).sort()
  if (!addresses.length) refuse('no address')
  return { list: 'ofac', source, published, made: `${new Date().toISOString().slice(0, 19)}Z`, sha256: createHash('sha256').update(bytes).digest('hex'), count: addresses.length, addresses }
}

async function download() {
  const response = await fetch(SDN_URL, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`the download answered ${response.status}`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    if ((size += chunk.length) > 100_000_000) throw new Error('the download is over 100 MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' } } })
  if (!values.out) {
    console.error('usage: node scripts/ofac-list.mjs [--from <SDN.XML file>] --out <file.json>')
    process.exit(1)
  }
  try {
    const list = build(values.from ? readFileSync(values.from) : await download(), values.from ? basename(values.from) : SDN_URL)
    writeFileSync(values.out, `${JSON.stringify(list, null, 1)}\n`)
    console.log(`Written: ${values.out}. ${list.count} addresses, published ${list.published}, made ${list.made}, SHA-256 of the source ${list.sha256}.`)
  } catch (error) {
    console.error(`Refused: ${error.message}. Nothing was written.`)
    process.exit(1)
  }
}
