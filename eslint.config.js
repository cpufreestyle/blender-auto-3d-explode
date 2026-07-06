export default [
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      env: {
        browser: true,
        es2022: true,
        node: true
      }
    },
    ignores: [
      'node_modules/**',
      'dist/**',
      'vendor/**',
      'blender_output/**'
    ]
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      parserOptions: {
        sourceType: 'module'
      }
    },
    rules: {
      'indent': ['error', 2, { 'SwitchCase': 1 }],
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'double'],
      'semi': ['error', 'always'],
      'no-console': 'warn',
      'no-unused-vars': 'warn',
      'no-undef': 'error',
      'eol-last': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'no-trailing-spaces': 'error',
      'space-before-function-paren': ['error', 'never'],
      'object-curly-spacing': ['error', 'always'],
      'array-bracket-spacing': ['error', 'never'],
      'computed-property-spacing': ['error', 'never'],
      'space-in-parens': ['error', 'never'],
      'keyword-spacing': ['error', { 'before': true, 'after': true }],
      'space-infix-ops': 'error',
      'operator-linebreak': ['error', 'after'],
      'newline-per-chained-call': ['error', { 'ignoreChainWithDepth': 3 }],
      'max-len': ['warn', { 'code': 120, 'ignoreComments': true }]
    }
  }
];