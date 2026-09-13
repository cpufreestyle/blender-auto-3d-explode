import multiprocessing as mp
import time
from huggingface_hub import hf_hub_download

import os
REPO = "stabilityai/TripoSR"
FILE = "model.ckpt"
LOCAL_DIR = r"D:\Michael\CodeBuddy\20260827161745\external\TripoSR\local_model"

def worker(q):
    try:
        p = hf_hub_download(REPO, FILE, local_dir=LOCAL_DIR, local_dir_use_symlinks=False)
        q.put(("ok", p))
    except Exception as e:
        q.put(("err", str(e)[:500]))

def main():
    for attempt in range(200):
        q = mp.Queue()
        proc = mp.Process(target=worker, args=(q,), daemon=True)
        proc.start()
        proc.join(timeout=150)  # 单次尝试最多 150s，卡死则超时
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
