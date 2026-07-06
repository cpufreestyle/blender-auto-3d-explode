# 👨‍💻 Quest 3 项目开发者指南

## 🎯 快速开始

### 1. 环境准备

```bash
# 克隆项目
git clone <repo-url>
cd quest3-exploded

# 安装依赖
npm install
```

### 2. 开发与测试

```bash
# 启动开发服务器
npm run dev

# 启动 Blender 集成服务器
npm run server

# 代码检查与格式化
npm run format:all

# 运行测试
npm run test
```

### 3. 构建与部署

```bash
# 生产构建
npm run build

# 本地预览
npm run serve:prod

# 包分析
npm run build:analyze
```

## 🏗️ 项目架构

### 核心组件

#### 1. 3D 场景系统 (`main.js`)
```javascript
// 主要功能模块
- WebGL/WebXR 支持检测
- Three.js 场景初始化
- 相机与控制器设置
- 爆炸动画系统
- AR 模式管理
```

#### 2. 数据配置系统
```javascript
// src/quest3-data.js
- Quest 3 模型配置
- 部件颜色与材质定义
- 相对位置计算

// src/quest3-steps.js
- 拆解步骤定义
- 动画时序控制
- 工具清单管理
```

#### 3. 服务器系统 (`server.js`)
```javascript
// HTTP API 端点
- POST /api/split     // 模型拆解
- POST /api/ai-paint  // AI 绘画生成
- GET  /api/health    // 健康检查
```

#### 4. Blender 集成
```python
# Blender Python API
- blender_control.py      # Blender 控制器
- blender_api_server.py   // HTTP API 服务器
- blender_watcher.py      // 文件监听执行器
- quest3_exploded_blender.py // Quest 3 爆炸脚本
```

## 🔧 关键功能说明

### 3D 爆炸动画系统

```javascript
// 爆炸实现原理
1. 计算每个部件的中心点和归一化爆炸方向
2. 应用呼吸动画（正弦波缩放）
3. 根据爆炸深度插值位移
4. 保持部件的相对位置关系
```

### WebXR AR 模式

```javascript
// AR 检测与启动
async function startAR() {
  // 1. 检测 AR 支持
  const arSupported = await checkARSupport();

  // 2. 启动 AR 会话
  const session = await navigator.xr.requestSession('immersive-ar');

  // 3. 设置 AR 渲染循环
  session.requestAnimationFrame(onXRFrame);
}
```

### 智能相机适配

```javascript
// 计算最佳相机位置
function fitCameraToModel(modelGroup) {
  // 1. 计算包围盒
  const box = new THREE.Box3().setFromObject(modelGroup);

  // 2. 计算相机距离
  const size = box.getSize(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z) * 1.5;

  // 3. 平滑过渡
  animateCameraTo(targetPosition, targetLookAt);
}
```

## 📦 模块职责划分

### 前端模块 (`src/`, `main.js`)
- 3D 场景渲染
- 用户交互处理
- UI 状态管理
- WebXR AR 功能
- 模型加载与管理

### 数据模块 (`src/quest3-data.js`, `src/quest3-steps.js`)
- 模型配置数据
- 拆解步骤定义
- 动画参数设置
- 部件信息描述

### 服务器模块 (`server.js`)
- HTTP API 接口
- Blender 进程管理
- 文件上传处理
- 健康检查监控

### Blender 模块 (`blender_*.py`)
- 3D 模型处理
- 程序化建模
- 自动拆解算法
- 文件转换导出

## 🛠️ 开发规范

### 代码风格

#### JavaScript
- 使用 ES 模块语法 (`import`/`export`)
- 2 空格缩进
- 双引号字符串
- 分号结尾
- 驼峰命名法

```javascript
// ✅ 正确的引入方式
import * as THREE from './vendor/three.module.js';
import { quest3Specs } from './src/quest3-data.js';

// ✅ 正确的函数定义
const calculateExplodePositions = (parts) => {
  return parts.map(part => ({
    ...part,
    explodePos: calculateDirection(part)
  }));
};
```

#### CSS
- 2 空格缩进
- 双引号
- BEM 命名（可选）
- 变量优先

```css
/* ✅ 正确的样式定义 */
.ui-overlay {
  position: fixed;
  z-index: 1000;
}

.control-group {
  margin-bottom: 20px;
}

/* 主题变量 */
:root {
  --primary-color: #0066ff;
  --text-color: #333;
}
```

### Git 提交规范

```bash
# 功能提交
feat: 添加 WebXR AR 支持
feat(ui): 新增深色主题切换

# 修复提交
fix: 修复相机自适应 bug
fix(loader): 修复 GLTFLoader 导入问题

# 重构提交
refactor: 优化爆炸动画计算
refactor(ar): 重构 AR 模式管理

# 文档提交
docs: 更新开发者指南
docs(api): 补充 API 文档

# 测试提交
test: 添加 E2E 测试用例
test(explode): 补充爆炸动画测试
```

