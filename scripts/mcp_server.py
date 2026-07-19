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

The image-to-3D (Hunyuan3D / Rodin / Hyper3D) commands already live in the
addon and remain reachable through `execute_code` if needed. External
3D-generation providers (Meshy, Tripo) are implemented directly here as MCP
tools (create -> poll -> import) so they can be driven from a CUI without
Blender running, and the final import lands the model in the live scene via
the addon's `import_glb_from_file` command.

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
import urllib.request
import urllib.error

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
# External 3D-generation provider clients (Meshy / Tripo / Hyper3D)
#
# These talk directly to each vendor's REST API using only the Python
# standard library (urllib), so the MCP tools work even when Blender is
# not running. The final "import" step downloads the generated GLB to a
# temp file and hands it to Blender via the `import_glb_from_file` addon
# command, so the model lands directly in the live scene (联动).
# --------------------------------------------------------------------------

MESHY_BASE = "https://api.meshy.ai/openapi/v1"
TRIPO_BASE = "https://openapi.tripo3d.ai/v3"


def _api_call(method, url, *, headers=None, json_body=None, timeout=600):
    """Minimal JSON HTTP client built on urllib (stdlib only)."""
    data = json.dumps(json_body).encode("utf-8") if json_body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if json_body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw.decode("utf-8")) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {e.code} {method} {url}: {raw[:400]}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error {method} {url}: {e.reason}")


def _download(url, dest, timeout=600):
    req = urllib.request.Request(url, headers={"User-Agent": "blender-mcp"})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    return dest


def _key(arg_key, env_var, arguments):
    """API key resolution: explicit argument > environment variable."""
    return (arguments.get(arg_key) or os.environ.get(env_var) or "").strip()


def _import_downloaded(model_url, name, prefix):
    if not model_url:
        return {"error": "model_url required — poll the job to completion first"}
    tmp = tempfile.NamedTemporaryFile(delete=False, prefix=f"{prefix}_", suffix=".glb")
    tmp.close()
    _download(model_url, tmp.name)
    return call_addon("import_glb_from_file", {"filepath": tmp.name, "name": name or prefix})


# ---- Meshy ---------------------------------------------------------------
def create_meshy_job(arguments):
    api_key = _key("api_key", "MESHY_API_KEY", arguments)
    if not api_key:
        return {"error": "Meshy API key required (pass `api_key` or set MESHY_API_KEY)"}
    prompt = arguments.get("prompt")
    image_url = arguments.get("image_url")
    if image_url:
        endpoint, body, kind = f"{MESHY_BASE}/image-to-3d", {"image_url": image_url, "should_texture": True, "enable_pbr": True}, "image-to-3d"
    elif prompt:
        endpoint, body, kind = f"{MESHY_BASE}/text-to-3d", {"prompt": prompt}, "text-to-3d"
    else:
        return {"error": "Provide either `image_url` (image-to-3D) or `prompt` (text-to-3D)"}
    _, data = _api_call("POST", endpoint, headers={"Authorization": f"Bearer {api_key}"}, json_body=body)
    task_id = data.get("result") or data.get("task_id") or data.get("id")
    if not task_id:
        return {"error": "Meshy did not return a task id", "raw": data}
    return {"task_id": task_id, "type": kind}


def poll_meshy_job(arguments):
    api_key = _key("api_key", "MESHY_API_KEY", arguments)
    task_id = arguments.get("task_id")
    if not task_id:
        return {"error": "task_id required"}
    kind = arguments.get("type", "image-to-3d")
    _, data = _api_call("GET", f"{MESHY_BASE}/{kind}/{task_id}", headers={"Authorization": f"Bearer {api_key}"})
    status = data.get("status")
    out = {"status": status, "progress": data.get("progress")}
    if status == "SUCCEEDED":
        urls = data.get("model_urls") or {}
        out["model_url"] = urls.get("glb") or data.get("model_url")
    return out


def import_meshy_asset(arguments):
    return _import_downloaded(arguments.get("model_url"), arguments.get("name", "meshy_model"), "meshy")


# ---- Tripo (Triple 3D) ---------------------------------------------------
def create_tripo_job(arguments):
    api_key = _key("api_key", "TRIPO_API_KEY", arguments)
    if not api_key:
        return {"error": "Tripo API key required (pass `api_key` or set TRIPO_API_KEY)"}
    prompt = arguments.get("prompt")
    image_url = arguments.get("image_url")
    if image_url:
        endpoint, body = f"{TRIPO_BASE}/generation/image-to-model", {"file_token": image_url, "model": arguments.get("model", "P1-20260311")}
    elif prompt:
        endpoint, body = f"{TRIPO_BASE}/generation/text-to-model", {"prompt": prompt, "model": arguments.get("model", "tripo-v3.1")}
    else:
        return {"error": "Provide either `image_url` (image-to-model) or `prompt` (text-to-model)"}
    _, data = _api_call("POST", endpoint, headers={"Authorization": f"Bearer {api_key}"}, json_body=body)
    task_id = (data.get("data") or {}).get("task_id") or data.get("task_id")
    if not task_id:
        return {"error": "Tripo did not return a task id", "raw": data}
    return {"task_id": task_id}


