import { getCollection, type CollectionEntry } from 'astro:content'

// Single source of truth for "which blog posts are live". A post is published
// when it is NOT a draft AND its pubDate has arrived. `Date.now()` is evaluated
// at BUILD time (output: 'static'), so a future-dated post stays hidden until a
// rebuild happens on/after its pubDate — that is what the daily scheduled
// rebuild in landing-deploy.yml is for. Used by the listing, the per-post static
// paths, the sitemap, and the RSS feed so all four stay in lockstep: a scheduled
// post must be absent from every surface until it is due, otherwise its URL
// 404s while still appearing in the sitemap/listing.
export const isPublished = (entry: CollectionEntry<'blog'>): boolean =>
  !entry.data.draft && entry.data.pubDate.getTime() <= Date.now()

export const getPublishedPosts = async (): Promise<CollectionEntry<'blog'>[]> =>
  (await getCollection('blog', isPublished)).sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  )
