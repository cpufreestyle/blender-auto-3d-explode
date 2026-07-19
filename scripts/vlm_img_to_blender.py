#!/usr/bin/env python3
"""VLM 看图 -> Blender 3D，带沙箱自动修复循环，并导出 GLB。

把"图片转 3D"做成可选 provider（视觉模型路线）。支持多模态视觉模型：
  - stepfun   : StepFun step-3.7-flash 等（OpenAI 兼容, https://api.stepfun.com/v1）
  - kimi      : Kimi / Moonshot（OpenAI 兼容, https://api.moonshot.cn/v1）
  - anthropic : Claude 3 系列（Anthropic Messages API, https://api.anthropic.com）

管线:
  1. 读取图片 -> base64
  2. 调用视觉模型 (VLM) 看图, 生成 bpy 重建代码
  3. 通过 Blender MCP 插件 TCP (localhost:9876) 在 Blender 中执行 (沙箱)
  4. 若执行报错, 把错误回灌 VLM, 让其修复并重生成 (最多 MAX_RETRIES 次)
  5. 成功后导出场景中的 GLM_VLM_* 对象为 GLB

用法:
  python3 vlm_img_to_blender.py --provider stepfun --model step-3.7-flash --image path.png
依赖: 仅 Python 标准库。需 Blender 运行且 MCP 插件监听 9876。
"""
import json
import os
import sys
import base64
import re
import socket
import urllib.request
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG = os.path.join(ROOT, "ai-config.json")
DEFAULT_IMG = os.path.join(ROOT, "external", "TripoSR", "examples", "hamburger.png")
EXPORT_PATH = "/tmp/vlm_img_to_3d.glb"

# 支持的视觉模型。OpenAI 兼容走 /chat/completions；anthropic 走原生 Messages API。
VLM_PROVIDERS = {
    "stepfun": {"base_url": "https://api.stepfun.com/v1", "cfg_key": "stepfun", "kind": "openai"},
    "kimi": {"base_url": "https://api.moonshot.cn/v1", "cfg_key": "kimi", "kind": "openai"},
    "anthropic": {"base_url": "https://api.anthropic.com/v1", "cfg_key": "anthropic", "kind": "anthropic"},
}

MAX_RETRIES = 4
ADDON_HOST = "localhost"
ADDON_PORT = 9876
ADDON_TIMEOUT = 120

# 成功后导出 GLM_VLM_* 对象为 GLB（在 Blender 内执行）
EXPORT_CODE = (
    "import bpy\n"
    "objs = [o for o in bpy.data.objects if o.name.startswith('GLM_VLM_')]\n"
    "if objs:\n"
    "    bpy.ops.object.select_all(action='DESELECT')\n"
    "    for o in objs:\n"
    "        o.select_set(True)\n"
    "    bpy.ops.export_scene.gltf(filepath='" + EXPORT_PATH + "', "
    "use_selection=True, export_format='GLB')\n"
    "    print('EXPORT_DONE " + EXPORT_PATH + "')\n"
    "else:\n"
    "    print('EXPORT_NONE')\n"
)


def load_provider_key(provider):
    """从 ai-config.json 读取指定 provider 的 key / model。"""
    if not os.path.exists(CONFIG):
        return "", ""
    with open(CONFIG) as f:
        c = json.load(f)
    blk = c.get(VLM_PROVIDERS[provider]["cfg_key"], {})
    return blk.get("key", ""), blk.get("model", "")


def call_vlm(provider, base_url, key, model, img_path, fix_msg=None):
    """调用视觉模型。fix_msg 非空时进入"修复模式"(回灌上一次错误)。

    根据 provider 类型选择接口：
      - openai 兼容 (stepfun/kimi): POST {base_url}/chat/completions
      - anthropic (Claude):         POST {base_url}/messages (原生 Messages API)
    """
    with open(img_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    ext = os.path.splitext(img_path)[1].lower().lstrip(".")
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else "image/png"

    if fix_msg:
        prompt = (
            "你之前为这张图片生成的 Blender Python 代码执行报错了。错误信息：\n"
            f"{fix_msg}\n\n"
            "请修复该错误，重新输出【完整、可直接在 Blender 中执行】的 Python 代码，"
            "放在一个 ```python 代码块中，不要任何解释。注意 Blender 版本兼容性：\n"
            "- 基础几何体用 bpy.ops.mesh.primitive_*(如 primitive_uv_sphere_add / "
            "primitive_cylinder_add / primitive_torus_add / primitive_cube_add / "
            "primitive_cone_add)，不要用不存在的算子名。\n"
            "- 设置 Principled BSDF 基础色用 inputs[0] 或 inputs['Base Color']；"
            "不要用固定索引(如 inputs[9])设 Roughness。\n"
            "- primitive_torus_add 只用 major_radius / minor_radius，不要传 radius 参数。\n"
            "- 所有新建对象名以 'GLM_VLM_' 开头。\n"
        )
    else:
        prompt = (
            "你是一个 3D 建模助手。请看这张图片中的物体，用 Blender Python 代码（bpy）"
            "程序化重建它。要求：\n"
            "1. 只使用基础几何体（bpy.ops.mesh.primitive_*）拼装，体现物体的主要形状、"
            "比例和部件层次。\n"
            "2. 为每个主要部件创建材质并设置合理颜色（尽量贴近图片真实颜色）。\n"
            "3. 所有新建对象名以 'GLM_VLM_' 开头，便于识别。\n"
            "4. 注意 Blender 版本兼容性：基础几何体用 primitive_*(如 primitive_uv_sphere_add)；"
            "Principled BSDF 基础色用 inputs[0]；primitive_torus_add 只用 major_radius/minor_radius。\n"
            "5. 只输出 Python 代码，放在一个 ```python 代码块中，不要任何解释文字。\n"
        )

    # Anthropic 原生 Messages API（Claude）：图片走 source.base64，响应 content 是 block 列表
    if VLM_PROVIDERS[provider]["kind"] == "anthropic":
        payload = {
            "model": model,
            "max_tokens": 4096,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
                    ],
                }
            ],
        }
        req = urllib.request.Request(
            base_url + "/messages",
            data=json.dumps(payload).encode(),
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=240) as r:
            data = json.loads(r.read().decode())
        text_parts = [
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        ]
        return "".join(text_parts)

    # OpenAI 兼容（stepfun / kimi）：标准 Chat Completions 多模态
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            }
        ],
    }
    req = urllib.request.Request(
        base_url + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=240) as r:
        data = json.loads(r.read().decode())
    return data["choices"][0]["message"]["content"]


