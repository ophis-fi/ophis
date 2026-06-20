import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// --- ethers v5 / v6 coexistence -------------------------------------------------------------
// The @cowprotocol stack pinned by this app (cow-sdk@5, app-data@2, and transitively
// @cowprotocol/contracts@1.8.0) was written against ethers v5: it imports the v5-only
// top-level API (`ethers`, `utils`, `BigNumber`, `constants`, …) from the bare `ethers`
// specifier and helpers from the `ethers/lib/utils` deep path. The app's own code uses
// ethers v6 (`Interface`, `keccak256`, `toUtf8Bytes`), whose flat API has neither those
// named exports nor a `./lib/utils` subpath, so a single global ethers version cannot satisfy
// both and the production bundle fails to resolve.
//
// Fix: keep ethers v6 as the app's ethers, install a genuine ethers v5 side-by-side
// (npm-aliased as `ethers-v5`), and rewrite `ethers` / `ethers/lib/utils` to `ethers-v5`
// ONLY for modules that live inside a @cowprotocol package. The app's own imports are never
// rewritten, so app code stays on v6 while the CoW libraries get the v5 they were built for.
// This is bundler-time resolution only; runtime semantics are each library's intended ethers.
function cowEthersV5(): Plugin {
  const isCowImporter = (importer?: string) =>
    !!importer && importer.includes('@cowprotocol');
  return {
    name: 'ophis-cow-ethers-v5',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!isCowImporter(importer)) return null;
      let redirected: string | null = null;
      if (source === 'ethers') redirected = 'ethers-v5';
      else if (source === 'ethers/lib/utils') redirected = 'ethers-v5/lib/utils';
      else if (source.startsWith('ethers/lib/'))
        redirected = source.replace(/^ethers\//, 'ethers-v5/');
      if (!redirected) return null;
      // Resolve the redirected specifier with this plugin skipped to avoid recursion.
      const resolved = await this.resolve(redirected, importer, { skipSelf: true });
      return resolved?.id ?? redirected;
    },
  };
}

// Safe Apps are plain static SPAs loaded in an iframe by app.safe.global.
// base must be '/', and manifest.json + assets are served from the app root.
export default defineConfig({
  plugins: [cowEthersV5(), react()],
  base: '/',
  resolve: {
    alias: [
      // @cowprotocol/app-data (and cow-sdk through it) target multiformats v9 subpaths like
      // `multiformats/cid`, but the hoisted multiformats is v14 whose reorganised `exports`
      // map doesn't expose those specifiers, so the bundler errors ("No known conditions for
      // './cid'"). Redirect every multiformats specifier to a side-installed genuine v9
      // (npm-aliased as `multiformats-v9`). The app does not import multiformats directly, so
      // a global redirect is safe. Subpath rule MUST precede the bare-package rule.
      { find: /^multiformats\/(.*)$/, replacement: 'multiformats-v9/$1' },
      { find: /^multiformats$/, replacement: 'multiformats-v9' },
    ],
  },
  build: { outDir: 'dist', sourcemap: false },
  server: { cors: true, port: 5273 },
});
