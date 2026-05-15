import { defineConfig } from 'oxfmt';

export default defineConfig({
  arrowParens: 'always',
  printWidth: 120,
  proseWrap: 'always',
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  ignorePatterns: [
    // multiline
    'lib/node/pi/research-selftest/fixtures/**',
  ],
});
