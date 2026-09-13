import os
# 强制走代理 + 默认 huggingface.co（代理是当前机器唯一可用出口）
os.environ["HF_ENDPOINT"] = "https://huggingface.co"
os.environ["HTTPS_PROXY"] = "http://127.0.0.1:7897"
os.environ["HTTP_PROXY"] = "http://127.0.0.1:7897"
# Windows 普通用户没有创建符号链接的特权，禁用后改用复制，避免 WinError 1314
os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"

import multiprocessing as mp
import time
from huggingface_hub import snapshot_download

REPO = "facebook/dino-vitb16"

def worker(q):
    try:
        p = snapshot_download(REPO)
        q.put(("ok", p))
    except Exception as e:
        q.put(("err", str(e)[:500]))

def main():
    for attempt in range(200):
        q = mp.Queue()
        proc = mp.Process(target=worker, args=(q,), daemon=True)
        proc.start()
        proc.join(timeout=300)
        if proc.is_alive():
            proc.terminate()
            proc.join()
            print(f"attempt {attempt}: TIMEOUT/stall -> terminate, will resume", flush=True)
        else:
            if proc.exitcode == 0 and not q.empty():
                kind, val = q.get()
                if kind == "ok":
                    print("DONE " + str(val), flush=True)
                    return
                else:
                    print(f"attempt {attempt}: err {val}", flush=True)
            else:
                print(f"attempt {attempt}: exited code {proc.exitcode}", flush=True)
        time.sleep(2)

if __name__ == "__main__":
    main()
