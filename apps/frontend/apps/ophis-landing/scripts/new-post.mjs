#!/usr/bin/env node
/**
 * Scaffold a new blog post:  pnpm new:post "My Post Title"
 *
 * Creates src/content/blog/<slug>.md with valid frontmatter (today's date,
 * draft:true so it never publishes by accident) and a starter body, then prints
 * the preview + publish commands. Removes the boilerplate + schema-error risk.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const title = process.argv.slice(2).join(' ').trim()
if (!title) {
  console.error('Usage: pnpm new:post "Your Post Title"')
  process.exit(1)
}

const slug = title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
if (!slug) {
  console.error('Could not derive a slug from that title. Use letters/numbers.')
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const dir = resolve(__dirname, '../src/content/blog')
mkdirSync(dir, { recursive: true })
const file = resolve(dir, `${slug}.md`)

const today = new Date().toISOString().slice(0, 10)
const body = `---
title: ${JSON.stringify(title)}
description: "One-line summary, used for the SEO meta and the post-card blurb."
pubDate: ${today}
author: Ophis
tags: []
draft: true
# Optional cover (drives the OG/social card + post hero + listing thumbnail).
# Drop the image next to this file, then uncomment:
# cover: ./${slug}.cover.png
# coverAlt: "What the cover image shows"
---

Write your post in Markdown. Use \`##\` / \`###\` for headings (the page already
renders the title as the h1). Code fences highlight automatically.

Images: co-locate the file and reference it relatively so it is auto-optimized:
\`![descriptive alt text](./${slug}.diagram.png)\`. Always include alt text (the
build fails without it). Do not use em-dashes in the body.
`

try {
  // 'wx' = create exclusively: fails atomically if the file already exists, with
  // no time-of-check/time-of-use race.
  writeFileSync(file, body, { flag: 'wx' })
} catch (err) {
  if (err && err.code === 'EEXIST') {
    console.error(`A post with that slug already exists: ${file}`)
    process.exit(1)
  }
  throw err
}
console.log(`\n✓ Created src/content/blog/${slug}.md (draft)\n`)
console.log('Next:')
console.log('  1. Edit the file (set draft: false when ready).')
console.log(`  2. Preview locally:  pnpm dev   ->  http://localhost:4321/blog/${slug}`)
console.log(`  3. Publish:          git add -A && git commit -m "blog: ${title}" && git push`)
console.log('     (pushing to main auto-deploys to ophis.fi/blog in ~3 min)\n')
