export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'vendor/**',
      'blender_output/**'
    ]
  },
  // ── 前端文件：浏览器环境 ──────────────────────────
  {
    files: [
      'main.js',
      'src/quest3-data.js',
      'src/quest3-steps.js',
      'src/utils.js'
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // 浏览器核心 API
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        URL: 'readonly',
        // 计时器
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        performance: 'readonly',
        // 网络
        fetch: 'readonly',
        XMLHttpRequest: 'readonly',
        FormData: 'readonly',
        // 存储
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        // DOM / 文件
        FileReader: 'readonly',
        DOMParser: 'readonly',
        Image: 'readonly',
        alert: 'readonly',
        // 编码
        atob: 'readonly',
        btoa: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        // Node.js 兼容（utils.js 可在 Node.js 中运行）
        Buffer: 'readonly',
        process: 'readonly',
        // Three.js（vendor 全局）
        THREE: 'readonly'
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
  // ── 测试文件：Node.js 环境 ────────────────────────
  {
    files: [
      'tests/**/*.mjs',
      'tests/**/*.js',
      'utils/**/*.js'
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly'
      }
    },
    rules: {
      'indent': ['error', 2, { 'SwitchCase': 1 }],
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'double'],
      'semi': ['error', 'always'],
      'no-console': 'off',
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
  // ── 服务端文件：Node.js 环境 ──────────────────────
  {
    files: ['server.js', 'src/server-utils.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        module: 'readonly',
        require: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'warn',
      'no-undef': 'error'
    }
  }
];
