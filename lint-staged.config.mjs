const config = {
  '*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}': ['oxfmt --no-error-on-unmatched-pattern', 'eslint --fix'],
  '*.{json,jsonc,json5,md,toml,yaml,yml}': ['oxfmt --no-error-on-unmatched-pattern'],
  '*.{md,mdc}': ['markdownlint-cli2 --fix --no-globs'],
  '*.sh': [() => './dev/lint.sh -f'],
};

export default config;
