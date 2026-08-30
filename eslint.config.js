// Flat ESLint config. Deliberately pragmatic: this is an existing, untyped
// codebase, so the "error" rules are limited to defects that have actually
// shipped here (duplicate declarations from messy merges, dead keys, undefined
// references). Everything cosmetic is a "warn" so `npm run lint` stays green
// and CI can gate on errors only.
const globals = require('globals');

const CORRECTNESS_RULES = {
  // The rules that would have caught the window-all-closed / closeSettings /
  // sleep duplicate-definition merge artifacts.
  'no-redeclare': 'error',
  'no-func-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-const-assign': 'error',
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-self-assign': 'error',
  'no-unsafe-negation': 'error',

  // Noisy on legacy code, so warn rather than fail the build. `_` is the
  // project-wide "intentionally unused" marker — honour it for caught errors
  // too (ESLint v9 checks them by default), which is what every `catch (_)`
  // here already assumes.
  'no-unused-vars': ['warn', { args: 'none', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
  'no-empty': ['warn', { allowEmptyCatch: true }]
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'release/**',
      'runtime/**',
      'whisper-runtime/**',
      'resources/**'
    ]
  },
  // Main process, shared library code, scripts, tests: Node / CommonJS.
  {
    files: ['**/*.js', '**/*.cjs'],
    ignores: ['renderer/renderer.js', 'renderer/icons.js', 'renderer/audio-worklet-processor.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: CORRECTNESS_RULES
  },
  // Renderer: browser context. `cue` is injected by the preload contextBridge.
  {
    files: ['renderer/renderer.js', 'renderer/icons.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, cue: 'readonly' }
    },
    rules: CORRECTNESS_RULES
  },
  // AudioWorklet: its own global scope (registerProcessor, sampleRate, ...).
  {
    files: ['renderer/audio-worklet-processor.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        registerProcessor: 'readonly',
        AudioWorkletProcessor: 'readonly',
        sampleRate: 'readonly',
        currentTime: 'readonly',
        currentFrame: 'readonly'
      }
    },
    rules: CORRECTNESS_RULES
  }
];
