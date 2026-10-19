import { expect, test } from 'bun:test'
import { emblemFrame } from '../src/ui.ts'

test('the serpent starts blank, draws from its head, and finishes as the website logo', () => {
  const emblem = [
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
  ]
  const frame = (step: number) => emblemFrame(step).map((line) => Bun.stripANSI(line))
  expect(frame(0)).toEqual(Array(12).fill('⠀'.repeat(22)))
  expect(frame(12)).toEqual(emblem)
  const first = frame(1)
  expect(first.join('')).toMatch(/[⠁-⣿]/)
  for (const [row, line] of first.entries()) {
    for (const [col, cell] of [...line].entries()) {
      if (cell !== '⠀') expect(row < 6 && col >= 11).toBe(true)
    }
  }
})
