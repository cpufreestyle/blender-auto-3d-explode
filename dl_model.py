import os, time
import requests

URL = "https://huggingface.co/stabilityai/TripoSR/resolve/main/model.ckpt"
OUT = r"D:\Michael\CodeBuddy\20260827161745\external\TripoSR\local_model\model.ckpt"
PROXIES = {"http": "http://127.0.0.1:7897", "https": "http://127.0.0.1:7897"}

def size():
    return os.path.getsize(OUT) if os.path.exists(OUT) else 0

def main():
    for attempt in range(300):
        start = size()
        headers = {"Range": f"bytes={start}-"}
        try:
            with requests.get(URL, headers=headers, proxies=PROXIES, stream=True, timeout=(30, 30)) as r:
                r.raise_for_status()
                mode = "ab" if start else "wb"
                with open(OUT, mode) as f:
                    last = time.time()
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)
                            f.flush()
                            last = time.time()
                        elif time.time() - last > 30:
                            raise TimeoutError("stall between chunks")
            print(f"DONE size={size()}")
            break
        except Exception as e:
            sz = size()
            print(f"attempt {attempt} at {sz} bytes failed: {e}", flush=True)
            time.sleep(2)

if __name__ == "__main__":
    main()
