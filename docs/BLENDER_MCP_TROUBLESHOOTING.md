# Blender MCP 排障指南

Blender MCP 由两层组成：

1. **Blender 插件** `scripts/blender_mcp_addon.py`：在 Blender 内部运行，监听 TCP `127.0.0.1:9876`（默认端口，可用环境变量 `BLENDERMCP_PORT` 修改）。
2. **MCP 服务** `scripts/mcp_server.py`：通过 stdio 被 MCP 客户端（Claude / CodeBuddy / 等）拉起，再代理到 `127.0.0.1:9876` 与插件通信。

> 项目 `.mcp.json` 提供两个入口：`blender`（uvx `blender-mcp`）与 `blender-fusion`（`scripts/mcp_server.py`），二者默认都连 `localhost:9876`。

---

## 症状

- MCP 工具（如生成模型、获取场景信息、图片转 3D）调用失败 / 超时 / 报错。
- 直接连 `localhost:9876` 时收到 HTTP 响应（如 `<!DOCTYPE html>...Error code: 400`），而不是 JSON。

## 根因：端口 9876 被其它进程占用

Blender 插件只监听 **IPv4 `127.0.0.1:9876`**。若另有进程（常见于误起的 `python3 -m http.server 9876`、或另一个 blender-mcp 实例）绑定在 **IPv6 `*:9876`**，则 macOS 上 `localhost` 优先解析到 IPv6 `::1`，MCP 客户端连 `localhost:9876` 会命中那个错误进程，而非 Blender 插件。

> 用 `127.0.0.1` 直连能正常命中 Blender，但用 `localhost`（`.mcp.json` 默认值）会连错——这是最典型的"忽好忽坏"来源。

---

## 诊断

检查 9876 端口上的监听者（应只有 Blender）：

```bash
lsof -iTCP:9876 -sTCP:LISTEN -n -P
```

期望结果（仅 Blender，无其它进程）：

```
COMMAND   PID   USER   ...  NAME
Blender  <pid> a1-6   ...  TCP 127.0.0.1:9876 (LISTEN)
```

若出现 `python3 -m http.server 9876` 或第二个监听者，即为冲突源。

实测插件是否真正响应（只读命令，安全）：

```bash
python3 - <<'PY'
import socket, json
s = socket.create_connection(("127.0.0.1", 9876), timeout=8)  # 用 127.0.0.1 排除 IPv6 干扰
s.settimeout(8)
s.sendall(json.dumps({"type":"get_scene_info","params":{}}).encode()+b"\n")
buf=b""
while True:
    c=s.recv(65536)
    if not c: break
    buf+=c
    try: json.loads(buf); break
    except Exception:
        if len(buf)>20: break
s.close()
d=json.loads(buf)
print("status =", d.get("status"), "| objects =", d.get("result",{}).get("object_count"))
PY
```

- `status = success` → 插件正常。
- 返回 HTML / HTTP 400 → 连到了错误进程。

---

## 修复

### 方案 A（推荐）：清掉占用 9876 的冲突进程

```bash
# 查看占用端口的 PID
lsof -tiTCP:9876
# 终止（确认是误起的 http.server 等无关进程后再执行）
lsof -tiTCP:9876 | xargs -r kill
```

清掉后，9876 上只剩 Blender 插件，`localhost` 即回归到正确目标。

### 方案 B（不改进程，仅本项目 MCP）：强制走 IPv4

编辑 `.mcp.json`，把 `blender-fusion` 的 `BLENDERMCP_HOST` 改为 `127.0.0.1`：

```json
"blender-fusion": {
  "command": "python3",
  "args": ["scripts/mcp_server.py"],
  "env": { "BLENDERMCP_HOST": "127.0.0.1", "BLENDERMCP_PORT": "9876", "BLENDERMCP_TIMEOUT": "300" }
}
```

> 注意：方案 B 只修复 `blender-fusion` 入口；若还用 uvx `blender-mcp`，其 host 需另行指定为 `127.0.0.1`，否则仍可能连错。

---

## 验证

修复后再次用 `localhost`（而非 `127.0.0.1`）跑上面的诊断脚本，应得到 `status = success`。同时在 MCP 客户端调用任意 Blender 工具确认可用。
