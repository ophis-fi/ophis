export default {
  displayName: 'tokens',
  preset: '../../jest.preset.js',
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
    '^.+\\.[tj]sx?$': ['babel-jest', { presets: ['@nx/react/babel'] }],
  },
  transformIgnorePatterns: [
    '/node_modules/.pnpm/(?!.*(jotai-tanstack-query|wagmi|@wagmi|viem))',
    '/node_modules/(?!(\\.pnpm|jotai-tanstack-query|wagmi|@wagmi|viem))',
  ],
  setupFilesAfterEnv: ['../../jest.setup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/libs/tokens',
}
