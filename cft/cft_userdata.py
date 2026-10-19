"""用户自定义数据（标签 / 简介 / 封面）。

与 C 站数据**严格分离**：这些是用户自己写的东西，存在 lora 同目录的
``<base>.cft-user.json`` 里（``<base>`` = lora 文件名去掉扩展名）。
刷新 C 站信息（:func:`cft_civitai.save_civitai_info`）只写 ``.civitai.info``，
绝不会碰这个文件 —— 因此刷新永远不会覆盖用户的自定义内容。

文件格式（字段名固定，前端按此读取）::

    {
      "version": 1,
      "tags": ["我的标签", "风格"],
      "note": "自己写的简介，可多行",
      "favorite": false,
      "cover": {
        "kind": "downloaded",          # remote | downloaded
        "url": "https://image.civitai.com/....jpeg",
        "type": "image",               # image | video
        "backup": "x.preview.bak.png", # 覆盖前的原预览图备份（仅 downloaded）
        "set_at": 1792083355.2
      },
      "updated_at": 1792083355.2
    }

安全约束（与 :mod:`cft_cleanup` 一致）：
- 所有路径 realpath 后必须落在 :func:`cft_config.resolve_loras_dirs()` 之内；
- 目标 lora 必须由 :func:`cft_metadata.resolve_lora_path` 解析出真实文件，
  绝不把用户输入直接拼进路径。

import 约束：本模块可以 import ``cft_metadata`` / ``cft_cleanup`` / ``cft_civitai`` /
``cft_config``；反过来这三个模块**不要** import 本模块（避免循环依赖），
需要时在函数内部做局部 import。
"""

from __future__ import annotations

import json
import os
import shutil
import time
from typing import Any, Dict, List, Optional

from . import cft_civitai, cft_cleanup, cft_config, cft_metadata

__all__ = [
    "SUFFIX",
    "user_path",
    "read",
    "write",
    "set_cover",
    "clear_cover",
    "download_cover",
    "list_user_tags",
    "scan_user_data",
]

# 用户数据文件名后缀：<base>.cft-user.json
SUFFIX = ".cft-user.json"

VERSION = 1

# 下载封面时的超时（秒）
_DOWNLOAD_TIMEOUT = 30


# ---------------------------------------------------------------- 基础工具


def _default() -> Dict[str, Any]:
    """不存在 / 损坏时的默认形态（绝不抛异常）。"""
    return {"tags": [], "note": "", "cover": None, "favorite": False, "exists": False}


def _strip_ext(file_name: str) -> str:
    return cft_metadata._strip_lora_ext(file_name)


def _safe_read_json(path: str) -> Optional[Dict[str, Any]]:
    """读 JSON，任何异常（不存在 / 损坏 / 编码）都返回 None。"""
    if not path:
        return None
    for enc in ("utf-8-sig", "utf-8", "gbk", "latin-1"):
        try:
            with open(path, "r", encoding=enc) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except UnicodeDecodeError:
            continue
        except Exception:
            return None
    return None


def _atomic_write_json(path: str, payload: Dict[str, Any]) -> None:
    """临时文件 + os.replace 原子替换，UTF-8，不转义中文，缩进 2。"""
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _norm_tags(tags: Any) -> List[str]:
    """标签归一化：去空、去重（保持首次出现顺序）。"""
    out: List[str] = []
    seen = set()
    if isinstance(tags, str):
        tags = [t for t in tags.replace("\n", ",").split(",")]
    if not isinstance(tags, (list, tuple)):
        return out
    for t in tags:
        s = str(t).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _require_path(rel_name: str) -> str:
    """解析出真实 lora 绝对路径；非法 / 不存在时抛 ValueError。"""
    abs_path = cft_metadata.resolve_lora_path(rel_name)
    if not abs_path:
        raise ValueError(f"找不到 Lora：{rel_name}")
    if not cft_cleanup.is_safe_path(abs_path):
        raise ValueError("路径不在 lora 目录内，已拒绝")
    return abs_path


def user_path(rel_name: str) -> Optional[str]:
    """返回该 lora 的用户数据文件路径（lora 不存在 / 非法时为 None）。"""
    try:
        abs_path = _require_path(rel_name)
    except ValueError:
        return None
    directory = os.path.dirname(abs_path)
    return os.path.join(directory, _strip_ext(os.path.basename(abs_path)) + SUFFIX)


