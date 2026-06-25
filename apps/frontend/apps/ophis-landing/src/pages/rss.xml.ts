import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'

// Hand-rolled RSS 2.0 feed — dependency-free (no @astrojs/rss). Prerendered to
// dist/rss.xml at build time. Linked site-wide from Base.astro.

const SITE = 'https://ophis.fi'

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const GET: APIRoute = async () => {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  )

  const items = posts
    .map(
      (p) => `    <item>
      <title>${esc(p.data.title)}</title>
      <link>${SITE}/blog/${p.id}/</link>
      <guid isPermaLink="true">${SITE}/blog/${p.id}/</guid>
      <description>${esc(p.data.description)}</description>
      <pubDate>${p.data.pubDate.toUTCString()}</pubDate>
    </item>`,
    )
    .join('\n')

  // Deterministic (no Date.now): newest post change time, so rebuilds are stable.
  const lastBuild = posts.length
    ? new Date(
        Math.max(...posts.map((p) => (p.data.updatedDate ?? p.data.pubDate).getTime())),
      ).toUTCString()
    : new Date(0).toUTCString()

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ophis Blog</title>
    <link>${SITE}/blog/</link>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml" />
    <description>Intent-based, MEV-protected swaps for the agent era. AI agents, rebates, and multi-chain DeFi.</description>
    <language>en</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>
`

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}
