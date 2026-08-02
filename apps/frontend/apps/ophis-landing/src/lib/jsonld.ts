// JSON.stringify does NOT escape `<`, so content containing a literal
// `</script>` (e.g. inside a code span, which renders as an entity and is
// decoded back by htmlToText) would terminate an ld+json block early and
// inject live markup into <head>. Reproduced before this guard existed.
// U+2028/2029 are valid in JSON strings but break JS parsers.
export const jsonLdSafe = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
