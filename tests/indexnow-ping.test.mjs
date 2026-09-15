import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('IndexNow submits the built sitemap, deduplicates URLs and refuses off-host batches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ophis-indexnow-'))
  try {
    const mock = join(dir, 'mock.mjs')
    const sitemap = join(dir, 'sitemap.xml')
    writeFileSync(mock, `globalThis.fetch = async (_, options) => {
      console.log('PAYLOAD:' + options.body); return new Response(null, { status: 200 });
    }`)
    const run = (...args) => spawnSync(process.execPath,
      ['--import', mock, 'scripts/indexnow-ping.mjs', 'ophis.fi', ...args], { encoding: 'utf8' })
    writeFileSync(sitemap, '<urlset><url><loc>https://ophis.fi/</loc></url>' +
      '<url><loc>https://ophis.fi/migrate/odos-api/</loc></url><url><loc>https://ophis.fi/</loc></url></urlset>')
    const result = run('--sitemap', sitemap)
    assert.equal(result.status, 0)
    const payload = JSON.parse(result.stdout.split('\n').find((s) => s.startsWith('PAYLOAD:')).slice(8))
    assert.deepEqual(payload.urlList, ['https://ophis.fi/', 'https://ophis.fi/migrate/odos-api/'])
    assert.equal(payload.host, 'ophis.fi')
    for (const url of ['https://example.com/', 'https://ophis.fi/#/swap', 'http://ophis.fi/']) {
      writeFileSync(sitemap, `<urlset><url><loc>${url}</loc></url></urlset>`)
      assert.ok(!run('--sitemap', sitemap).stdout.includes('PAYLOAD:'))
    }
    assert.ok(run('https://ophis.fi/').stdout.includes('PAYLOAD:'))
    assert.ok(!run('--sitemap', join(dir, 'missing')).stdout.includes('PAYLOAD:'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