def poll_tripo_job(arguments):
    api_key = _key("api_key", "TRIPO_API_KEY", arguments)
    task_id = arguments.get("task_id")
    if not task_id:
        return {"error": "task_id required"}
    _, data = _api_call("GET", f"{TRIPO_BASE}/tasks/{task_id}", headers={"Authorization": f"Bearer {api_key}"})
    d = data.get("data", data)
    status = d.get("status")
    out = {"status": status, "progress": d.get("progress")}
    if status == "success":
        outp = d.get("output") or {}
        out["model_url"] = outp.get("model_url") or outp.get("pbr_model")
    return out


def import_tripo_asset(arguments):
    return _import_downloaded(arguments.get("model_url"), arguments.get("name", "tripo_model"), "tripo")


# MCP tools implemented directly in this server (no Blender addon needed
# for create/poll; import bridges into Blender via import_glb_from_file).
LOCAL_TOOLS = {
    "create_meshy_job": create_meshy_job,
    "poll_meshy_job": poll_meshy_job,
    "import_meshy_asset": import_meshy_asset,
    "create_tripo_job": create_tripo_job,
    "poll_tripo_job": poll_tripo_job,
    "import_tripo_asset": import_tripo_asset,
}


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
    # ---- External 3D generation providers (Meshy / Tripo / Hyper3D) ----
    {
        "name": "create_meshy_job",
        "description": "Start a Meshy AI 3D generation job. Pass image_url (image-to-3D) or prompt (text-to-3D) and an api_key (or set MESHY_API_KEY). Returns task_id + type.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "description": "Meshy API key (msy-...). Falls back to env MESHY_API_KEY."},
                "prompt": {"type": "string", "description": "Text prompt for text-to-3D"},
                "image_url": {"type": "string", "description": "Public image URL for image-to-3D"},
            },
        },
    },
    {
        "name": "poll_meshy_job",
        "description": "Poll a Meshy job by task_id. Returns status/progress and model_url when SUCCEEDED.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "description": "Meshy API key (optional if set via env)"},
                "task_id": {"type": "string", "description": "Task id from create_meshy_job"},
                "type": {"type": "string", "default": "image-to-3d", "description": "image-to-3d or text-to-3d"},
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "import_meshy_asset",
        "description": "Download a finished Meshy GLB and import it into the current Blender scene.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "model_url": {"type": "string", "description": "GLB url from poll_meshy_job"},
                "name": {"type": "string", "default": "meshy_model", "description": "Name for the imported object"},
            },
            "required": ["model_url"],
        },
    },
    {
        "name": "create_tripo_job",
        "description": "Start a Tripo (Triple 3D) generation job. Pass image_url (image-to-model) or prompt (text-to-model) and an api_key (or set TRIPO_API_KEY). Returns task_id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "description": "Tripo API key. Falls back to env TRIPO_API_KEY."},
                "prompt": {"type": "string", "description": "Text prompt for text-to-model"},
                "image_url": {"type": "string", "description": "Public image URL or file token for image-to-model"},
                "model": {"type": "string", "description": "Model version (e.g. P1-20260311 / tripo-v3.1)"},
            },
        },
    },
    {
        "name": "poll_tripo_job",
        "description": "Poll a Tripo job by task_id. Returns status/progress and model_url when success.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "api_key": {"type": "string", "description": "Tripo API key (optional if set via env)"},
                "task_id": {"type": "string", "description": "Task id from create_tripo_job"},
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "import_tripo_asset",
        "description": "Download a finished Tripo GLB and import it into the current Blender scene.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "model_url": {"type": "string", "description": "GLB url from poll_tripo_job"},
                "name": {"type": "string", "default": "tripo_model", "description": "Name for the imported object"},
            },
            "required": ["model_url"],
        },
    },
    {
        "name": "import_glb_from_file",
        "description": "Import a local .glb file (path on the Blender machine) into the current scene. Used by external 3D-generation MCP tools to land generated models.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filepath": {"type": "string", "description": "Absolute path to the .glb file"},
                "name": {"type": "string", "description": "Name for the imported object"},
            },
            "required": ["filepath"],
        },
    },
    # ---- Status diagnostics (always available in the addon) ----
    {
        "name": "get_polyhaven_status",
        "description": "PolyHaven integration status (enabled flag, API reachability) for diagnostics.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_hyper3d_status",
        "description": "Hyper3D (Rodin) integration status for diagnostics.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_sketchfab_status",
        "description": "Sketchfab integration status (enabled flag, API key configured) for diagnostics.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_hunyuan3d_status",
        "description": "Hunyuan3D integration status for diagnostics.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_telemetry_consent",
        "description": "Read the current telemetry-consent setting of the Blender MCP addon.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    # ---- PolyHaven assets (requires PolyHaven enabled in the addon) ----
    {
        "name": "get_polyhaven_categories",
        "description": "List PolyHaven categories for an asset type (hdris/textures/models/all).",
        "inputSchema": {
            "type": "object",
            "properties": {"asset_type": {"type": "string", "enum": ["hdris", "textures", "models", "all"], "default": "all"}},
            "required": ["asset_type"],
        },
    },
    {
        "name": "search_polyhaven_assets",
        "description": "Search PolyHaven assets (HDRI/texture/model) with optional type and category filters.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "asset_type": {"type": "string", "enum": ["hdris", "textures", "models", "all"], "description": "Asset type filter"},
                "categories": {"type": "string", "description": "Comma-separated category slugs"},
            },
        },
    },
    {
        "name": "download_polyhaven_asset",
        "description": "Download a PolyHaven asset (HDRI/texture/model) into the scene by asset id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "asset_id": {"type": "string", "description": "PolyHaven asset id"},
                "asset_type": {"type": "string", "enum": ["hdris", "textures", "models"], "description": "Asset type"},
                "resolution": {"type": "string", "default": "1k", "description": "e.g. 1k/2k/4k"},
                "file_format": {"type": "string", "description": "Optional format override (hdr/exr/jpg/png/blend...)"},
            },
            "required": ["asset_id", "asset_type"],
        },
    },
    {
        "name": "set_texture",
        "description": "Apply a downloaded PolyHaven texture to an object (creates a material).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "object_name": {"type": "string", "description": "Target object name in the scene"},
                "texture_id": {"type": "string", "description": "PolyHaven texture asset id"},
            },
            "required": ["object_name", "texture_id"],
        },
    },
    # ---- Sketchfab models (requires Sketchfab enabled in the addon) ----
    {
        "name": "search_sketchfab_models",
        "description": "Search Sketchfab models by query (requires Sketchfab API key configured in the addon).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search keywords"},
                "categories": {"type": "string", "description": "Optional category filter"},
                "count": {"type": "integer", "default": 20},
                "downloadable": {"type": "boolean", "default": True},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_sketchfab_model_preview",
        "description": "Get the thumbnail preview image of a Sketchfab model by its UID.",
        "inputSchema": {
            "type": "object",
            "properties": {"uid": {"type": "string", "description": "Sketchfab model UID"}},
            "required": ["uid"],
        },
    },
    {
        "name": "download_sketchfab_model",
        "description": "Download a Sketchfab model by UID into the scene (optionally normalized to a target size).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "uid": {"type": "string", "description": "Sketchfab model UID"},
                "normalize_size": {"type": "boolean", "default": False},
                "target_size": {"type": "number", "default": 1.0},
            },
            "required": ["uid"],
        },
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
    # Generic GLB import bridge + Hyper3D (Rodin) aliases for CUI linkage
    "import_glb_from_file": "import_glb_from_file",
    "create_hyper3d_job": "create_rodin_job",
    "poll_hyper3d_job": "poll_rodin_job_status",
    "import_hyper3d_asset": "import_generated_asset",
    # ---- Status diagnostics (always available in the addon) ----
    "get_polyhaven_status": "get_polyhaven_status",
    "get_hyper3d_status": "get_hyper3d_status",
    "get_sketchfab_status": "get_sketchfab_status",
    "get_hunyuan3d_status": "get_hunyuan3d_status",
    "get_telemetry_consent": "get_telemetry_consent",
    # ---- PolyHaven assets (requires PolyHaven enabled in the addon) ----
    "get_polyhaven_categories": "get_polyhaven_categories",
    "search_polyhaven_assets": "search_polyhaven_assets",
    "download_polyhaven_asset": "download_polyhaven_asset",
    "set_texture": "set_texture",
    # ---- Sketchfab models (requires Sketchfab enabled in the addon) ----
    "search_sketchfab_models": "search_sketchfab_models",
    "get_sketchfab_model_preview": "get_sketchfab_model_preview",
    "download_sketchfab_model": "download_sketchfab_model",
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
        # Local tools (Meshy / Tripo) run directly in this server.
        local = LOCAL_TOOLS.get(name)
        if local:
            try:
                result = local(arguments)
            except Exception as e:
                return {"jsonrpc": "2.0", "id": msg_id, "result": _error_result(f"{name} failed: {e}")}
            if isinstance(result, dict) and result.get("error"):
                return {"jsonrpc": "2.0", "id": msg_id, "result": _error_result(result["error"])}
            return {"jsonrpc": "2.0", "id": msg_id, "result": _text_result(result)}
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
