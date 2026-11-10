import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Tests run inside the Workers runtime with a local D1. They call the Worker's handler directly, so
// they need no build and no wrangler.jsonc: the bindings are declared here.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-10-21',
        d1Databases: ['DB'],
        bindings: { MIGRATIONS: await readD1Migrations(new URL('./migrations', import.meta.url).pathname) },
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'] },
}))
