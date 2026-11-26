import { nameKeys, shardOf, type ListHashes, type ListedName, type NameReport } from '../shared/sanctions-names.ts'
import { sha256Hex } from './data.ts'

export async function checkNames(assets: Fetcher | undefined, subjects: string[], signatory: string | null, now: number): Promise<NameReport> {
  const names = [...new Set([...subjects, ...(signatory ? [signatory] : [])])]
  const matches: NameReport['matches'] = []
  let lists: ListHashes | null = null, updatedAt: number | null = null
  let problem = ''
  async function file(path: string) {
    if (!assets) throw new Error('missing assets')
    const response = await assets.fetch(new Request(`https://pro.ophis.fi/sanctions-names/${path}.json`))
    if (!response.ok) throw new Error('missing index')
    return response.json()
  }
  try {
    const feed = await file('manifest') as { schema: number; updatedAt: number; lists: ListHashes }
    if (feed.schema !== 1 || !Number.isSafeInteger(feed.updatedAt) || !['eu', 'un', 'ofac'].every(code => /^[0-9a-f]{64}$/.test(feed.lists[code]))) throw new Error('invalid manifest')
    lists = feed.lists
    updatedAt = feed.updatedAt
    if (updatedAt > now || now - updatedAt > 48 * 60 * 60 * 1000) {
      problem = 'The lists need a fresh download.'
    } else {
      const keys = names.map(nameKeys)
      const shards = new Map<string, Record<string, ListedName[]>>()
      for (const shard of new Set(keys.flat().map(shardOf))) {
        const data = await file(shard)
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid shard')
        shards.set(shard, data as Record<string, ListedName[]>)
      }
      names.forEach((subject, i) => {
        const entries = new Map<string, ListedName>()
        for (const key of keys[i]) {
          const data = shards.get(shardOf(key))!
          if (Object.hasOwn(data, key)) for (const row of data[key]) entries.set(JSON.stringify(row), row)
        }
        if (entries.size) matches.push({ subject, entries: [...entries.values()] })
      })
      if (keys.some(key => !key.length) || !subjects.length) problem = 'A registered name could not be checked.'
      else if (!signatory) problem = 'Enter the name on the signed declaration.'
    }
  } catch {
    problem = 'The sanctions lists could not be checked.'
  }
  const revision = await sha256Hex(JSON.stringify([names, signatory, lists, matches, problem]))
  return { names, signatory, lists, updatedAt, checkedAt: now, matches, status: problem ? 'incomplete' : matches.length ? 'review' : 'clear', problem: problem || null, revision }
}

export async function applicationNames(db: D1Database, assets: Fetcher | undefined, orgId: string, signer: string | null, now: number) {
  const row = await db.prepare(`SELECT o.name, json_extract(o.registration_screening, '$.signatory') AS signer,
    (SELECT s.display_name FROM audit_log a JOIN seats s ON s.id = a.actor_id AND s.org_id = a.org_id
       WHERE a.org_id = o.id AND a.seq = 1 AND a.action IN ('organisation.apply', 'organisation.apply_unproved')) AS owner,
    (SELECT json_group_array(display_name ORDER BY rowid) FROM application_people WHERE org_id = o.id) AS people
    FROM organisations o WHERE o.id = ? AND o.state = 'unverified'`).bind(orgId)
    .first<{ name: string; signer: string | null; owner: string | null; people: string }>()
  const names = row ? [row.name, row.owner ?? '', ...JSON.parse(row.people) as string[]] : []
  if (row?.signer && signer && row.signer !== signer) names.push(row.signer)
  return checkNames(assets, names, signer ?? row?.signer ?? null, now)
}
