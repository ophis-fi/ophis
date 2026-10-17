// How ophis looks in a terminal: Ophis colors, the animated claw emblem, spinners and prompts.
import { createInterface } from 'node:readline/promises'
import { formatUnits } from 'viem'

const out = process.stdout
const color = out.isTTY === true && !process.env.NO_COLOR
const motion = color && !process.env.OPHIS_NO_ANIMATION

const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
export const saffron = paint('38;2;242;166;62') // Ophis brand color #f2a63e
export const bold = paint('1')
export const dim = paint('2')
export const green = paint('32')
export const red = paint('31')

// Everything that can steer a terminal or hide in text: control codes (Cc), format characters such as
// bidi overrides and zero-width marks (Cf), line and paragraph separators, and every default-ignorable
// code point (variation selectors, fillers, tags). Unicode's own categories, so nothing is missed.
const UNSAFE_TEXT = new RegExp('[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}]', 'gu')

/**
 * Text we did not write (token symbols, server messages) loses terminal control codes and
 * text-direction overrides, so it can never repaint or reorder the confirmation screen.
 */
export const clean = (text: string) => text.replace(UNSAFE_TEXT, '')

/** A problem the user can fix. Printed as a plain sentence, without a stack trace. */
export class UserError extends Error {}

/**
 * Ends the process once what was printed has reached the terminal, file or pipe: the WalletConnect link keeps a socket
 * open, so the CLI exits by hand, and Node writes to pipes asynchronously (process.exit alone could cut them short).
 */
export const finish = (code: number): void => void process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))

// The Ophis claw (apps/frontend/apps/ophis-landing/public/ophis-claw-saffron.svg) drawn with braille dots.
const EMBLEM = [
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣆',
  '⠀⠀⠀⠀⠀⠀⠀⣀⣼⣷⢶⢿⣶⣶⠒⢦⡀',
  '⠀⠀⠀⠀⢀⣴⣻⣿⣷⢿⣿⡏⣱⣿⢟⡛⢿⣦',
  '⠀⠀⠀⣠⣟⣿⠟⠁⠀⠀⠀⠀⠘⣧⠸⣯⢦',
  '⠀⢀⣠⡿⣾⠏⠀⠀⠀⠀⠀⠀⠀⠈⠁⢹⣟⡇',
  '⠈⠉⢹⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⢿',
  '⠀⠐⠛⣷⣿⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⡿',
  '⠀⠀⠀⠘⣯⢿⣦⡀⠀⠀⠀⠀⠀⢀⣠⣟⡾⠃',
  '⠀⠀⠀⠀⠈⠻⢿⣟⡶⣶⣶⣶⡾⣟⡷⠟⠁',
  '⠀⠀⠀⠀⠀⠀⠀⠈⠙⠛⠛⠚⠋⠉',
].map((line) => line.padEnd(18, '⠀'))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Keeps a fixed pseudo-random share of each cell's dots: step 8 of 8 shows them all.
function reveal(line: string, row: number, step: number): string {
  return [...line]
    .map((cell, col) => {
      const dots = cell.charCodeAt(0) - 0x2800
      let kept = 0
      for (let bit = 0; bit < 8; bit++) {
        if (dots & (1 << bit) && (row * 31 + col * 17 + bit * 7) % 8 < step) kept |= 1 << bit
      }
      return String.fromCharCode(0x2800 + kept)
    })
    .join('')
}

/** The Ophis claw beside the wordmark. On a terminal its dots sparkle in. */
export async function banner(tagline = 'Swap on Ophis from your terminal'): Promise<void> {
  if (!out.isTTY) return // no artwork in pipes and logs
  const side = (row: number) => (row === 4 ? `    ${bold(saffron('ophis'))}` : row === 5 ? `    ${dim(tagline)}` : '')
  const frame = (step: number) => EMBLEM.map((line, row) => `  ${saffron(reveal(line, row, step))}${side(row)}`).join('\n')
  if (!motion) return void console.log(`\n${frame(8)}\n`)
  out.write('\n\x1b[?25l') // hide the cursor while drawing
  process.once('exit', () => out.write('\x1b[?25h'))
  for (let step = 1; step <= 8; step++) {
    out.write(`${frame(step)}\n`)
    await sleep(45)
    if (step < 8) out.write(`\x1b[${EMBLEM.length}A`) // back up to redraw
  }
  out.write('\x1b[?25h\n')
}

const ORBIT = '⣾⣽⣻⢿⡿⣟⣯⣷'

/** A saffron spinner with elapsed seconds. stop() replaces it with a final line. */
export function spinner(label: string) {
  const start = Date.now()
  if (!motion) {
    console.log(`  ${label}...`)
    return { stop: (line: string) => console.log(`  ${line}`) }
  }
  let frame = 0
  const draw = () => {
    const seconds = dim(`${Math.floor((Date.now() - start) / 1000)}s`)
    out.write(`\r\x1b[2K  ${saffron(ORBIT[frame++ % ORBIT.length] ?? '')} ${label} ${seconds}`)
  }
  out.write('\x1b[?25l')
  draw()
  const timer = setInterval(draw, 90)
  return {
    stop: (line: string) => {
      clearInterval(timer)
      out.write(`\r\x1b[2K  ${line}\n\x1b[?25h`)
    },
  }
}

/** Runs `work` behind a spinner and marks the line done (or failed). */
export async function step<T>(label: string, work: () => Promise<T>): Promise<T> {
  const spin = spinner(label)
  try {
    const result = await work()
    spin.stop(`${green('✓')} ${label}`)
    return result
  } catch (err) {
    spin.stop(`${red('✗')} ${label}`)
    throw err
  }
}

export const done = (line: string) => console.log(`  ${green('✓')} ${line}`)
export const note = (line: string) => console.log(`  ${saffron('!')} ${line}`)

/** Prints aligned "label  value" lines. */
export function rows(lines: [string, string][]): void {
  const width = Math.max(...lines.map(([label]) => label.length))
  for (const [label, value] of lines) console.log(`  ${dim(label.padEnd(width))}   ${value}`)
}

/** Token amount for people: thousands separators, about six significant decimals. */
export function amount(atoms: bigint, decimals: number): string {
  const [whole = '0', fraction = ''] = formatUnits(atoms, decimals).split('.')
  const zeros = whole === '0' ? (fraction.match(/^0*/)?.[0].length ?? 0) : 0
  const shown = fraction.slice(0, zeros + 6).replace(/0+$/, '')
  return `${BigInt(whole).toLocaleString('en-US')}${shown ? `.${shown}` : ''}`
}

/** Throws away keys pressed while the program was busy, so they cannot answer the next question. */
async function drain(): Promise<void> {
  const input = process.stdin
  input.setRawMode(true) // also releases a half-typed line the terminal is still holding
  input.resume() // with no 'data' listener, waiting input is read and dropped
  await new Promise((resolve) => setTimeout(resolve, 40))
  input.pause()
  input.setRawMode(false)
}

/** A yes/no question. Anything other than y or yes (including Ctrl+C) means no. */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new UserError('This needs a yes from you: run it in a terminal, or add --yes.')
  await drain()
  const rl = createInterface({ input: process.stdin, output: out })
  const stop = new AbortController()
  rl.once('SIGINT', () => stop.abort())
  try {
    return /^y(es)?$/i.test((await rl.question(`  ${question} ${dim('[y/N]')} `, { signal: stop.signal })).trim())
  } catch {
    out.write('\n')
    return false
  } finally {
    rl.close()
  }
}
