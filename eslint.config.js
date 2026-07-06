export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'vendor/**',
      'blender_output/**'
    ]
  },
  {
    files: [
      'main.js',
      'src/**/*.js',
      'tests/**/*.mjs',
      'tests/**/*.js',
      'utils/**/*.js'
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        document: 'readonly',
        window: 'readonly',
        THREE: 'readonly',
        console: 'readonly'
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
  },
  {
    files: ['server.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        module: 'readonly',
        require: 'readonly'
      }
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'warn',
      'no-undef': 'error'
    }
  }
];