## 📁 文件组织结构

```
quest3-exploded/
├── 📂 src/                    # 前端源代码
│   ├── quest3-data.js       # Quest 3 配置文件
│   └── quest3-steps.js      # 拆解步骤定义
├── 📂 vendor/               # 第三方库文件
│   ├── three.module.js      # Three.js 核心
│   ├── GLTFLoader.js        # 模型加载器
│   └── OrbitControls.js     # 相机控制器
├── 📂 utils/                # 工具函数
│   └── BufferGeometryUtils.js
├── 📂 tests/                # 测试文件
│   ├── e2e-test.mjs         # 端到端测试
│   └── *.html               # 测试页面
├── 📂 scripts/              # Python 脚本
│   ├── blender_control.py
│   └── blender_watcher.py
├── main.js                  # 主要前端逻辑
├── server.js                # Node.js 服务器
├── index.html              # 页面结构
└── style.css               # 样式文件
```

## 🔍 调试技巧

### 浏览器控制台
```javascript
// 检查 3D 场景状态
console.log('parts.length:', parts.length);
console.log('camera.position:', camera.position);

// 检查 AR 支持
console.log('WebXR supported:', 'xr' in navigator);

// 调试模型加载
loader.load(url, (gltf) => {
  console.log('Loaded scene:', gltf.scene);
  console.log('Scene children:', gltf.scene.children.length);
});
```

### 性能分析
```javascript
// 启用 Three.js 性能统计
import Stats from 'three/addons/libs/stats.module.js';
const stats = new Stats();
document.body.appendChild(stats.dom);

function animate() {
  requestAnimationFrame(animate);
  stats.update();
  renderer.render(scene, camera);
}
```

### 移动端调试
1. **Android**: Chrome → chrome://inspect
2. **iOS**: Safari → 开发 → 模拟器
3. **局域网**: 使用 IP 地址访问 `http://your-ip:3000`

## 🚀 性能优化

### 渲染优化
1. **几何体优化**
   - 合并相同材质的网格
   - 使用实例化渲染
   - 减少多边形数量

2. **材质优化**
   - 重用材质实例
   - 合理的纹理分辨率
   - 使用程序化材质

3. **渲染循环优化**
   - 避免频繁的矩阵计算
   - 使用对象池
   - 减少 GPU 状态切换

### 内存优化
1. **模型管理**
   - 及时清理未使用的几何体
   - 释放纹理内存
   - 清理事件监听器

2. **缓存策略**
   - 缓存计算结果
   - 对象重用
   - 避免冗余数据

## 🧪 测试策略

### 单元测试
- 测试核心算法函数
- 验证数据转换逻辑
- 检查边界条件

### E2E 测试
- 完整用户流程测试
- AR 模式功能验证
- 模型加载测试

### 性能测试
- 帧率监控
- 内存使用分析
- 加载时间测量

## 🚨 常见问题排查

### 1. 模型无法加载
```javascript
// 检查点
- GLB 文件是否存在
- 网络连接是否正常
- CORS 配置是否正确
- Blender 服务是否运行
```

### 2. AR 模式无法启动
```javascript
// 排查步骤
1. 检查设备 AR 支持
2. 验证 HTTPS 环境
3. 检查相机权限
4. 查看浏览器版本
```

### 3. 动画卡顿
```javascript
// 优化方案
1. 减少模型复杂度
2. 优化材质数量
3. 降低渲染分辨率
4. 使用性能分析工具
```

## 📚 参考资源

### Three.js 资源
- [Three.js 官方文档](https://threejs.org/docs/)
- [Three.js 示例](https://threejs.org/examples/)
- [WebXR 文档](https://immersive-web.github.io/webxr/)

### Blender 资源
- [Blender Python API](https://docs.blender.org/api/current/)
- [Blender 脚本教程](https://docs.blender.org/manual/en/latest/advanced/scripting/)

### Web 性能
- [WebGL 最佳实践](https://web.dev/webgl-best-practices/)
- [Three.js 性能优化](https://discourse.threejs.org/t/performance-tips/101)

---

## 🎉 开发环境检查清单

### ✅ 前置条件
- [ ] Node.js 16+ 安装
- [ ] Blender 3.0+ 安装
- [ ] Git 工具配置
- [ ] 代码编辑器配置（VS Code 推荐）

### ✅ VS Code 扩展
- [ ] ESLint
- [ ] Prettier
- [ ] StyleLint
- [ ] Three.js snippets
- [ ] GitLens

### ✅ 项目开发流程
- [ ] 代码格式化与检查
- [ ] 构建测试
- [ ] Git 提交规范
- [ ] 文档更新
- [ ] 性能测试

**开发愉快！ 🚀**