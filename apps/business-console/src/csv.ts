/** Every cell is quoted. One that a spreadsheet would run as a formula (it starts with = + - @, a tab or a return) gets an apostrophe in front. */
export const csvCell = (value: unknown) => {
  const text = String(value ?? '')
  return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`
}
