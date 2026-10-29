import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['extension/**/*.js', '{scripts,tests}/**/*.{js,cjs,mjs}', 'eslint.config.mjs'],
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { chrome: 'readonly', module: 'readonly', require: 'readonly' },
    },
  },
  {
    files: ['extension/**/*.js'],
    ignores: ['extension/background.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['extension/background.js'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  {
    files: ['extension/translation-diagnostics.js'],
    languageOptions: { globals: { Buffer: 'readonly' } },
  },
  {
    files: ['{scripts,tests}/**/*.{js,cjs}'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['{scripts,tests}/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.nodeBuiltin },
  },
  {
    files: ['tests/integration/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    files: ['tests/integration/{data-as-paragraph,github-skill-page,heading-permalink,inline-button}.test.mjs'],
    languageOptions: { globals: {
      captureDomTree: 'readonly',
      createViewportProbe: 'readonly',
      ChromeAiTranslatorInlineTranslationSession: 'readonly',
      ChromeAiTranslatorInlineBlock: 'readonly',
    } },
  },
  {
    files: ['tests/integration/model-quality-observation.mjs'],
    languageOptions: { globals: { pickArticleRoot: 'readonly', buildArticleExtraction: 'writable' } },
  },
];
