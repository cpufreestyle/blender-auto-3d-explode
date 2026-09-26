// 前端块与测试块共用的规则。
// 两块只差两处，因此这两条必须留在各自的 files 块里覆盖，不能进这里：
//   - no-console：前端是 warn（浏览器里的 console 是留给用户看的状态输出，
//     带 emoji 的加载提示），测试是 off（断言本身就要往 stdout 打东西）；
//   - no-use-before-define：只有前端块要，防 lowPowerMode 那类「先用后声明」
//     的 TDZ 崩溃。
// 提出来是为了让「两块共用同一条规则」这件事只有一处定义：以前改一处漏一处
// 不会有任何提示，而两块的口径本该一致。
const baseRules = {
  'indent': ['error', 2, { 'SwitchCase': 1 }],
  'linebreak-style': ['error', 'unix'],
  'quotes': ['error', 'double'],
  'semi': ['error', 'always'],
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
};

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
      'src/ar-preview.js',
      'src/assembly-analysis.js',
      'src/camera-fit.js',
      'src/gltf-loader.js',
      'src/lighting.js',
      'src/custom-model-finalize.js',
      'src/custom-model-loader.js',
      'src/custom-model-panel.js',
      'src/geometry-split.js',
      'src/model-disposal.js',
      'src/model-fit.js',
      'src/model-style.js',
      'src/status-ui.js',
      'src/style-toggle.js',
      'src/theme-toggle.js',
      'src/generated-library.js',
      'src/keyboard-shortcuts.js',
      'src/step-desc.js',
      'src/scene-setup.js',
      'src/explode-controller.js',
      'src/export-panel.js',
      'src/upload-panel.js',
      'src/quest3-data.js',
      'src/quest3-model.js',
      'src/quest3-steps.js',
      'src/panels/image-features.js',
      'src/panels/config-check.js',
      'src/panels/image-validate.js',
      'src/panels/glb-request.js',
      'src/panels/prompt-icon.js',
      'src/panels/ai-paint-panel.js',
      'src/panels/config-panel.js',
      'src/render-loop.js',
      'src/config.js',
      'src/explode-geometry.js',
      'src/lego-materials.js',
      'src/model-loaders.js',
      'src/quest3-parts.js',
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
        // 文件导出（截图 / 教案导出用）
        Blob: 'readonly',
        // Node.js 兼容（utils.js 可在 Node.js 中运行）
        Buffer: 'readonly',
        process: 'readonly',
        // Three.js（vendor 全局）
        THREE: 'readonly'
      }
    },
    rules: {
      ...baseRules,
      // 前端的 console 是给用户看的状态输出，与仓库既有 38 条同类 warning 同性质
      'no-console': 'warn',
      // 防止 lowPowerMode 那类「先用后声明」的 TDZ 崩溃再次出现（函数声明仍允许提升）
      'no-use-before-define': ['error', { functions: false, classes: true, variables: true }]
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
        Blob: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        performance: 'readonly',
        globalThis: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FormData: 'readonly'
      }
    },
    rules: {
      ...baseRules,
      // 测试的 stdout 就是它的输出，no-console 必须关掉
      'no-console': 'off'
    }
  },
  // ── 服务端文件：Node.js 环境 ──────────────────────
  {
    files: [
      'server.js',
      'src/server-utils.js',
      'src/ai-config.js',
      'src/ai-call.js',
      'src/blender-mcp-client.js',
      'src/static-server.js',
      'src/proxy-detect.js',
      'src/closed-loop.js',
      'src/response-utils.js',
      'src/blender-runner.js',
      'src/routes-generate.js',
      'src/routes-blender.js',
      'src/body.js',
      'src/image-to-3d-router.js',
      'src/logger.js',
      'src/providers/image-to-3d.js',
      'src/provider-models.js',
    ],
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
