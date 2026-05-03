const config = {
  '*.{js,ts}': ['oxfmt --no-error-on-unmatched-pattern', 'eslint'],
  '*.{json,jsonc,json5,md,toml,yaml,yml}': ['oxfmt --no-error-on-unmatched-pattern'],
  '*.sh': [() => './dev/lint.sh -f'],
};

export default config;
