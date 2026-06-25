# Publishing to the Ophis blog

The blog is just Markdown files in git — `src/content/blog/*.md`. No CMS, no login.
A post goes live a few minutes after it lands on `main` (auto-deploy to ophis.fi/blog).

## The fast way (local)

```bash
pnpm new:post "How agents settle trades"   # scaffolds the .md with valid frontmatter (draft)
# edit src/content/blog/how-agents-settle-trades.md
pnpm dev                                    # preview at http://localhost:4321/blog/<slug>
# set draft: false, then:
git add -A && git commit -m "blog: how agents settle trades" && git push
```

Pushing to `main` auto-deploys. (Open a PR instead if you want a review first.)

## The no-tooling way (from a browser, anywhere)

Edit on GitHub directly — no local clone needed:
1. Go to `github.com/ophis-fi/ophis/new/main/apps/frontend/apps/ophis-landing/src/content/blog`
   to create a post (or open an existing `.md` and hit the pencil ✏️ to edit).
2. Paste the frontmatter + body (copy the template below), name it `<slug>.md`.
3. "Commit directly to the `main` branch" → it deploys automatically.

## Frontmatter template

```markdown
---
title: "Your title"
description: "One-line summary (SEO meta + the post-card blurb)."
pubDate: 2026-06-26
author: Ophis
tags: ["ai-agents", "mev"]
draft: false
# Optional cover -> OG/social card + post hero + listing thumbnail:
# cover: ./your-slug.cover.png
# coverAlt: "What the cover shows"
---

## A heading
Body in Markdown. `##` / `###` for headings (the title is the h1).
```

## Rules of thumb
- **The filename is the URL** (`my-post.md` → `ophis.fi/blog/my-post/`).
- **`draft: true`** hides a post everywhere (build, sitemap, RSS) until you flip it.
- **Images:** co-locate the file and use a relative path — `![alt text](./pic.png)` —
  so it is auto-optimized (WebP, sized, lazy). **Alt text is required (the build fails
  without it).** Remote/CDN image URLs are blocked by the page's security policy; commit
  the image into the repo instead.
- **Cover image:** the per-post social/OG card + hero + thumbnail. One image, three uses.
- **No em-dashes** in body text (house style).
- Reading time, dates, RSS, sitemap, canonical, and structured data are all generated
  automatically — you never touch them.
