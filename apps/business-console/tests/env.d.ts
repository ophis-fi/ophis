declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    OLD: D1Database
    SEALED: R2Bucket
    MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
declare module '*?raw' {
  const text: string
  export default text
}
interface ImportMeta {
  glob(pattern: string, options?: { query: string; import: string; eager: true }): Record<string, unknown>
}
