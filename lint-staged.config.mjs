const config = {
  '*.{js,ts}': ['prettier --write', 'eslint'],
  '*.sh': ['./dev/lint.sh -f'],
};

export default config;
