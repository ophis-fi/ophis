const { createRequire } = require('node:module')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const app = createRequire(resolve(__dirname, '../apps/cowswap-frontend/package.json'))
const { build } = createRequire(app.resolve('vite/package.json'))('esbuild')
const macros = createRequire(require.resolve('vite-plugin-babel-macros'))
const { transformSync } = macros('@babel/core')

// Compile the same metadata macros as Vite when running the on-chain services in Node.
module.exports = (options) => build({
  ...options,
  plugins: [{
    name: 'metadata-macros',
    setup(builder) {
      builder.onLoad({ filter: /\.[jt]sx?$/ }, ({ path }) => {
        const source = readFileSync(path, 'utf8')
        if (!/from ['"](?:@lingui\/(?:core|react)\/macro|ms\.macro)['"]/.test(source)) return
        const { code } = transformSync(source, {
          filename: path, babelrc: false, configFile: false,
          parserOpts: { plugins: ['typescript', 'jsx'] },
          plugins: [require.resolve('@lingui/babel-plugin-lingui-macro'), macros.resolve('babel-plugin-macros')],
        })
        return { contents: code, loader: path.endsWith('x') ? 'tsx' : 'ts' }
      })
    },
  }],
})
