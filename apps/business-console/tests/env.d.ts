declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
declare module '*?raw' {
  const text: string
  export default text
}
