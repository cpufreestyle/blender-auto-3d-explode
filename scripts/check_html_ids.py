#!/usr/bin/env python3
"""
检查 HTML 文件中的 ID 引用是否都在 HTML 中定义
"""

import re
import glob
from pathlib import Path

def check_html_ids(html_file):
    """检查单个 HTML 文件"""
    with open(html_file, 'r', encoding='utf-8') as f:
        content = f.read()

    # 查找所有 id="xxx" 定义
    defined_ids = set(re.findall(r'id="([^"]*)"', content))

    # 查找所有 getElementById('xxx') 引用
    # 匹配 JavaScript 中的 getElementById 调用
    referenced_ids = set(re.findall(r'getElementById\([\'"]([^\'"]+)[\'"]\)', content))

    # 找到未定义的引用
    undefined = referenced_ids - defined_ids

    if undefined:
        print(f"\n❌ {html_file}:")
        for id_name in sorted(undefined):
            print(f"   - 引用但未定义: {id_name}")
        return False
    else:
        print(f"✅ {html_file}")
        return True

def main():
    html_files = glob.glob('*.html')

    print(f"检查 {len(html_files)} 个 HTML 文件...\n")

    all_ok = True
    for html_file in sorted(html_files):
        if not check_html_ids(html_file):
            all_ok = False

    print("\n" + "="*60)
    if all_ok:
        print("✅ 所有 HTML 文件 ID 引用都正确！")
    else:
        print("❌ 发现未定义的 ID 引用！")

    return 0 if all_ok else 1

if __name__ == '__main__':
    exit(main())
