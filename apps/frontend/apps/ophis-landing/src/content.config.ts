import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

// Blog posts live in src/content/blog/*.md. Native Astro Markdown — Shiki code
// highlighting is built in, so there is NO @astrojs/mdx dependency to add.
// Files (or folders) prefixed with `_` are ignored, so drafts/partials can sit
// alongside published posts.
const blog = defineCollection({
  loader: glob({ pattern: '**/[^_]*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.string().default('Ophis'),
    tags: z.array(z.string()).default([]),
    // Drafts are excluded from listings, the sitemap, the RSS feed, and the
    // build's static paths. Flip to false (or remove) to publish.
    draft: z.boolean().default(false),
  }),
})

export const collections = { blog }