def _shape(
    tags: List[str],
    note: str,
    cover: Optional[Dict[str, Any]],
    exists: bool,
    favorite: bool = False,
) -> Dict[str, Any]:
    return {"tags": tags, "note": note, "cover": cover, "favorite": bool(favorite), "exists": exists}


def _read_at(path: Optional[str]) -> Dict[str, Any]:
    """从已知路径读取并归一成对外形态。"""
    raw = _safe_read_json(path) if path else None
    if not isinstance(raw, dict):
        return _default()
    cover = raw.get("cover")
    return _shape(
        _norm_tags(raw.get("tags")),
        str(raw.get("note") or ""),
        cover if isinstance(cover, dict) else None,
        True,
        bool(raw.get("favorite")),
    )


# ---------------------------------------------------------------- 读 / 写


def read(rel_name: str) -> Dict[str, Any]:
    """读某 lora 的自定义数据。

    文件不存在 / JSON 损坏 / 路径非法时返回默认形态，**绝不抛异常**
    （扫描 374 个 lora 时会逐条调用）。
    """
    return _read_at(user_path(rel_name))


def write(
    rel_name: str,
    *,
    tags: Optional[List[str]] = None,
    note: Optional[str] = None,
    cover: Optional[Dict[str, Any]] = None,
    favorite: Optional[bool] = None,
) -> Dict[str, Any]:
    """部分更新：只写传入的字段，未传的（None）保持原值。返回写后的完整数据。"""
    abs_path = _require_path(rel_name)
    path = os.path.join(os.path.dirname(abs_path), _strip_ext(os.path.basename(abs_path)) + SUFFIX)

    current = _safe_read_json(path)
    if not isinstance(current, dict):
        current = {}

    if tags is not None:
        current["tags"] = _norm_tags(tags)
    if note is not None:
        current["note"] = str(note)
    if cover is not None:
        current["cover"] = cover
    # 收藏：只在这一项被显式调用时才写（None = 本次不改，保持原值）
    if favorite is not None:
        current["favorite"] = bool(favorite)

    current.setdefault("tags", [])
    current.setdefault("note", "")
    current.setdefault("cover", None)
    current.setdefault("favorite", False)
    current["version"] = VERSION
    current["updated_at"] = time.time()

    _atomic_write_json(path, current)
    return _read_at(path)


# ---------------------------------------------------------------- 封面


def _cover_paths(abs_path: str) -> Dict[str, str]:
    directory = os.path.dirname(abs_path)
    base = _strip_ext(os.path.basename(abs_path))
    return {
        "png": os.path.join(directory, base + ".preview.png"),
        "mp4": os.path.join(directory, base + ".preview.mp4"),
        "bak": os.path.join(directory, base + ".preview.bak.png"),
        "user": os.path.join(directory, base + SUFFIX),
    }


def download_cover(rel_name: str, url: str, is_video: bool = False) -> str:
    """下载封面并落地。

    - 图片存 ``<base>.preview.png``；视频存 ``<base>.preview.mp4``（不写成 .png）。
    - 覆盖前若已存在 ``<base>.preview.png`` 且不是我们自己下载的，先备份成
      ``<base>.preview.bak.png``。
    - 下载失败**抛异常**（由路由层转 400）。返回写入的文件名。
    """
    abs_path = _require_path(rel_name)
    url = str(url or "").strip()
    if not url:
        raise ValueError("url 为空")

    is_video = bool(is_video) or url.split("?")[0].lower().endswith(".mp4")
    paths = _cover_paths(abs_path)

    # 覆盖前备份（只备份一次：已有 .bak 就不动它，避免把原始预览图覆盖掉）
    if not is_video:
        existing = _safe_read_json(paths["user"])
        owned = (
            isinstance(existing, dict)
            and isinstance(existing.get("cover"), dict)
            and existing["cover"].get("kind") == "downloaded"
        )
        if os.path.isfile(paths["png"]) and not owned and not os.path.isfile(paths["bak"]):
            try:
                shutil.copy2(paths["png"], paths["bak"])
            except OSError:
                pass

    session = cft_civitai._build_session()
    resp = session.get(url, timeout=_DOWNLOAD_TIMEOUT)
    if getattr(resp, "status_code", 200) >= 400:
        raise RuntimeError(f"下载封面失败：HTTP {resp.status_code}")
    content = resp.content
    if not content:
        raise RuntimeError("下载封面失败：响应为空")

    out_path = paths["mp4"] if is_video else paths["png"]
    tmp = out_path + ".part"
    try:
        with open(tmp, "wb") as f:
            f.write(content)
        os.replace(tmp, out_path)
    finally:
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return os.path.basename(out_path)


