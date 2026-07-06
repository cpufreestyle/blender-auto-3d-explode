# 🎉 Quest 3 爆炸拆解 3D 视图 - v1.9.0 发布说明

**发布日期**：2026-07-06
**版本**：v1.9.0
**主题**：系统架构重构 — 二进制传输、模块化拆分、安全加固与自动化测试

---

## 📋 版本概述

v1.9.0 是一次**重大架构重构版本**，涵盖 11 项工程化改进。本次更新废弃了 Base64 编码改为二进制流传输（节省 33% 带宽与内存）、将 3000+ 行的 `main.js` 拆分为独立数据与逻辑模块、引入前后端共享配置、增强服务器安全校验、整理项目目录结构，并建立了完整的端到端自动化测试链路。

---

## ✨ 新功能

### 1. 📦 二进制流传输（Binary Stream）

**文件**：`server.js`、`main.js`

废弃了原先的 Base64 编码传输方案，改为直接传输 GLB 二进制数据：

- **节省 33% 带宽**：Base64 编码会膨胀数据体积约 4/3 倍
- **降低内存峰值**：浏览器不再需要同时保存 Base64 字符串和解码后的 ArrayBuffer
- **Manifest 通过 HTTP Header 传递**：`X-Manifest` 自定义头携带 Base64 编码的 JSON 清单，与二进制体分离

```javascript
// server.js — 二进制响应
res.writeHead(200, {
  'Content-Type': 'application/octet-stream',
  'X-Manifest': manifestBase64,
  'X-Success': 'true'
});
res.end(outputBuffer);
```

```javascript
// main.js — 使用 XMLHttpRequest 实现实时上传进度
const xhr = new XMLHttpRequest();
xhr.upload.addEventListener('progress', (e) => {
  const percent = Math.round((e.loaded / e.total) * 100);
  updateUploadProgress(percent);
});
```

---

### 2. 🧩 ES 模块化拆分

**文件**：`src/quest3-data.js`、`src/quest3-steps.js`、`main.js`

将原先 3000+ 行的 `main.js` 中的内联数据提取为独立模块：

- **`src/quest3-data.js`**：Quest 3 技术规格数据库 + 15 个部件详细信息
- **`src/quest3-steps.js`**：7 步分步骤教学方案（依赖 `quest3-data.js`）
- `main.js` 通过 `import` 引入，消除数据与逻辑耦合

---

### 3. 🔧 前后端共享配置

**文件**：`quest3_config.json`

引入统一的 JSON 配置文件，存储 15 个部位的归一化坐标模板，供 Python (`blender_split_glb.py`) 和 JS (`main.js`) 共同读取，彻底消除前后端坐标不同步的风险：

```json
{
  "parts": [
    { "name": "主机身",         "pos": [ 0.00, -0.47, -0.06] },
    { "name": "前面板",         "pos": [ 0.00, -0.47,  0.75] },
    ...
  ]
}
```

---

### 4. 🧪 端到端自动化测试

**文件**：`tests/e2e-test.mjs`

建立从健康检查到模型拆解准确性验证的完整测试链路：

1. **健康检查** — 验证 Blender 后端可用
2. **上传模型** — 上传 Quest3.glb 文件
3. **部位验证** — 验证返回的 15 个部位名称与模板一致
4. **二进制解析** — 验证 GLB 二进制响应可正常解析

运行方式：`npm test`

---

### 5. 📐 代码规范工具链

**文件**：`.eslintrc.json`、`.prettierrc`、`package.json`

- 新增 ESLint 配置（含 ES Module 支持）
- 新增 Prettier 格式化配置
- `package.json` 添加 `lint` 和 `format` 脚本

```bash
npm run lint    # 检查并自动修复
npm run format  # 格式化代码
```

---

## 🐛 Bug 修复

### 6. 🔴 服务器变量作用域 Bug

**文件**：`server.js`

**问题**：错误处理回调中无法访问 `blenderStdout` / `blenderStderr` 变量，导致错误信息丢失。

**修复**：将变量声明从 `try` 块内提升至外层作用域。

---

### 7. 🔴 模型几何破损 — 非破坏性占位策略

**文件**：`blender_split_glb.py`

**问题**：之前的"借面"逻辑（从主机身撕取面来填充缺失部位）导致主机身出现空洞，几何体破损。

**修复**：改为生成独立的半透明立方体占位网格，不修改原始几何体：

- 缺失部位使用半透明材质的占位立方体
- 支持从 `quest3_config.json` 加载外部坐标配置
- 占位网格自动定位到模板坐标位置

---

## 🔒 安全加固

### 8. Multipart 安全校验

**文件**：`server.js`

为 multipart 解析器增加多层输入校验：

- **文件名消毒**：移除路径穿越字符（`../`、`\`）
- **文件名长度限制**：最大 255 字符
- **boundary 长度限制**：最大 200 字符
- **Part 数量限制**：最大 10 个 part
- **Header 大小限制**：单个 part header 最大 8KB
- **文件大小限制**：最大 100MB

### 9. 临时文件自动清理

**文件**：`server.js`

服务器启动时自动清理上传目录中超过 1 小时的残留临时文件，防止磁盘空间泄漏。

---

## 📁 项目目录整理

### 10. 规范化目录结构

将根目录 50+ 个杂乱文件整理为规范结构：

```
quest3-exploded/
├── index.html              # 入口页面
├── main.js                 # 主逻辑（精简后）
├── server.js               # GLB 拆解服务器
├── blender_split_glb.py    # Blender 拆解脚本
├── quest3_config.json      # 前后端共享配置
├── src/                    # 前端数据模块
│   ├── quest3-data.js      # 技术规格 + 部件信息
│   └── quest3-steps.js     # 教学步骤方案
├── scripts/                # 工具脚本
│   ├── blender_control.py
│   ├── blender_api_server.py
│   ├── blender_watcher.py
│   ├── create_release.sh
│   └── ...
├── tests/                  # 测试文件
│   ├── e2e-test.mjs        # 端到端测试
│   ├── check-model.html
│   └── ...
├── docs/                   # 所有文档
│   ├── README.md
│   ├── CHANGELOG.md
│   └── ...
├── .eslintrc.json          # ESLint 配置
└── .prettierrc             # Prettier 配置
```

**移动文件统计**：
- 30+ 文档文件 → `docs/`
- 10+ 脚本文件 → `scripts/`
- 15+ 测试文件 → `tests/`

---

## 📊 统计

```
新功能: 5 项（二进制传输、模块化、共享配置、E2E 测试、代码规范）
Bug 修复: 2 个（变量作用域、几何破损）
安全加固: 2 项（Multipart 校验、临时文件清理）
目录整理: 50+ 文件归入 docs/、scripts/、tests/
代码变更: +941/-432 行
影响文件: 77 个
```

---

## 🎯 升级指南

### 从 v1.5.0 升级

```bash
git pull origin main
npm install   # 安装新依赖（如有）
npm test      # 运行端到端测试验证
```

### 启动服务

```bash
# 启动 GLB 拆解服务器
npm start

# 启动前端开发服务器
npm run dev

# 运行测试
npm test
```

---

## 🔗 相关链接

- **GitHub 仓库**：https://github.com/cpufreestyle/blender-auto-3d-explode
- **问题反馈**：https://github.com/cpufreestyle/blender-auto-3d-explode/issues
- **完整变更日志**：[CHANGELOG.md](CHANGELOG.md)

---

**🎉 感谢使用 Quest 3 爆炸拆解 3D 视图 v1.9.0！**
