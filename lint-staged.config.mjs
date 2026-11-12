/**
 * Lint only the staged files instead of the whole repo. Every staged file is
 * passed because extensionless scripts (dotenv/bin/git-*) and .bash completions
 * carry no `.sh` extension; dev/lint-shell.sh keeps only shell and bats files
 * and exits early when none remain.
 * @param {string[]} files
 * @returns {string}
 */
const lintShell = (files) => `./dev/lint-shell.sh -f -- ${files.map((f) => JSON.stringify(f)).join(' ')}`;

const config = {
  '*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}': [
    'oxfmt --no-error-on-unmatched-pattern',
    'oxlint --no-error-on-unmatched-pattern --fix',
  ],
  '*.{json,jsonc,json5,md,toml,yaml,yml}': ['oxfmt --no-error-on-unmatched-pattern'],
  '*.{md,mdc}': ['markdownlint-cli2 --fix --no-globs', 'oxfmt --no-error-on-unmatched-pattern'],
  '*': [lintShell],
};

export default config;
