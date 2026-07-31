// Ophis - fail-closed parser for the skill-file YAML frontmatter subset.
//
// Why not a regex: independently matching `openclaw:` and `policy:` lines
// passes even when the policy block has been moved to a wrong frontmatter
// path (e.g. metadata.policy), while policy-enforcing agent runtimes resolve
// the EXACT path metadata.openclaw.web3.policy and would silently find
// nothing. The gates must resolve the same exact path, so they need the
// frontmatter as a nested object tree.
//
// Why not js-yaml: the gates that need this (check-agent-skills-invariant.mjs,
// package-agent-skills.mjs) run in installless CI lanes (security.yml and both
// agent-skills-ci.yml lanes are checkout + node + script, "pure-Node check
// (no deps)" by documented design), where nothing under node_modules exists.
//
// So: a deliberate, fail-closed parser for the restricted YAML the skill
// frontmatter actually uses. Supported constructs:
//   - nested mappings by 2..n-space indentation, plain keys (`policy:`, `10:`)
//   - scalar values: double-quoted strings, plain strings, integers, booleans
//   - flow sequences on one line (`networks: [10, 130]`)
//   - block sequences of scalar items (`- curl`, `- "0x..." # comment`)
//   - full-line comments; trailing comments after quoted scalars and flow
//     sequences (never stripped from plain scalars, which may contain `#`)
// ANYTHING else (tabs, anchors, aliases, multiline scalars, flow mappings,
// unclassifiable lines) throws, so an exotic construct can never be silently
// misread as "policy absent" or "policy present": the gate errors and a human
// extends this parser deliberately.
//
// Pure Node, no deps.

/** Parse one scalar token. Throws on unsupported constructs. */
function parseScalar(raw, where) {
  const s = raw.trim();
  if (s === '') return null;
  if (/^[&*|>{]/.test(s)) {
    throw new Error(`${where}: unsupported YAML construct in "${s}" (anchor/alias/multiline/flow-mapping); extend scripts/lib/frontmatter.mjs deliberately if the frontmatter needs it`);
  }
  if (s.startsWith('"')) {
    const close = s.indexOf('"', 1);
    if (close === -1) throw new Error(`${where}: unterminated double-quoted scalar: ${s}`);
    const rest = s.slice(close + 1).trim();
    if (rest !== '' && !rest.startsWith('#')) {
      throw new Error(`${where}: trailing content after quoted scalar: ${s}`);
    }
    return s.slice(1, close);
  }
  if (s.startsWith('[')) {
    const close = s.lastIndexOf(']');
    if (close === -1) throw new Error(`${where}: unterminated flow sequence: ${s}`);
    const rest = s.slice(close + 1).trim();
    if (rest !== '' && !rest.startsWith('#')) {
      throw new Error(`${where}: trailing content after flow sequence: ${s}`);
    }
    const inner = s.slice(1, close).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => parseScalar(item, where));
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s; // plain scalar, kept verbatim (may contain ':' or '#')
}

/**
 * Parse the leading `---` YAML frontmatter of a skill markdown file into a
 * nested object tree. Throws (never guesses) on anything outside the
 * supported subset.
 */
export function parseSkillFrontmatter(markdown, name = 'frontmatter') {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (fm === undefined) throw new Error(`${name}: missing YAML frontmatter`);

  // Materialize the content lines with their indentation, rejecting tabs.
  const lines = [];
  fm.split('\n').forEach((raw, idx) => {
    if (raw.trim() === '' || raw.trim().startsWith('#')) return;
    if (/^\s*\t/.test(raw)) throw new Error(`${name}:${idx + 1}: tab indentation is not supported`);
    lines.push({ n: idx + 1, indent: raw.search(/\S/), text: raw.trim() });
  });

  /** Parse the block starting at lines[i], all at exactly `indent`. */
  function parseBlock(i, indent) {
    const isSeq = lines[i].text.startsWith('- ') || lines[i].text === '-';
    const value = isSeq ? [] : {};
    while (i < lines.length && lines[i].indent === indent) {
      const { n, text } = lines[i];
      const where = `${name}:${n}`;
      if (isSeq !== (text.startsWith('- ') || text === '-')) {
        throw new Error(`${where}: mixed mapping and sequence entries at one indentation level`);
      }
      if (isSeq) {
        value.push(parseScalar(text.slice(1), where));
        i += 1;
        continue;
      }
      const m = text.match(/^([A-Za-z0-9_.@-]+):(?:\s+(.*))?$/);
      if (!m) throw new Error(`${where}: unclassifiable line: ${text}`);
      const [, key, rest] = m;
      if (key in value) throw new Error(`${where}: duplicate key ${key}`);
      i += 1;
      if (rest !== undefined && rest.trim() !== '') {
        value[key] = parseScalar(rest, where);
        continue;
      }
      // No inline value: a nested block (or an empty value).
      if (i < lines.length && lines[i].indent > indent) {
        const child = parseBlock(i, lines[i].indent);
        value[key] = child.value;
        i = child.next;
      } else {
        value[key] = null;
      }
    }
    if (i < lines.length && lines[i].indent > indent) {
      throw new Error(`${name}:${lines[i].n}: inconsistent indentation`);
    }
    return { value, next: i };
  }

  if (lines.length === 0) return {};
  if (lines[0].indent !== 0) throw new Error(`${name}: first frontmatter line must not be indented`);
  const { value, next } = parseBlock(0, 0);
  if (next !== lines.length) {
    throw new Error(`${name}:${lines[next].n}: unreachable trailing content (indentation error)`);
  }
  return value;
}
