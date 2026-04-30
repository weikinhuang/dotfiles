import { defineConfig } from 'vitest/config';

export default defineConfig({
  clearScreen: false,
  plugins: [],
  test: {
    coverage: {
      provider: 'v8',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
          globals: false,
          environment: 'node',
          mockReset: true,
        },
      },
    ],
  },
  resolve: {
    preserveSymlinks: true,
  },
});
