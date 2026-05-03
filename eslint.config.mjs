import js from '@eslint/js';
import json from '@eslint/json';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettierConfigs from 'eslint-config-prettier';
import eslintPluginImport from 'eslint-plugin-import';
import eslintPluginN from 'eslint-plugin-n';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import { configs as tseslintConfigs } from 'typescript-eslint';

export default defineConfig([
  // Baseline rules
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'dot-notation': 'error',
      eqeqeq: ['error', 'allow-null'],

      'no-console': 'off',
      'no-dupe-class-members': 'off',

      'no-empty': [
        'error',
        {
          allowEmptyCatch: true,
        },
      ],

      'no-implicit-coercion': [
        'error',
        {
          string: true,
          boolean: false,
          number: false,
        },
      ],

      'no-multi-str': 'error',
      'no-use-before-define': 'error',
      'no-with': 'error',
      'object-shorthand': ['error', 'always'],
      'one-var': ['error', 'never'],

      'spaced-comment': [
        'error',
        'always',
        {
          block: {
            balanced: true,
          },
        },
      ],
    },
  },

  // TypeScript rules
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    extends: [tseslintConfigs.recommendedTypeChecked, tseslintConfigs.stylisticTypeChecked],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: false,
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },

  // Typescript rules to disable in JS files
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    extends: tseslintConfigs.recommendedTypeChecked,
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // JSON rules
  {
    files: ['**/*.json', '**/*.jsonc', '**/*.json5'],
    plugins: { json },
    language: 'json/json5',
    extends: ['json/recommended'],
  },

  // Import rules
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    extends: [eslintPluginImport.flatConfigs.recommended, eslintPluginImport.flatConfigs.typescript],
    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
      'import/internal-regex': '^@/',
    },
    rules: {
      'import/consistent-type-specifier-style': ['error', 'prefer-inline'],
      'import/enforce-node-protocol-usage': ['error', 'always'],
      'import/newline-after-import': 'error',
      'import/no-absolute-path': 'error',
      'import/no-anonymous-default-export': 'error',
      'import/no-cycle': 'error',
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
          pathGroups: [
            {
              pattern: '@/**',
              group: 'internal',
              position: 'after',
            },
          ],
          distinctGroup: false,
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // N rules
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    extends: [eslintPluginN.configs['flat/recommended-script']],
    rules: {
      'n/hashbang': 'off',
      'n/no-missing-import': 'off',
      'n/no-process-exit': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-unsupported-features/es-syntax': [
        'error',
        {
          ignores: ['modules'],
        },
      ],
      'n/no-unsupported-features/node-builtins': [
        'error',
        {
          allowExperimental: true,
        },
      ],
    },
  },

  // Vitest rules
  {
    files: ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
    plugins: {
      vitest,
    },
    rules: {
      ...vitest.configs.recommended.rules,

      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-var-requires': 'off',

      // 'node/no-missing-require': 'off',
      // 'node/no-unpublished-import': 'off',
      // 'node/no-unsupported-features/es-syntax': 'off',

      'vitest/consistent-test-it': [
        'error',
        {
          fn: 'test',
        },
      ],

      'vitest/no-standalone-expect': 'error',
      'vitest/no-conditional-expect': 'error',
      'vitest/no-conditional-in-test': 'error',
      'vitest/padding-around-after-all-blocks': 'error',
      'vitest/padding-around-after-each-blocks': 'error',
      'vitest/padding-around-before-all-blocks': 'error',
      'vitest/padding-around-before-each-blocks': 'error',
      'vitest/padding-around-all': 'error',
      'vitest/prefer-hooks-in-order': 'error',
    },
    settings: {
      vitest: {
        typecheck: true,
      },
    },
    languageOptions: {
      globals: {
        ...vitest.environments.env.globals,
      },
    },
  },
  {
    files: ['vitest.shims.d.ts'],
    rules: {
      'spaced-comment': 'off',
    },
  },

  // Prettier rules
  eslintConfigPrettierConfigs,

  // Language options
  {
    settings: {
      react: {
        version: 'detect',
      },
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
        projectService: {
          loadTypeScriptPlugins: !!process.env?.VSCODE_PID,
          defaultProject: './tsconfig.json',
          allowDefaultProject: ['*.js', '*.mjs', '*.cjs'],
        },

        tsconfigRootDir: `${import.meta.dirname}`,
      },
      globals: {
        ...globals.serviceworker,
        ...globals.browser,
        ...globals.node,
        ...globals.nodeBuiltin,
      },
    },
  },

  // Pi extensions: source files loaded by pi's own runtime (jiti) against
  // pi's globally-installed `@mariozechner/*` packages. We keep lint
  // running for syntactic / portable rules, but turn off type-aware rules
  // (they would all fail because the packages aren't installed as
  // devDependencies here) and `import/no-unresolved` for the same reason.
  // Placed after the global "Language options" block so its
  // `projectService: false` override wins.
  {
    files: ['config/pi/extensions/**/*.{ts,mts,cts,js,mjs,cjs}'],
    extends: [tseslintConfigs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: null,
      },
    },
    rules: {
      'import/no-unresolved': ['error', { ignore: ['^@mariozechner/', '^typebox$'] }],
    },
  },

  // Global ignores
  globalIgnores([
    // multiline
    '.next/**/*',
    '**/next-env.d.ts',
    'container/**/*',
    'dist/**/*',
    'src/**/*.js',
    'package-lock.json',

    'mongoshrc.js',

    '!.storybook',
    '!**/.storybook',
  ]),
]);
