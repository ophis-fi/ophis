import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const native = join(root, 'apps/solana');
const sources = JSON.parse(readFileSync(join(native, 'sources.json'), 'utf8'));
const deployment = JSON.parse(readFileSync(join(native, 'deployment.local.json'), 'utf8'));
const source = join(native, 'upstream/programs/programs/settlement/idl/client/js/src');
const destination = join(root, 'packages/solana-sdk/src/settlement');
const idl = JSON.parse(readFileSync(join(source, 'generated/idl.json'), 'utf8'));
if (idl.address !== deployment.programId) throw new Error('Prepare Ophis bindings before syncing');
for (const name of ['generated', 'hooked.ts', 'order.ts'])
  cpSync(join(source, name), join(destination, name), { recursive: true });
function extensions(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) extensions(path);
    else if (extname(path) === '.ts') {
      const text = readFileSync(path, 'utf8').replace(
        /(from\s+["'])(\.[^"']+)(["'])/g,
        (_, before, specifier, after) => {
          if (extname(specifier)) return before + specifier + after;
          const target = resolve(dirname(path), specifier);
          return before + specifier + (existsSync(target + '.ts') ? '.js' : '/index.js') + after;
        },
      );
      writeFileSync(path, text);
    }
  }
}
extensions(destination);
writeFileSync(
  join(root, 'packages/solana-sdk/SOURCE.md'),
  `Low-level bindings are generated from cowprotocol/solana-programs ${sources.programs.commit} (${sources.programs.release}), prepared with the Ophis identities in apps/solana/deployment.local.json. Interface/client source declares MIT OR Apache-2.0. Generated notices are retained. Relative imports receive ESM file extensions. Runtime dependencies are Solana Kit and its program clients; no CoW Trading SDK or hosted CoW endpoint is used. High-level builders require an explicit deployment address.\n`,
);
