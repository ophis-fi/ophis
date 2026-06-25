/**
 * Build-time a11y guard: fail the build if a blog-post body image has no alt text.
 *
 * Markdown `![](./pic.png)` emits `<img alt="">` (empty) — almost always a forgotten
 * description, not an intentional decorative image (covers/heroes are <Image>
 * components, not markdown, so they never reach this plugin). Catching it at build
 * time keeps an undescribed image from ever shipping. Write `![what it shows](...)`.
 *
 * Dependency-free (manual HAST walk, no unist-util-visit) so it adds nothing to the
 * install. Wired in astro.config.mjs -> markdown.rehypePlugins.
 */
export default function rehypeRequireAlt() {
  return (tree, file) => {
    const walk = (node) => {
      if (node.type === 'element' && node.tagName === 'img') {
        const alt = node.properties?.alt
        if (typeof alt !== 'string' || alt.trim() === '') {
          const src = node.properties?.src ?? '(unknown src)'
          const where = file?.path ?? 'a blog post'
          throw new Error(
            `[rehype-require-alt] Image is missing alt text: "${src}" in ${where}. ` +
              'Write `![descriptive alt](...)`. (Decorative images are not expected in post bodies.)',
          )
        }
      }
      if (Array.isArray(node.children)) node.children.forEach(walk)
    }
    walk(tree)
  }
}
