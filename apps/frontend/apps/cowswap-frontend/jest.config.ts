// this is not used for now. we use "craco test", but eventually we will

export default {
  displayName: 'cowswap',
  preset: '../../jest.preset.js',
  transform: {
    '^(?!.*\\.(mjs|js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
    '^.+\\.mjs$': [
      'babel-jest',
      {
        babelrc: false,
        configFile: false,
        presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]],
      },
    ],
    '^.+\\.[tj]sx?$': ['babel-jest', { presets: ['@nx/react/babel'] }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/cowswap',
  setupFilesAfterEnv: ['./jest.setup.ts'],
  setupFiles: ['dotenv/config'],
  transformIgnorePatterns: [
    '/node_modules/.pnpm/(?!.*(react-dnd|dnd-core|@react-dnd|fancy-canvas|jotai-tanstack-query|lightweight-charts|wagmi|@wagmi|viem|@mysten|@scure|@noble|valibot))',
    '/node_modules/(?!(\\.pnpm|react-dnd|dnd-core|@react-dnd|fancy-canvas|jotai-tanstack-query|lightweight-charts|wagmi|@wagmi|viem|@mysten|@scure|@noble|valibot))',
  ],
}
