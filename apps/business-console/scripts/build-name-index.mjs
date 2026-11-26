// Build after Vite. Every shard is present, so a missing asset can never mean "no matches".
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { nameKeys, shardOf } from '../src/shared/sanctions-names.ts'

const result = spawnSync('python3', ['scripts/sanctions-names.py'], { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024 })
if (result.status !== 0) throw new Error(result.stderr || 'Could not download sanctions lists')
const { lists, names } = JSON.parse(result.stdout)
const shards = Array.from({ length: 128 }, () => Object.create(null))
for (const row of names) {
  for (const key of nameKeys(row[2])) (shards[shardOf(key)][key] ??= []).push(row)
}
const dir = 'dist/sanctions-names'
await mkdir(dir, { recursive: true })
await Promise.all(shards.map((shard, i) => writeFile(`${dir}/${i}.json`, JSON.stringify(shard))))
await writeFile(`${dir}/manifest.json`, JSON.stringify({ schema: 1, updatedAt: Date.now(), lists }))
console.log(`Indexed ${names.length} official names and aliases from EU, UN and OFAC.`)