def set_cover(rel_name: str, url: str, kind: str = "remote", is_video: bool = False) -> Dict[str, Any]:
    """写入 cover 字段。``kind == "downloaded"`` 时同时把封面下载到本地。"""
    url = str(url or "").strip()
    if not url:
        raise ValueError("url 为空")

    abs_path = _require_path(rel_name)
    paths = _cover_paths(abs_path)
    is_video = bool(is_video) or url.split("?")[0].lower().endswith(".mp4")

    cover: Dict[str, Any] = {
        "kind": "downloaded" if kind == "downloaded" else "remote",
        "url": url,
        "type": "video" if is_video else "image",
        "set_at": time.time(),
    }

    if cover["kind"] == "downloaded":
        download_cover(rel_name, url, is_video=is_video)
        if os.path.isfile(paths["bak"]):
            cover["backup"] = os.path.basename(paths["bak"])

    return write(rel_name, cover=cover)


def clear_cover(rel_name: str) -> Dict[str, Any]:
    """删除 cover 记录。

    若原 cover 是 ``downloaded`` 且记了 ``backup``，把 ``<base>.preview.png``
    还原成备份内容（还原后 :func:`cft_metadata.find_preview` 必须能重新找到预览图）；
    另外把 ``<base>.preview.mp4`` 视频封面一并删掉。
    """
    abs_path = _require_path(rel_name)
    paths = _cover_paths(abs_path)

    current = _safe_read_json(paths["user"])
    cover = current.get("cover") if isinstance(current, dict) and isinstance(current.get("cover"), dict) else {}

    # 视频封面：直接删掉
    if os.path.isfile(paths["mp4"]):
        try:
            os.remove(paths["mp4"])
        except OSError:
            pass

    # 还原被覆盖的预览图
    backup_name = cover.get("backup")
    if cover.get("kind") == "downloaded" and backup_name:
        bak = os.path.join(os.path.dirname(abs_path), os.path.basename(str(backup_name)))
        if os.path.isfile(bak):
            try:
                shutil.copy2(bak, paths["png"])
            except OSError:
                pass

    payload = current if isinstance(current, dict) else {}
    payload.setdefault("tags", [])
    payload.setdefault("note", "")
    payload["cover"] = None
    payload["version"] = VERSION
    payload["updated_at"] = time.time()
    _atomic_write_json(paths["user"], payload)
    return _read_at(paths["user"])


# ---------------------------------------------------------------- 全量扫描


def scan_user_data() -> Dict[str, Dict[str, Any]]:
    """一次遍历返回全部 ``{lora_rel_name: user_dict}``。

    供 :func:`cft_metadata.scan_loras` 复用，避免每条 lora 都 stat 磁盘。
    只对确实存在 ``.cft-user.json`` 的目录做读取，正常情况文件极少。
    """
    out: Dict[str, Dict[str, Any]] = {}
    for root in cft_config.resolve_loras_dirs():
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            # 先建「base(小写) -> lora 真名」索引，避免再 stat
            lora_by_base: Dict[str, str] = {}
            for fn in filenames:
                if fn.startswith("."):
                    continue
                if fn.lower().endswith(cft_metadata._LORA_EXTS):
                    lora_by_base[_strip_ext(fn).lower()] = fn
            for fn in filenames:
                if not fn.lower().endswith(SUFFIX):
                    continue
                base = fn[: -len(SUFFIX)]
                real = lora_by_base.get(base.lower())
                if not real:
                    continue
                abs_path = os.path.join(dirpath, real)
                if not cft_cleanup.is_safe_path(abs_path):
                    continue
                try:
                    rel = os.path.relpath(abs_path, root).replace("\\", "/")
                except ValueError:
                    continue
                out[rel] = _read_at(os.path.join(dirpath, fn))
    return out


def list_user_tags() -> List[str]:
    """汇总所有自定义标签，去重 + 排序，供前端做标签筛选。"""
    tags = set()
    for data in scan_user_data().values():
        for t in data.get("tags") or []:
            s = str(t).strip()
            if s:
                tags.add(s)
    return sorted(tags)
