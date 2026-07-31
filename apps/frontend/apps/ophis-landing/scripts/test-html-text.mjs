#!/usr/bin/env node
/**
 * Conformance suite for the two visible-text extractors that FAQPage JSON-LD
 * depends on:
 *
 *   - htmlToText   (scripts/lib/html-text.mjs)      builds the schema
 *   - visibleTextOf (scripts/check-faq-schema.mjs)  verifies the schema
 *
 * They are deliberately SEPARATE implementations, because a verifier that
 * shares code with what it verifies cannot detect a bug in it. That
 * independence is only safe if both are held to one spec, so every case below
 * runs through BOTH, and a final test asserts they agree. Independent code,
 * shared contract: drift is a test failure rather than a silent divergence.
 *
 * Every case is a bug that shipped or was raised in review on this transform,
 * which has now been rewritten five times. They are pinned here so the next
 * revision cannot quietly undo an earlier one.
 *
 * Run: node scripts/test-html-text.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText, decodeEntities } from './lib/html-text.mjs'
import { visibleTextOf } from './check-faq-schema.mjs'

/** [name, html, expected visible text] - asserted against BOTH extractors. */
const CASES = [
  ['plain tags', '<p>hello <em>world</em></p>', 'hello world'],

  // The original bug: a wholesale [*_`] strip produced "buildorder".
  ['snake_case in a code span', '<p>call <code>build_order</code></p>', 'call build_order'],
  ['screaming snake_case', '<code>OPHIS_STABLE_VOLUME_FEE_BPS</code>', 'OPHIS_STABLE_VOLUME_FEE_BPS'],
  // Regression from the `_{1,3}` emphasis regex, which ate these delimiters.
  ['dunder code identifiers', '<code>__init__</code> and <code>___x___</code>', '__init__ and ___x___'],

  ['resolved nested emphasis', '<p><em>outer <strong>inner</strong> text</em></p>', 'outer inner text'],
  ['resolved strong', '<p><strong>important</strong></p>', 'important'],

  ['link label kept, target dropped', '<p><a href="https://x.test/get_quote">endpoint</a></p>', 'endpoint'],

  // Review: indexOf('>') treated an attribute's '>' as the tag end.
  ['> inside a double-quoted attribute', '<p><abbr title="1 > 0">true</abbr></p>', 'true'],
  ['> inside a single-quoted attribute', "<p><abbr title='a > b'>x</abbr></p>", 'x'],
  // Review: split('<') fragmented the tag so quote state never balanced.
  ['< inside a quoted attribute', '<p><abbr title="1 < 2">true</abbr></p>', 'true'],
  ['mixed quoting', '<p><span data-a="x>y" data-b=\'z>w\'>ok</span></p>', 'ok'],

  ['block boundaries are word boundaries', '<p>one</p><p>two</p>', 'one two'],
  ['list items separate', '<li>a</li><li>b</li>', 'a b'],

  ['script content skipped', '<p>a</p><script>var x = 1;</script><p>b</p>', 'a b'],
  ['style content skipped', '<style>.x{color:red}</style><p>b</p>', 'b'],
  ['stray closing tag does not swallow the document', '<p>before</p></script><p>after</p>', 'before after'],

  ['comment dropped', '<p>a<!-- hidden -->b</p>', 'ab'],
  // Review: an apostrophe inside a comment was read as an attribute quote, so
  // the scanner never found the comment's '>' and dropped the rest.
  ["comment containing an apostrophe", "<p>a<!-- don't expose -->b</p>", 'ab'],
  ['comment containing markup-ish text', '<p>a<!-- <b title="x> --> b</p>', 'a b'],

  ['entities Astro emits', '<p>a &amp; b &lt;div&gt; &quot;q&quot; &#39;s&#39;</p>', 'a & b <div> "q" \'s\''],
  ['numeric references', '<p>&#8212; &#x2014; &#169;</p>', '— — ©'],
  ['named references in raw HTML', '<div>&copy; &hellip; &euro;</div>', '© … €'],
  // Review: decoding numeric then named turned "&#38;copy;" into "©", but the
  // browser does not re-parse a character a reference produced.
  ['no recursive decoding (numeric)', '<p>&#38;copy;</p>', '&copy;'],
  ['no recursive decoding (named)', '<p>&amp;copy;</p>', '&copy;'],
  ['no recursive decoding (amp amp)', '<p>&amp;amp;</p>', '&amp;'],

  ['whitespace collapsed', '<p>  a\n\n  b  </p>', 'a b'],
  // The `\w`-based emphasis regex mangled these.
  ['unicode intraword underscores', '<p>café__prix__été and α__beta__γ</p>', 'café__prix__été and α__beta__γ'],
]

for (const [name, html, expected] of CASES) {
  test(`htmlToText: ${name}`, () => assert.equal(htmlToText(html), expected))
  test(`visibleTextOf: ${name}`, () => assert.equal(visibleTextOf(html), expected))
}

test('the two extractors agree on every case', () => {
  for (const [name, html] of CASES) {
    assert.equal(htmlToText(html), visibleTextOf(html), `divergence on: ${name}`)
  }
})

test('decodeEntities is exposed and single-pass', () => {
  assert.equal(decodeEntities('&#38;copy;'), '&copy;')
  assert.equal(decodeEntities('&copy;'), '©')
})
