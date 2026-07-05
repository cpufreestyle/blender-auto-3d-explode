#!/bin/bash
# 自动创建 GitHub Release 脚本

set -e

# 检查参数
if [ $# -lt 2 ]; then
    echo "使用方法:"
    echo "  $0 <version> <tag>"
    echo ""
    echo "示例:"
    echo "  $0 v1.4.0 'Blender Python API 集成系统'"
    exit 1
fi

VERSION=$1
TAG=$2
RELEASE_NOTES="RELEASE_NOTES_${VERSION}.md"

# 检查文件是否存在
if [ ! -f "$RELEASE_NOTES" ]; then
    echo "❌ 找不到发布说明文件: $RELEASE_NOTES"
    exit 1
fi

# 检查 git 状态
if [ -n "$(git status --porcelain)" ]; then
    echo "⚠️  工作区有未提交的更改，请先提交或暂存"
    exit 1
fi

# 检查是否在正确的分支
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "📍 当前分支: $BRANCH"

# 询问是否继续
read -p "创建 Release $VERSION - $TAG? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ 取消操作"
    exit 1
fi

# 创建 Git tag
echo "🏷️  创建 Git tag: $VERSION ..."
git tag -a "$VERSION" -m "$TAG"

# 推送 tag 到 GitHub
echo "📤 推送 tag 到 GitHub..."
git push origin "$VERSION"

# 创建 GitHub Release（使用 gh CLI）
if command -v gh &> /dev/null; then
    echo "🚀 创建 GitHub Release..."

    # 读取 release notes
    NOTES=$(cat "$RELEASE_NOTES")

    # 创建 release
    gh release create "$VERSION" \
        --title "$TAG" \
        --notes "$NOTES" \
        --latest

    echo "✅ GitHub Release 创建成功！"
    echo "🔗 地址: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/releases/tag/$VERSION"
else
    echo "⚠️  未找到 gh CLI，跳过 GitHub Release 创建"
    echo "💡 安装 gh: https://cli.github.com/"
    echo "💡 或手动创建 Release: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/releases/new"
fi

echo ""
echo "✅ Release $VERSION 创建完成！"
echo "📝 Release Notes: $RELEASE_NOTES"
