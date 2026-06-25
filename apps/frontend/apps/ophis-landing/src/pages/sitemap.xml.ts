import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'

// Dynamic sitemap. Prerendered to dist/sitemap.xml at build time (output:'static'),
// so it stays a plain static file at https://ophis.fi/sitemap.xml — but blog posts
// are picked up automatically, so a new post never needs a manual sitemap edit.
// Replaces the former hand-maintained public/sitemap.xml. robots.txt still points
// at /sitemap.xml.

const SITE = 'https://ophis.fi'

export const GET: APIRoute = async () => {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  )

  const urls = [
    { loc: `${SITE}/`, changefreq: 'weekly', priority: '1.0' },
    { loc: `${SITE}/blog/`, changefreq: 'weekly', priority: '0.8' },
    ...posts.map((p) => ({
      // Trailing slash to match the 200 URL CF Pages serves (no-slash 308s).
      loc: `${SITE}/blog/${p.id}/`,
      lastmod: (p.data.updatedDate ?? p.data.pubDate).toISOString().slice(0, 10),
      changefreq: 'monthly',
      priority: '0.7',
    })),
  ]

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `  <url>\n    <loc>${u.loc}</loc>\n${
        'lastmod' in u && u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : ''
      }    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`,
  )
  .join('\n')}
</urlset>
`

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}
