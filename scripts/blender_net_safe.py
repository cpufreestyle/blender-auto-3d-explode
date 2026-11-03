#!/usr/bin/env python3
"""出站 URL / 路径安全校验共享模块（纯 stdlib，无 bpy 依赖）。

供各 Blender/CLI 脚本通过文件路径导入——Blender --python 不会把脚本目录加进
sys.path，调用方用 importlib 按 __file__ 定位本模块（见各脚本的加载段）。
语义与各脚本原内联版本一致；安全逻辑只此一份，修改时不再同步 9 处副本。
"""

import ipaddress
import urllib.parse
import urllib.request


def _safe_url(url, allow_private=False):
    """出站 URL 边界校验：仅 http(s)、无凭证段、IP 字面量边界（非全局 IP 需豁免）。"""
    u = urllib.parse.urlparse(str(url))
    scheme = (u.scheme or "").lower()
    host = (u.hostname or "").lower()
    if scheme not in ("http", "https") or not host:
        raise ValueError(f"出站 URL 协议/主机不合规：{url}")
    if u.username or u.password:
        raise ValueError(f"出站 URL 含凭证段：{url}")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ValueError(f"链路本地/保留地址拒绝：{url}")
        if not ip.is_global and not allow_private:
            raise ValueError(f"非全局 IP 默认拒绝：{url}")
    return url


def _safe_path(p):
    """路径清洗：拒绝含父目录穿越段的写法（规范化绝对路径放行），返回 realpath。"""
    import os
    from pathlib import PurePath
    if p is None:
        raise ValueError("路径为空")
    s = str(p)
    if ".." in PurePath(s).parts:
        raise ValueError(f"路径不允许包含父目录穿越段：{s}")
    return os.path.realpath(os.path.abspath(os.path.expanduser(s)))


def _open_url(req, timeout=None):
    """打开出站 URL：同函数内完成协议/凭证/保留地址校验后再请求。"""
    _u = urllib.parse.urlparse(str(req.full_url))
    _h = (_u.hostname or "").lower()
    if (_u.scheme or "").lower() not in ("http", "https") or not _h or _u.username or _u.password:
        raise ValueError(f"出站 URL 协议/凭证段不合规：{req.full_url}")
    try:
        _ip = ipaddress.ip_address(_h)
    except ValueError:
        _ip = None
    if _ip is not None and (_ip.is_link_local or _ip.is_reserved or _ip.is_multicast):
        raise ValueError(f"链路本地/保留地址拒绝：{req.full_url}")
    return urllib.request.urlopen(req, timeout=timeout)
