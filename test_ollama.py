import sys, json, urllib.request

SYSTEM = """你是一个乐高积木模型专家。根据用户的描述，用标准的乐高砖块拼接出模型。

乐高砖块标准尺寸（单位：乐高单位，1单位=0.8cm）：
- 2x4 砖块：长4单位，宽2单位，高1单位（最常用）
- 2x2 砖块：长2单位，宽2单位，高1单位
- 1x2 砖块：长2单位，宽1单位，高1单位
- 1x4 砖块：长4单位，宽1单位，高1单位
- 2x3 砖块：长3单位，宽2单位，高1单位
- 1x1 砖块：长1单位，宽1单位，高1单位（用于细节）

请返回 JSON 格式的模型结构：
{
  "description": "模型的简要描述",
  "bricks": [
    {
      "name": "砖块名称",
      "type": "2x4|2x2|1x2|1x4|2x3|1x1",
      "position": [x, y, z],
      "rotation": 0|90|180|270,
      "color": "red|blue|green|yellow|white|black|orange|gray|brown"
    }
  ]
}

重要规则：
1. 使用标准乐高砖块拼接，就像真实的乐高积木一样
2. 砖块之间要紧密连接，像真实的积木堆叠
3. 位置坐标以乐高单位计算（1单位=0.8cm）
4. 高度方向每块砖高1单位（1.2cm，包含凸点）
5. 如果是文字（如"失"），用砖块拼出笔画形状
6. 尽量使用2x4和2x2砖块，少用1x1
7. 颜色要丰富，让模型看起来生动
"""

USER = "请生成以下描述的乐高模型结构：红色小球"

def call(model):
    data = {"model": model, "prompt": SYSTEM + "\n\n" + USER, "stream": False}
    req = urllib.request.Request("http://localhost:11434/api/generate",
        data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        res = json.loads(r.read().decode())
    return res.get("response", "")

for m in ["llama3:latest", "qwen3.5:9b"]:
    print("=" * 60)
    print("MODEL:", m)
    print("=" * 60)
    try:
        out = call(m)
        print("RAW LENGTH:", len(out))
        print(out[:2500])
    except Exception as e:
        print("ERROR:", repr(e))
    print()
