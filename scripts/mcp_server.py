#!/usr/bin/env python3
"""
Quest3 / BlenderMCP fusion - local MCP server (stdio, JSON-RPC 2.0).

This is a self-contained Model Context Protocol server (no external deps,
only the Python standard library) that talks to the Blender addon
(scripts/blender_mcp_addon.py) over its TCP socket (default localhost:9876)
and exposes the fused capabilities as MCP *tools*:

  Scene understanding
    - get_scene_graph          full object hierarchy + world transforms/AABB
    - get_scene_info           lightweight scene summary
    - get_object_info          details for a single object
    - get_blender_info         Blender / addon environment info

  Multi-view capture
    - get_viewport_screenshot  single editor-region screenshot
    - get_viewport_screenshots multi-angle off-screen product renders

  Assembly intelligence (glonorce/Blender_mcp fusion)
    - analyze_assembly         part stats, interface gaps, mesh interference,
                               and a 0-100 production-readiness score
    - get_assembly_sequence    suggested disassembly order

  Diagnostics / scripting
    - get_addon_status         capability + external-service status
    - execute_code             run arbitrary Blender Python (escape hatch)

The image-to-3D (Hunyuan3D / Rodin) commands already live in the addon and
remain reachable through `execute_code` if needed.

Wire it up by pointing your MCP client (e.g. .mcp.json) at this script:
    { "mcpServers": { "blender": { "command": "python3",
        "args": ["scripts/mcp_server.py"] } } }

Env:
    BLENDERMCP_HOST   (default localhost)
    BLENDERMCP_PORT   (default 9876)
    BLENDERMCP_TIMEOUT (default 300 seconds, for long jobs)
"""

import os
import sys
import json
import socket
import threading

HOST = os.environ.get("BLENDERMCP_HOST", "localhost")
PORT = int(os.environ.get("BLENDERMCP_PORT", "9876"))
TIMEOUT = float(os.environ.get("BLENDERMCP_TIMEOUT", "300"))


# --------------------------------------------------------------------------
# Blender addon client (TCP, newline-delimited JSON request/response)
# --------------------------------------------------------------------------

def call_addon(command_type, params=None, timeout=TIMEOUT):
    """Send a single command to the Blender addon and return the parsed JSON
    response. The addon sends exactly one JSON response per command."""
    payload = json.dumps({"type": command_type, "params": params or {}}).encode("utf-8")
    sock = socket.create_connection((HOST, PORT), timeout=timeout)
    try:
        sock.settimeout(timeout)
        sock.sendall(payload + b"\n")
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
                # Response not complete yet; keep reading.
                continue
        if not buf:
            raise RuntimeError("No response from Blender addon (is it running?)")
        return json.loads(buf.decode("utf-8"))
    finally:
        try:
            sock.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Tool definitions (MCP tools/list)
# --------------------------------------------------------------------------

TOOLS = [
    {
        "name": "get_blender_info",
        "description": "Blender version, addon version, current scene and object count, unit settings.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_addon_status",
        "description": "Aggregated capability flags and external-service (PolyHaven/Hyper3D/Sketchfab/Hunyuan3D) status for diagnostics.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_scene_graph",
        "description": "Build a hierarchical scene graph (parent->children) with world transforms, world AABB, vertex/poly counts and material names.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "max_depth": {"type": "integer", "description": "Recursion depth limit (0 = root objects only)", "default": 20},
                "include_hidden": {"type": "boolean", "description": "Include hidden objects", "default": False},
                "include_materials": {"type": "boolean", "description": "Include material slot names", "default": True},
            },
        },
    },
    {
        "name": "get_scene_info",
        "description": "Lightweight scene summary (name, object count, first 10 objects).",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_object_info",
        "description": "Details for a single named object.",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "Object name"}},
            "required": ["name"],
        },
    },
    {
        "name": "get_viewport_screenshot",
        "description": "Capture the current 3D viewport region to a PNG file.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filepath": {"type": "string", "description": "Output PNG path (required)"},
                "max_size": {"type": "integer", "default": 800},
                "format": {"type": "string", "default": "png"},
            },
            "required": ["filepath"],
        },
    },
    {
        "name": "get_viewport_screenshots",
        "description": "Render the scene from multiple standard viewpoints (front/back/left/right/top/bottom/perspective) to PNG files. Returns file paths (optionally base64).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "views": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["front", "back", "left", "right", "top", "bottom", "perspective"]},
                    "description": "Views to render (default: all)",
                },
                "max_size": {"type": "integer", "default": 512, "description": "Longest-edge resolution cap"},
                "return_base64": {"type": "boolean", "default": False, "description": "Embed base64 PNG data in the response"},
            },
        },
    },
    {
        "name": "analyze_assembly",
        "description": "Assembly intelligence: per-part geometry stats, pairwise interface gaps, real mesh interference (BVH), and a 0-100 production-readiness score with recommendations.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tolerance": {"type": "number", "default": 0.001, "description": "Max AABB gap still considered 'touching' (world units)"},
            },
        },
    },
    {
        "name": "get_assembly_sequence",
        "description": "Suggest a disassembly order for the scene's mesh parts. method: distance (inner last) | size (smallest first) | hierarchy (deepest last).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "method": {"type": "string", "enum": ["distance", "size", "hierarchy"], "default": "distance"},
            },
        },
    },
    {
        "name": "execute_code",
        "description": "Execute arbitrary Blender Python code in the addon. Escape hatch for any command not exposed as a dedicated tool.",
        "inputSchema": {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "Blender Python code to run"}},
            "required": ["code"],
        },
    },
    # ---- Image-to-3D (Hunyuan3D / Rodin) — free-form params, addon-side ----
    {
        "name": "create_hunyuan_job",
        "description": "Start a Tencent Hunyuan3D image-to-3D job (requires Hunyuan3D enabled in the addon). Params vary (image path/url, mode, octree...).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
    },
    {
        "name": "poll_hunyuan_job_status",
        "description": "Poll a Hunyuan3D job's status by job_id.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
    },
    {
        "name": "import_generated_asset_hunyuan",
        "description": "Import the generated Hunyuan3D GLB/zip into the current scene.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
    },
    {
        "name": "create_rodin_job",
        "description": "Start a Hyper3D Rodin image-to-3D job (requires Hyper3D/Rodin enabled in the addon).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
    },
    {
        "name": "poll_rodin_job_status",
        "description": "Poll a Rodin job's status by subscription key / request id.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
    },
    {
        "name": "import_generated_asset",
        "description": "Import a generated Rodin asset into the current scene.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
    },
]

