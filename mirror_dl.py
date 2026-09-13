import os
from huggingface_hub import hf_hub_download

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
for attempt in range(5):
    try:
        p = hf_hub_download("stabilityai/TripoSR", "model.ckpt")
        print("OK", p)
        break
    except Exception as e:
        print(f"attempt {attempt} failed: {e}")
