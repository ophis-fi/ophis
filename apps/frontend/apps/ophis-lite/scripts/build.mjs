import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { buildArtifact, serializeManifest } from './build-lib.mjs'

const sourcePath = fileURLToPath(new URL('../src/index.html', import.meta.url))
const outputDirectory = fileURLToPath(new URL('../dist/', import.meta.url))
const allowedOutputs = new Set(['index.html', 'manifest.json'])

await mkdir(outputDirectory, { recursive: true })
const existingOutputs = await readdir(outputDirectory)
const unexpectedOutputs = existingOutputs.filter((entry) => !allowedOutputs.has(entry))
if (unexpectedOutputs.length > 0) {
  throw new Error(`refusing to overwrite unexpected build outputs: ${unexpectedOutputs.join(', ')}`)
}

const artifact = buildArtifact(await readFile(sourcePath))
await writeFile(new URL('../dist/index.html', import.meta.url), artifact.html)
await writeFile(new URL('../dist/manifest.json', import.meta.url), serializeManifest(artifact.manifest))

process.stdout.write(
  `${JSON.stringify({ byteLength: artifact.manifest.byteLength, keccak256: artifact.manifest.keccak256 })}\n`,
)
