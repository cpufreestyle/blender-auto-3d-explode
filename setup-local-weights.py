#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键预置「本地图片转 3D（TripoSR 真重建）」所需的离线权重：

  1) stabilityai/TripoSR 的 model.ckpt + config.yaml
        -> external/TripoSR/local_model/
  2) facebook/dino-vitb16 图像编码器（TripoSR 的图像 tokenizer）
        -> HuggingFace 本地缓存（~/.cache/huggingface/hub）

下载支持断点续传 + 超时重试；可走系统代理，或 hf-mirror 镜像（受限网络）。
预置完成后，server.js 检测到 local_model/model.ckpt 即自动以本地引擎回退，无需联网、不消耗云端额度。

用法
----
  python setup-local-weights.py                 # 下载全部
  python setup-local-weights.py --model-only    # 只下 TripoSR 权重
  python setup-local-weights.py --dino-only     # 只下 DINO tokenizer
  python setup-local-weights.py --mirror        # 走 hf-mirror.com（受限网络友好）
  set HF_PROXY=http://127.0.0.1:7897            # 显式指定代理（本机开发环境）
  python setup-local-weights.py

说明
----
  - 代理：未显式指定时，沿用进程已有的 HTTP_PROXY/HTTPS_PROXY 环境变量；都没有则直连。
  - Windows：自动禁用 HF 符号链接（改用复制），避免 WinError 1314。
  - 依赖：需要 huggingface_hub（pip install -r requirements.txt 或 pip install huggingface_hub）。
"""

import argparse
import multiprocessing as mp
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCAL_MODEL_DIR = ROOT / "external" / "TripoSR" / "local_model"

REPO_TRIPOSR = "stabilityai/TripoSR"
REPO_DINO = "facebook/dino-vitb16"


def setup_env(use_mirror: bool, proxy: str | None):
    # Windows：禁用符号链接，改用复制，避免 WinError 1314
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
    if use_mirror:
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
        print("[env] 使用镜像 HF_ENDPOINT=https://hf-mirror.com")
    if proxy:
        os.environ["HTTP_PROXY"] = proxy
        os.environ["HTTPS_PROXY"] = proxy
        print(f"[env] 使用代理 {proxy}")
    elif os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY"):
        print(f"[env] 沿用系统代理 {os.environ.get('HTTPS_PROXY') or os.environ.get('HTTP_PROXY')}")
    else:
        print("[env] 直连（无代理）")


def _worker(fn, q: mp.Queue):
    try:
        q.put(("ok", str(fn())))
    except Exception as e:  # noqa: BLE001
        q.put(("err", str(e)[:600]))


def download_with_retry(label: str, fn, attempts: int = 200, timeout: int = 300) -> bool:
    for attempt in range(attempts):
        q: mp.Queue = mp.Queue()
        proc = mp.Process(target=_worker, args=(fn, q), daemon=True)
        proc.start()
        proc.join(timeout=timeout)
        if proc.is_alive():
            proc.terminate()
            proc.join()
            print(f"[{label}] 第 {attempt} 次：超时/卡死 -> 终止，将续传", flush=True)
            continue
        if proc.exitcode == 0 and not q.empty():
            kind, val = q.get()
            if kind == "ok":
                print(f"[{label}] 完成：{val}", flush=True)
                return True
            print(f"[{label}] 第 {attempt} 次：错误 {val}", flush=True)
        else:
            print(f"[{label}] 第 {attempt} 次：退出码 {proc.exitcode}", flush=True)
        time.sleep(2)
    return False


def dl_triposr():
    from huggingface_hub import hf_hub_download

    LOCAL_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    # config.yaml 与 model.ckpt 一并预置（server 用 TSR.from_pretrained 加载本地目录）
    hf_hub_download(
        REPO_TRIPOSR, "config.yaml",
        local_dir=str(LOCAL_MODEL_DIR), local_dir_use_symlinks=False,
    )
    return hf_hub_download(
        REPO_TRIPOSR, "model.ckpt",
        local_dir=str(LOCAL_MODEL_DIR), local_dir_use_symlinks=False,
    )


def dl_dino():
    from huggingface_hub import snapshot_download

    return snapshot_download(REPO_DINO)


def human_size(p: Path) -> str:
    if not p.exists():
        return "缺失"
    size = p.stat().st_size
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} PB"


def main():
    ap = argparse.ArgumentParser(description="预置本地 TripoSR 图片转3D 离线权重")
    ap.add_argument("--model-only", action="store_true", help="只下载 TripoSR 权重")
    ap.add_argument("--dino-only", action="store_true", help="只下载 DINO tokenizer")
    ap.add_argument("--mirror", action="store_true", help="走 hf-mirror.com 镜像")
    ap.add_argument("--proxy", default=None, help="显式代理，如 http://127.0.0.1:7897")
    args = ap.parse_args()

    setup_env(args.mirror, args.proxy)

    do_model = not args.dino_only
    do_dino = not args.model_only

    ok = True
    if do_model:
        print(f"\n=== 下载 TripoSR 权重 -> {LOCAL_MODEL_DIR} ===")
        ok = download_with_retry("triposr", dl_triposr) and ok
    if do_dino:
        print("\n=== 下载 DINO tokenizer -> HuggingFace 本地缓存 ===")
        ok = download_with_retry("dino", dl_dino) and ok

    print("\n=== 校验 ===")
    ckpt = LOCAL_MODEL_DIR / "model.ckpt"
    cfg = LOCAL_MODEL_DIR / "config.yaml"
    print(f"  model.ckpt : {human_size(ckpt)}  ({'OK' if ckpt.exists() and ckpt.stat().st_size > 1_000_000_000 else '异常/缺失'})")
    print(f"  config.yaml: {human_size(cfg)}  ({'OK' if cfg.exists() else '异常/缺失'})")

    if ok and ckpt.exists() and ckpt.stat().st_size > 1_000_000_000 and cfg.exists():
        print("\n✅ 离线权重预置完成。server.js 将自动以本地 TripoSR 进行图片转3D（无需额度/不联网）。")
    else:
        print("\n❌ 部分权重未就绪，请检查网络/代理后重试。")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
