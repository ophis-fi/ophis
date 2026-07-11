import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

// Blog posts live in src/content/blog/*.md. Native Astro Markdown — Shiki code
// highlighting is built in, so there is NO @astrojs/mdx dependency to add.
// Files (or folders) prefixed with `_` are ignored, so drafts/partials can sit
// alongside published posts.
//
// IMAGES: co-locate image files next to the post and reference them RELATIVELY.
// In the post BODY, `![alt](./pic.png)` is auto-routed through Astro's Sharp
// optimizer (hashed /_assets output, intrinsic width/height, lazy-load, WebP/AVIF).
// The `cover` field below is a typed, build-validated image used as the per-post
// OG/social card, the BlogPosting schema image, the /blog listing thumbnail, and
// the post hero. Remote/hotlinked image URLs do NOT load (CSP img-src is 'self'
// only) — always import images into the repo. `coverAlt` is the cover's alt text.
const blog = defineCollection({
  // `[^_]*.md` skips underscore-prefixed FILENAMES; `!**/_*/**` also excludes
  // anything inside an underscore-prefixed FOLDER (e.g. _drafts/), so both files
  // and folders prefixed with `_` are truly ignored (matches the comment above).
  loader: glob({ pattern: ['**/[^_]*.md', '!**/_*/**'], base: './src/content/blog' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      author: z.string().default('Ophis'),
      tags: z.array(z.string()).default([]),
      // Drafts are excluded from listings, the sitemap, the RSS feed, and the
      // build's static paths. Flip to false (or remove) to publish.
      draft: z.boolean().default(false),
      // Optional cover (relative path, e.g. ./my-post.cover.png). Typed + optimized.
      cover: image().optional(),
      coverAlt: z.string().optional(),
    }),
})

export const collections = { blog }
