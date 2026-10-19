// How ophis looks in a terminal: Ophis colors, the animated serpent emblem, spinners and prompts.
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
/** Text in a brand colour given as #rrggbb (a chain's colour, say). */
export const tint = (hex: string) => paint(`38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';')}`)

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

// The serpent ring from Ophis_logo.svg, the website's logo, drawn with braille dots.
const EMBLEM = [
  '⠀⠀⠀⠀⠀⠀⢀⣠⣤⣶⠶⣶⠿⣿⣶⣿⠛⠻⣶⣄⠀⠀',
  '⠀⠀⠀⠀⣠⢾⣟⣹⣷⣿⣿⣿⡿⠋⣹⣿⣷⣶⣿⣿⣷⣀',
  '⠀⠀⣰⣟⢻⣶⡿⠟⠛⠉⠛⠛⠃⠘⣿⣿⢁⣶⣦⡈⠛⠟',
  '⠀⣼⣯⣽⣿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠙⣿⡀⢻⣶⠿⡄⠀',
  '⣸⣿⣼⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⠀⢿⣿⢿⡄',
  '⣿⣧⣿⡏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣿⡟⣧',
  '⣿⣶⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡟⣿',
  '⢻⣶⢿⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⣻⡿',
  '⠈⢷⡾⢿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣼⣏⣿⠃',
  '⠀⠈⢻⣟⣻⣷⣄⡀⠀⠀⠀⠀⠀⠀⠀⣀⣴⣿⣯⣿⠋⠀',
  '⠀⠀⠀⠙⢿⣥⣿⢻⣷⣶⣶⣶⣶⣶⣿⣟⣻⣶⠟⠁⠀⠀',
  '⠀⠀⠀⠀⠀⠈⠙⠻⠷⣾⣯⣿⣭⣿⠶⠟⠋⠁⠀⠀⠀⠀',
].map((line) => line.padEnd(22, '⠀'))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const brightSaffron = tint('#FFD18A')
const BRAILLE_DOTS = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]]

/** Sweeps clockwise from the head at 1 o'clock: step 0 is blank, step 12 is complete. */
export function emblemFrame(step: number): string[] {
  const sweep = step / 12 * 360
  return EMBLEM.map((line, row) =>
    [...line].map((cell, col) => {
      const dots = cell.charCodeAt(0) - 0x2800
      let kept = 0
      let leading = false
      for (let bit = 0; bit < 8; bit++) {
        if (!(dots & (1 << bit))) continue
        const [dx, dy] = BRAILLE_DOTS[bit]
        const angle = (Math.atan2(row * 4 + dy - (EMBLEM.length * 2 - 0.5), col * 2 + dx - (line.length - 0.5)) * 180 / Math.PI + 60 + 360) % 360
        if (angle < sweep) {
          kept |= 1 << bit
          if (step < 12 && angle >= sweep - 25) leading = true
        }
      }
      // A terminal colours a whole braille cell, so any leading dot lights the cell.
      return (leading ? brightSaffron : saffron)(String.fromCharCode(0x2800 + kept))
    }).join(''))
}

/** The Ophis serpent beside the wordmark. On a terminal it draws itself clockwise. */
export async function banner(tagline = 'Swap on Ophis from your terminal'): Promise<void> {
  if (!out.isTTY) return // no artwork in pipes and logs
  const side = (row: number) => (row === 5 ? `    ${bold(saffron('ophis'))}` : row === 6 ? `    ${dim(tagline)}` : '')
  const frame = (step: number) => emblemFrame(step).map((line, row) => `  ${line}${side(row)}`).join('\n')
  // Redrawing rewinds a fixed number of lines: a window too narrow for the widest line (it would wrap) gets the still logo.
  const widest = 2 + EMBLEM[0]!.length + 4 + Math.max(5, tagline.length)
  if (!motion || (out.columns ?? 80) < widest) return void console.log(`\n${frame(12)}\n`)
  const restore = () => { out.write('\x1b[?25h') }
  process.once('exit', restore)
  try {
    out.write('\n\x1b[?25l') // hide the cursor while drawing
    for (let step = 0; step <= 12; step++) {
      out.write(`${frame(step)}\n`)
      if (step < 12) {
        await sleep(35)
        out.write(`\x1b[${EMBLEM.length}A`) // back up to redraw
      }
    }
  } finally {
    restore()
    process.removeListener('exit', restore)
  }
  out.write('\n')
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
  if (!process.stdin.isTTY) throw new UserError('Your approval is needed, but this session cannot ask for it. Run the command in a terminal where you can answer, or add --yes to approve it.')
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
