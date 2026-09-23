#!/usr/bin/env python3
"""
CI Blender 冒烟门禁（本机可复现）。

动机：仓库里所有 Blender 脚本的单测都是把 bpy/mathutils stub 进 sys.modules 后跑的，
只能覆盖纯逻辑；真正会在发布环境炸裂的是「Blender 版本行为」——导入算子名变化、
节点名本地化、材质 API 弃用（Material 的 use_nodes 属性 6.0 移除）等。本脚本用真实 Blender
跑两条最硬的路径并对产物断言：

  1. blender_split_glb.py 拆分 models/quest3_model.glb
     断言：退出码 0；manifest.total_parts == 15 且 parts 数一致；GLB 体积在合理区间
  2. quest3_exploded_blender.py 程序化建模型（exec 后在会话内回查场景）
     断言：模型对象（MESH + 头带 CURVE）15 个；所有材质 node_tree 非 None；每个材质含 BSDF_PRINCIPLED 节点
     （后两条即 use_nodes 迁移的运行时守卫：把 node_tree 用法删光会让这里变红）

用法：
  python3 scripts/ci_blender_smoke.py --blender /Applications/Blender.app/Contents/MacOS/Blender
  BLENDER_PATH=blender python3 scripts/ci_blender_smoke.py        # CI 上直接用 PATH 里的 blender

退出码：0 = 全部通过；1 = 有断言失败或 Blender 跑挂。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPLIT_SCRIPT = os.path.join(ROOT, "blender_split_glb.py")
SPLIT_MODEL = os.path.join(ROOT, "models", "quest3_model.glb")
MODEL_SCRIPT = os.path.join(ROOT, "quest3_exploded_blender.py")

BLENDER_TIMEOUT = 900  # 秒：CI runner 比开发机慢，留足余量


def run_blender(blender, script_args, env_extra=None, timeout=BLENDER_TIMEOUT):
    """跑一次 `blender --background --python ... -- <args>`，返回 (退出码, 合并输出)。"""
    cmd = [blender, "--background", "--python", script_args[0], "--", *script_args[1:]]
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                          timeout=timeout, env=env, cwd=ROOT)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main():
    parser = argparse.ArgumentParser(description="Blender 冒烟门禁")
    parser.add_argument("--blender", default=os.environ.get("BLENDER_PATH", "blender"),
                        help="Blender 可执行文件路径（默认读 BLENDER_PATH，再默认 PATH 里的 blender）")
    args = parser.parse_args()

    failures = []

    def check(cond, message):
        print(("  ✅ " if cond else "  ❌ ") + message)
        if not cond:
            failures.append(message)

    tmp = tempfile.mkdtemp(prefix="blender-smoke-")
    glb_path = os.path.join(tmp, "split.glb")
    manifest_path = os.path.join(tmp, "split.json")

    print("== 1) blender_split_glb.py 拆分冒烟 ==")
    rc, out = run_blender(args.blender, [
        SPLIT_SCRIPT,
        "--input", SPLIT_MODEL,
        "--output", glb_path,
        "--manifest", manifest_path,
    ])
    if rc != 0:
        print(out[-2000:])
    check(rc == 0, "blender_split_glb.py 退出码为 0")

    manifest = None
    try:
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception as exc:  # noqa: BLE001 - 冒烟脚本需要把任何解析失败都变成断言失败
        print(f"  ⚠️ manifest 读取失败: {exc}")
    check(manifest is not None, "manifest JSON 可解析")
    if manifest:
        total = manifest.get("total_parts")
        parts = manifest.get("parts") or []
        check(total == 15, f"manifest.total_parts == 15（实际 {total}）")
        check(len(parts) == 15, f"manifest.parts 数 == 15（实际 {len(parts)}）")

    glb_size = os.path.getsize(glb_path) if os.path.exists(glb_path) else 0
    check(10_000 < glb_size < 2_000_000,
          f"GLB 体积在 10KB–2MB 之间（实际 {glb_size / 1024:.1f} KB）")

    print("== 2) quest3_exploded_blender.py 程序化建模冒烟（含 use_nodes 迁移守卫） ==")
    probe_path = os.path.join(tmp, "scene_probe.py")
    with open(probe_path, "w", encoding="utf-8") as fh:
        fh.write(
            "import os\n"
            "import bpy\n"
            "target = os.environ['SMOKE_TARGET_SCRIPT']\n"
            "ns = {'bpy': bpy, '__name__': '__main__'}\n"
            "exec(compile(open(target, encoding='utf-8').read(), target, 'exec'), ns)\n"
            "# 15 个部件里「头带」是 CURVE，其余为 MESH；相机/灯/枢轴不计入\n"
            "model_objs = [o for o in bpy.data.objects if o.type in ('MESH', 'CURVE')]\n"
            "mats = list(bpy.data.materials)\n"
            "no_tree = [m.name for m in mats if m.node_tree is None]\n"
            "no_bsdf = [m.name for m in mats if m.node_tree is not None\n"
            "           and not any(n.type == 'BSDF_PRINCIPLED' for n in m.node_tree.nodes)]\n"
            "print(f'SMOKE_PROBE model_objs={len(model_objs)} materials={len(mats)} '\n"
            "      f'no_node_tree={len(no_tree)} no_bsdf={len(no_bsdf)}')\n"
        )
    rc, out = run_blender(args.blender, [probe_path],
                          env_extra={"SMOKE_TARGET_SCRIPT": MODEL_SCRIPT})
    if rc != 0:
        print(out[-2000:])
    check(rc == 0, "quest3_exploded_blender.py 退出码为 0")

    probe_line = next((line for line in out.splitlines() if line.startswith("SMOKE_PROBE")), "")
    fields = dict(
        kv.split("=", 1) for kv in probe_line.replace("SMOKE_PROBE", "").split() if "=" in kv
    )
    model_count = int(fields.get("model_objs", 0))
    no_node_tree = int(fields.get("no_node_tree", 0))
    no_bsdf = int(fields.get("no_bsdf", 0))
    check(model_count == 15, f"场景模型对象数（MESH+CURVE）== 15（实际 {model_count}）")
    check(no_node_tree == 0,
          f"所有材质 node_tree 非 None（use_nodes 迁移守卫，实际缺失 {no_node_tree}）")
    check(no_bsdf == 0,
          f"所有材质含 BSDF_PRINCIPLED 节点（实际缺失 {no_bsdf}）")

    print()
    if failures:
        print(f"冒烟结果: FAIL（{len(failures)} 项未过）")
        for f in failures:
            print("  - " + f)
        return 1
    print("冒烟结果: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