# Map tool name -> addon command type
TOOL_COMMAND = {
    "get_blender_info": "get_blender_info",
    "get_addon_status": "get_addon_status",
    "get_scene_graph": "get_scene_graph",
    "get_scene_info": "get_scene_info",
    "get_object_info": "get_object_info",
    "get_viewport_screenshot": "get_viewport_screenshot",
    "get_viewport_screenshots": "get_viewport_screenshots",
    "analyze_assembly": "analyze_assembly",
    "get_assembly_sequence": "get_assembly_sequence",
    "execute_code": "execute_code",
    "create_hunyuan_job": "create_hunyuan_job",
    "poll_hunyuan_job_status": "poll_hunyuan_job_status",
    "import_generated_asset_hunyuan": "import_generated_asset_hunyuan",
    "create_rodin_job": "create_rodin_job",
    "poll_rodin_job_status": "poll_rodin_job_status",
    "import_generated_asset": "import_generated_asset",
}


# --------------------------------------------------------------------------
# MCP JSON-RPC over stdio (LSP-style Content-Length framing)
# --------------------------------------------------------------------------

def _write_message(msg):
    data = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(data))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def _read_message(stream):
    """Read a single framed JSON-RPC message from a binary stream."""
    # Read headers
    headers = {}
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.decode("utf-8")
        if line in ("\r\n", "\n", ""):
            break
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    length = int(headers.get("content-length", "0"))
    if length <= 0:
        return None
    body = b""
    while len(body) < length:
        chunk = stream.read(min(length - len(body), 65536))
        if not chunk:
            return None
        body += chunk
    return json.loads(body.decode("utf-8"))


def _text_result(result):
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
    return {"content": [{"type": "text", "text": text}], "isError": False}


def _error_result(message):
    return {"content": [{"type": "text", "text": str(message)}], "isError": True}


def _handle_request(req):
    method = req.get("method")
    msg_id = req.get("id")
    params = req.get("params", {}) or {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "blender-mcp-fusion", "version": "1.3.0"},
            },
        }
    if method == "notifications/initialized":
        return None  # notification, no response
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments", {}) or {}
        cmd = TOOL_COMMAND.get(name)
        if not cmd:
            return {"jsonrpc": "2.0", "id": msg_id, "result": _error_result(f"Unknown tool: {name}")}
        try:
            raw = call_addon(cmd, arguments)
        except Exception as e:
            return {"jsonrpc": "2.0", "id": msg_id, "result": _error_result(f"Addon call failed: {e}")}
        # The addon returns {"status": "success"/"error", "result": ...}
        if isinstance(raw, dict) and raw.get("status") == "error":
            return {"jsonrpc": "2.0", "id": msg_id, "result": _error_result(raw.get("message", "addon error"))}
        payload = raw.get("result", raw) if isinstance(raw, dict) else raw
        return {"jsonrpc": "2.0", "id": msg_id, "result": _text_result(payload)}

    # Unknown method -> method not found
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    stdin = sys.stdin.buffer
    # Some clients send a bare line; guard against blocking on text-mode.
    while True:
        try:
            req = _read_message(stdin)
        except Exception as e:
            err = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {e}"}}
            _write_message(err)
            continue
        if req is None:
            break  # stream closed
        resp = _handle_request(req)
        if resp is not None:
            _write_message(resp)


if __name__ == "__main__":
    main()
