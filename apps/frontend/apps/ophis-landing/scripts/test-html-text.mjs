#!/usr/bin/env node
/**
 * Unit coverage for scripts/lib/html-text.mjs, the visible-text extractor that
 * FAQPage JSON-LD is built from.
 *
 * Every case below is a bug that actually shipped or was caught in review on
 * this transform. It was rewritten four times (wholesale marker strip -> single
 * underscore -> underscore runs -> parse the rendered HTML instead), and each
 * revision fixed one class while breaking another, so the regressions are
 * pinned here rather than re-argued.
 *
 * Run: node scripts/test-html-text.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText, decodeEntities, undecodedEntitiesIn } from './lib/html-text.mjs'

test('drops tags but keeps their text content', () => {
  assert.equal(htmlToText('<p>hello <em>world</em></p>'), 'hello world')
})

test('keeps snake_case identifiers in code spans intact', () => {
  // The original bug: a wholesale [*_`] strip turned this into "buildorder".
  assert.equal(htmlToText('<p>call <code>build_order</code> first</p>'), 'call build_order first')
  assert.equal(htmlToText('<code>OPHIS_STABLE_VOLUME_FEE_BPS</code>'), 'OPHIS_STABLE_VOLUME_FEE_BPS')
})

test('keeps double and triple underscore code identifiers', () => {
  // Regression from the `_{1,3}` emphasis regex, which ate these delimiters.
  assert.equal(htmlToText('<code>__init__</code> and <code>___x___</code>'), '__init__ and ___x___')
})

test('resolved emphasis carries no markers (remark already unwrapped it)', () => {
  assert.equal(htmlToText('<p><em>outer <strong>inner</strong> text</em></p>'), 'outer inner text')
  assert.equal(htmlToText('<p><strong>important</strong></p>'), 'important')
})

test('keeps link labels and discards link targets', () => {
  assert.equal(
    htmlToText('<p>see <a href="https://example.test/get_quote">endpoint</a></p>'),
    'see endpoint',
  )
})

test('does not stop at > inside a quoted attribute', () => {
  // Review finding: indexOf('>') treated the attribute's > as the tag end and
  // emitted `0">true`.
  assert.equal(htmlToText('<p><abbr title="1 > 0">true</abbr></p>'), 'true')
  assert.equal(htmlToText("<p><abbr title='a > b'>x</abbr></p>"), 'x')
  assert.equal(htmlToText('<p><span data-a="x>y" data-b=\'z>w\'>ok</span></p>'), 'ok')
})

test('block boundaries become word boundaries', () => {
  assert.equal(htmlToText('<p>one</p><p>two</p>'), 'one two')
  assert.equal(htmlToText('<li>a</li><li>b</li>'), 'a b')
})

test('skips script and style CONTENT', () => {
  assert.equal(htmlToText('<p>a</p><script>var x = 1;</script><p>b</p>'), 'a b')
  assert.equal(htmlToText('<style>.x{color:red}</style><p>b</p>'), 'b')
})

test('a stray closing tag does not swallow the rest of the document', () => {
  // A raw `</script>` in prose must not blank everything after it.
  assert.equal(htmlToText('<p>before</p></script><p>after</p>'), 'before after')
})

test('drops comments', () => {
  assert.equal(htmlToText('<p>a<!-- hidden -->b</p>'), 'ab')
})

test('decodes the entities Astro emits', () => {
  assert.equal(htmlToText('<p>a &amp; b</p>'), 'a & b')
  assert.equal(htmlToText('<p>&lt;div&gt;</p>'), '<div>')
  assert.equal(htmlToText('<p>&quot;q&quot; &#39;a&#39;</p>'), '"q" \'a\'')
  assert.equal(htmlToText('<p>&#8212; &#x2014;</p>'), '— —')
})

test('decodes named entities that appear in raw HTML blocks', () => {
  // Review finding: `<div>&copy;</div>` left a literal "&copy;" in the schema
  // while the browser rendered ©.
  assert.equal(htmlToText('<div>&copy;</div>'), '©')
  assert.equal(htmlToText('<p>&hellip; &mdash; &rsquo; &euro;</p>'), '… — ’ €')
})

test('a decoded value is not re-decoded', () => {
  // `&amp;copy;` is the text "&copy;", not "©".
  assert.equal(decodeEntities('&amp;copy;'), '&copy;')
  assert.equal(decodeEntities('&amp;amp;'), '&amp;')
})

test('undecodedEntitiesIn reports names outside the table', () => {
  assert.deepEqual(undecodedEntitiesIn('a &copy; b'), [])
  assert.deepEqual(undecodedEntitiesIn('a &thetasym; b'), ['&thetasym;'])
  // Numeric forms are always handled, so they are never reported.
  assert.deepEqual(undecodedEntitiesIn('&#169; &#xA9;'), [])
})

test('collapses whitespace and trims', () => {
  assert.equal(htmlToText('<p>  a\n\n  b  </p>'), 'a b')
})

test('unicode text passes through untouched', () => {
  // The `\w`-based emphasis regex mangled these; nothing here touches them.
  assert.equal(htmlToText('<p>café__prix__été and α__beta__γ</p>'), 'café__prix__été and α__beta__γ')
})
