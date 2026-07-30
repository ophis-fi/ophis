// @cowprotocol/app-data@2.5.1 ships type declarations, but its package.json "exports" map does not
// expose them for the ESM entry under the "Bundler" module resolution tsc uses here (TS7016: "There
// are types at .../dist/index.d.ts, but this result could not be resolved when respecting exports").
// We only use these two members and cast their results, so declare the minimal surface ambiently.
// (Mirrors packages/agent-swap/src/cow-app-data.d.ts.)
declare module '@cowprotocol/app-data' {
  export class MetadataApi {
    generateAppDataDoc(input: unknown): Promise<unknown>;
  }
  export function stringifyDeterministic(doc: unknown): Promise<string>;
}