def extract_code(text):
    m = re.search(r"```python\s*(.*?)```", text, re.DOTALL)
    return m.group(1).strip() if m else text.strip()


def call_addon(code):
    """连接 Blender MCP 插件 (9876)，执行代码并返回解析后的 JSON 响应。"""
    payload = json.dumps({"type": "execute_code", "params": {"code": code}}).encode() + b"\n"
    sock = socket.create_connection((ADDON_HOST, ADDON_PORT), timeout=ADDON_TIMEOUT)
    try:
        sock.settimeout(ADDON_TIMEOUT)
        sock.sendall(payload)
        buf = b""
        while True:
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            try:
                return json.loads(buf.decode("utf-8"))
            except json.JSONDecodeError:
                continue
        if not buf:
            raise RuntimeError("No response from Blender addon (is it running?)")
        return json.loads(buf.decode("utf-8"))
    finally:
        try:
            sock.close()
        except Exception:
            pass


def run():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="stepfun", choices=list(VLM_PROVIDERS.keys()))
    ap.add_argument("--model", default=None, help="覆盖模型名")
    ap.add_argument("--image", default=DEFAULT_IMG)
    args = ap.parse_args()

    if args.provider not in VLM_PROVIDERS:
        print(f"ERROR: 不支持的 provider '{args.provider}'，可选: {list(VLM_PROVIDERS.keys())}")
        sys.exit(2)

    cfg_key = VLM_PROVIDERS[args.provider]["cfg_key"]
    key, cfg_model = load_provider_key(args.provider)
    if not key or key == "***":
        print(f"ERROR: 未配置 {cfg_key} 的 API Key，请在 ai-config.json 的 {cfg_key}.key 填入")
        sys.exit(2)
    model = args.model or cfg_model or "step-3.7-flash"
    base_url = VLM_PROVIDERS[args.provider]["base_url"]

    print(f"VLM provider: {args.provider}")
    print(f"VLM 模型: {model}")
    print(f"输入图片: {args.image}")
    print(f"最大重试: {MAX_RETRIES}")
    print("=" * 50)

    last_code = None
    last_err = None
    result = None
    attempt = 0

    for attempt in range(1, MAX_RETRIES + 1):
        print(f"\n[尝试 {attempt}/{MAX_RETRIES}] 调用 VLM 生成代码...")
        try:
            reply = call_vlm(args.provider, base_url, key, model, args.image, fix_msg=last_err)
        except Exception as e:
            print(f"  VLM 调用失败: {e}")
            if attempt < MAX_RETRIES:
                last_err = f"VLM 调用异常: {e}"
                continue
            break

        code = extract_code(reply)
        last_code = code
        print(f"  VLM 返回 {len(code)} 字符代码")

        print("  发送到 Blender 执行 (沙箱)...")
        try:
            resp = call_addon(code)
        except RuntimeError as e:
            print(f"  无法连接 Blender: {e}")
            print("  请确认 Blender 已启动且 MCP 插件监听 9876，然后重试。")
            sys.exit(3)

        if isinstance(resp, dict) and resp.get("status") == "error":
            last_err = resp.get("message", "unknown error")
            print(f"  执行报错: {last_err}")
            if attempt < MAX_RETRIES:
                print("  -> 回灌 VLM 自动修复...")
                continue
            print("  达到最大重试次数，放弃。")
            break

        result = resp
        print("  执行成功 ✅")
        out_preview = str(resp.get("result", "") or "").strip()
        if out_preview:
            print(f"  Blender 输出: {out_preview[:300]}")
        break

    if not (isinstance(result, dict) and result.get("status") == "error"):
        # 导出 GLM_VLM_* 为 GLB
        print("\n导出 GLB...")
        try:
            exp = call_addon(EXPORT_CODE)
            exp_out = str(exp.get("result", "") or "")
            if "EXPORT_DONE" in exp_out:
                print(f"  GLB 已导出: {EXPORT_PATH}")
            else:
                print(f"  导出结果: {exp_out.strip()[:200]}")
        except Exception as e:
            print(f"  导出失败: {e}")

    out_path = os.path.join(HERE, "_vlm_generated_blender.py")
    with open(out_path, "w") as f:
        f.write(last_code or "")

    print("\n" + "=" * 50)
    if result and not (isinstance(result, dict) and result.get("status") == "error"):
        fixed = max(0, attempt - 1)
        print(f"完成：经 {attempt} 次迭代（含 {fixed} 次自动修复）成功生成 3D 模型")
        print(f"GLB 输出: {EXPORT_PATH}")
    else:
        print("失败：未能在限定重试次数内生成可执行代码")
        print(f"最后一次错误: {last_err}")
    print(f"最终代码已写入: {out_path}")


if __name__ == "__main__":
    run()
