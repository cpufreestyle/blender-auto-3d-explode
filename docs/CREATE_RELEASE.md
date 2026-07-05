# 🚀 创建 GitHub Release 指南

本文档说明如何为 Quest 3 爆炸拆解项目创建 GitHub Release。

---

## 📋 方法 1：使用 gh CLI（推荐）

### 1.1 安装 GitHub CLI

```bash
# macOS (Homebrew)
brew install gh

# 登录 GitHub
gh auth login
```

### 1.2 运行自动脚本

```bash
# 给脚本执行权限
chmod +x create_release.sh

# 创建 v1.4.0 release
./create_release.sh v1.4.0 "Blender Python API 集成系统"
```

**脚本会自动完成**：
- ✅ 创建 Git tag
- ✅ 推送 tag 到 GitHub
- ✅ 创建 GitHub Release
- ✅ 附上发布说明

---

## 📋 方法 2：手动创建（不使用 gh CLI）

### 2.1 创建 Git Tag

```bash
# 创建 tag
git tag -a v1.4.0 -m "Blender Python API 集成系统"

# 推送 tag 到 GitHub
git push origin v1.4.0
```

### 2.2 在 GitHub 网站创建 Release

1. **打开 GitHub 仓库**
   ```
   https://github.com/cpufreestyle/quest3-exploded
   ```

2. **进入 Releases 页面**
   - 点击右侧 **Releases** 标签
   - 或访问：`https://github.com/cpufreestyle/quest3-exploded/releases`

3. **创建新 Release**
   - 点击 **Create a new release** 按钮

4. **填写信息**
   ```
   Choose a tag: v1.4.0
   Release title: Blender Python API 集成系统
   Description: [粘贴 RELEASE_NOTES_v1.4.0.md 的内容]
   ```

5. **发布**
   - 点击 **Publish release**

---

## 📋 方法 3：使用 GitHub API

### 3.1 获取 Personal Access Token

1. 访问 https://github.com/settings/tokens
2. 生成新 token（勾选 `repo` 权限）
3. 保存 token（只显示一次）

### 3.2 使用 curl 创建 Release

```bash
# 设置变量
TOKEN="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
REPO="cpufreestyle/quest3-exploded"
VERSION="v1.4.0"
TITLE="Blender Python API 集成系统"
NOTES=$(cat RELEASE_NOTES_v1.4.0.md)

# 创建 release
curl -X POST \
  https://api.github.com/repos/$REPO/releases \
  -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  -d "$(jq -n \
    --arg tag "$VERSION" \
    --arg name "$TITLE" \
    --arg body "$NOTES" \
    '{tag_name: $tag, name: $name, body: $body, draft: false, prerelease: false}')"
```

---

## 📋 方法 4：使用 GitHub Web UI（最简单）

### 4.1 打开 Release 页面

```
https://github.com/cpufreestyle/quest3-exploded/releases/new?tag=v1.4.0
```

### 4.2 填写表单

**Tag version**：`v1.4.0`

**Release title**：`Blender Python API 集成系统`

**Description**：（粘贴 RELEASE_NOTES_v1.4.0.md 的内容）

### 4.3 点击 "Publish release"

---

## 🎯 Release 内容模板

### 最小版本

```markdown
## What's New

- ✨ Blender Python API 控制器
- 🌐 Blender HTTP API 服务器
- 🔄 文件监听自动执行
- 🎬 Quest 3 Blender 爆炸视图脚本
- 🐛 修复 Blender 5.1 API 兼容性

**完整说明**：[RELEASE_NOTES_v1.4.0.md](RELEASE_NOTES_v1.4.0.md)
```

### 完整版本

直接使用 `RELEASE_NOTES_v1.4.0.md` 的内容。

---

## 📦 发布清单

### 发布前检查

- [ ] 所有测试通过
- [ ] 文档已更新（README.md, CHANGELOG.md）
- [ ] RELEASE_NOTES_v1.4.0.md 已创建
- [ ] 代码已提交到 main 分支
- [ ] 所有文件已推送到 GitHub

### 发布后检查

- [ ] GitHub Release 已创建
- [ ] Release 页面显示正常
- [ ] 发布说明格式正确
- [ ] Tag 已推送到 GitHub
- [ ] Vercel 已自动部署（如适用）

---

## 🔗 相关链接

- **GitHub Releases**：https://github.com/cpufreestyle/quest3-exploded/releases
- **创建 Release**：https://github.com/cpufreestyle/quest3-exploded/releases/new
- **GitHub CLI**：https://cli.github.com/
- **GitHub API**：https://docs.github.com/en/rest/releases

---

## 💡 自动化脚本

### create_release.sh

```bash
#!/bin/bash
# 自动创建 GitHub Release

VERSION=$1
TAG=$2

# 检查参数
if [ $# -lt 2 ]; then
    echo "Usage: $0 <version> <tag>"
    echo "Example: $0 v1.4.0 'Blender Python API'"
    exit 1
fi

# 检查 gh CLI
if ! command -v gh &> /dev/null; then
    echo "❌ gh CLI not found"
    echo "Install: brew install gh"
    exit 1
fi

# 创建 tag
git tag -a "$VERSION" -m "$TAG"
git push origin "$VERSION"

# 创建 release
gh release create "$VERSION" \
    --title "$TAG" \
    --notes-file "RELEASE_NOTES_${VERSION}.md" \
    --latest

echo "✅ Release $VERSION created!"
```

---

## 🎉 示例

```bash
# 1. 安装 gh CLI
brew install gh
gh auth login

# 2. 创建 release
./create_release.sh v1.4.0 "Blender Python API 集成系统"

# 3. 完成！
# 🔗 https://github.com/cpufreestyle/quest3-exploded/releases/tag/v1.4.0
```

---

**准备好发布了吗？** 🚀
