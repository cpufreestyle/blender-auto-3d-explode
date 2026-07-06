# 🚀 Quest 3 项目前端开发技能指南

## 🎯 项目概述

Quest 3 Exploded View 是一个基于 Three.js 的 WebXR 3D 拆解教学工具，支持：
- 🕶️ 3D 模型爆炸视图动画
- 📱 WebXR AR 预览模式
- 🤖 Blender 自动化集成
- ✨ AI 智能绘画生成
- 🎨 自定义模型上传

## 🛠️ 已部署的前端技能栈

### 核心开发工具
- **Three.js** (v0.160.0) - 3D 渲染引擎
- **WebXR** - 增强现实支持
- **OrbitControls** - 3D 相机控制器
- **ESLint** - JavaScript 代码质量检查
- **Prettier** - 代码格式化
- **StyleLint** - CSS 代码质量检查

### 构建优化工具
- **Webpack** - 模块打包器
- **Terser** - JavaScript 压缩
- **CSS Minimizer** - CSS 压缩优化
- **Compression** - GZIP 压缩
- **Bundle Analyzer** - 包体积分析

### 开发增强
- **HMR** - 热模块重载
- **Source Maps** - 调试支持
- **Code Splitting** - 代码分割
- **Tree Shaking** - 无用代码消除

## 📚 开发工作流

### 1. 代码质量检查

```bash
# JavaScript 代码检查
npm run lint

# CSS 代码检查
npm run lint:css

# 全项目代码检查
npm run lint:all
```

### 2. 代码格式化

```bash
# JavaScript 格式化
npm run format

# 全项目格式化（JS + CSS）
npm run format:all

# 修复并格式化
npm run lint:all -- --fix
```

### 3. 开发与测试

```bash
# 启动开发服务器
npm run dev

# 启动 Webpack 开发服务器（支持 HMR）
npm run serve:dev

# 启动 Node.js 服务器
npm run server

# 运行测试
npm run test
```

### 4. 构建与部署

```bash
# 开发构建
npm run build:dev

# 生产构建（优化压缩）
npm run build

# 构建包分析
npm run build:analyze

# 预览生产环境
npm run serve:prod
```

### 5. 代码验证

```bash
# 完整验证流程
npm run validate

# 安全检查
npm run audit

# 依赖升级
npm run upgrade
```

## 🧪 测试策略

### E2E 测试
```bash
npm run test
```

### 3D 场景测试
- `tests/auto-split.html` - 自动拆解测试
- `tests/quick-test.html` - 快速功能测试
- `tests/test-ar.html` - AR 模式测试
- `tests/view-model.html` - 模型查看测试

### 模型检测工具
- `tests/check-model.html` - 模型结构检查
- `tests/debug-loader.html` - GLTFLoader 调试
- `tests/clear-cache.html` - 缓存清理工具

## 🎨 样式开发规范

### CSS 命名约定
- 使用 kebab-case 命名
- BEM 风格（可选，根据团队规范）
- 语义化类名

### 主题系统
- `:root` 定义 CSS 变量
- 深色/浅色主题切换
- localStorage 持久化

### 动画性能
- 优先使用 `transform` 和 `opacity`
- 避免布局重排
- 使用 `will-change` 提示浏览器优化

## 📦 依赖管理

### 核心依赖
```json
{
  "three": "^0.160.0"  // 3D 渲染引擎
}
```

### 开发依赖
```json
{
  "webpack": "^5.108.4",
  "eslint": "^9.39.4",
  "prettier": "^3.9.4",
  "stylelint": "^17.14.0"
}
```

## 🌐 部署策略

### Vercel 部署
```json
{
  "version": 2,
  "public": true,
  "github": {
    "enabled": false
  }
}
```

### GitHub Pages 部署
1. Push 到 GitHub 仓库
2. 进入 Settings → Pages
3. 选择 `/main` 分支和 `/root` 文件夹

### 构建优化设置
- Tree Shaking
- Code Splitting
- GZIP 压缩
- Source Maps 生成

## 🔍 性能优化技巧

### 3D 渲染优化
1. **几何体优化**
   - 使用 LOD（细节层次）
   - 合并相似网格
   - 减少多边形数量

2. **材质优化**
   - 共享材质实例
   - 合理的纹理尺寸
   - 压缩纹理格式

3. **渲染优化**
   - 视锥剔除
   - 实例化渲染
   - 批处理绘制调用

### 加载优化
1. **代码分割**
   - 延迟加载
   - 动态导入
   - 路由分割

2. **资源优化**
   - 模型压缩（GLB/GLTF）
   - 纹理压缩
   - 懒加载

## 🎯 关键文件说明

### 核心文件
- `main.js` - 主要 3D 场景逻辑
- `index.html` - 页面结构和 UI 布局
- `style.css` - 样式定义

### 数据文件
- `src/quest3-data.js` - Quest 3 配置数据
- `src/quest3-steps.js` - 拆解步骤定义

### 工具文件
- `vendor/GLTFLoader.js` - 3D 模型加载器
- `vendor/OrbitControls.js` - 相机控制器
- `vendor/RoundedBoxGeometry.js` - 圆角几何体

## 🚨 常见问题解决

### Q: Three.js 模块导入失败
```javascript
// ✅ 正确（ESM 导入）
import * as THREE from './vendor/three.module.js';

// ❌ 错误（CommonJS 导入）
const THREE = require('three');
```

### Q: 浏览器兼容性
- **AR 支持**：Android Chrome 79+ / iOS Safari 15+
- **WebGL**：所有现代浏览器
- **ES Modules**：Chrome 61+ / Firefox 60+ / Safari 11+

### Q: 性能调试
```javascript
// 启用 Three.js 调试
const stats = new Stats();
document.body.appendChild(stats.dom);

function animate() {
  requestAnimationFrame(animate);
  stats.update();
  // 渲染逻辑
}
```

## 📈 监控与部署

### 构建体积监控
```bash
npm run build:analyze
# 查看 dist/stats.html
```

### 性能预算
- 入口文件 < 500KB
- 单个 chunk < 250KB
- 总资源大小 < 2MB

### 部署前检查清单
- [ ] 代码 lint 通过
- [ ] 测试用例通过
- [ ] 构建包体积合理
- [ ] 性能优化配置到位
- [ ] 环境变量配置正确

---

## 🎉 前端技能总结

通过部署这套完整的前端开发工具链，项目现在具备：

✅ **现代化的开发环境** - ESLint + Prettier + StyleLint
✅ **高效的构建系统** - Webpack + 优化插件
✅ **完整的测试覆盖** - E2E + 单元测试
✅ **优秀的代码质量** - 自动格式化 + 检查
✅ **生产级优化** - 压缩 + 分割 + 缓存
✅ **便捷的开发工具** - HMR + Source Maps
✅ **详细的文档支持** - 完整的开发指南

项目开发效率和代码质量得到显著提升！ 🚀