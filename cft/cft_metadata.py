"""Lora 资产管理：扫描目录、解析元数据、计算哈希、定位预览图。

本模块不依赖 ComfyUI 运行时，可独立测试。

元数据来源（按可信度排序）：
1. ``<base>.civitai.info``   C 站完整模型版本 JSON（最全）
2. ``<base>.info.json``      C 站精简信息
3. safetensors 文件头 ``__metadata__``（ss_* / modelspec.* 字段）

统一后的数据结构见 :func:`get_lora_detail`。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import struct
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from . import cft_config

__all__ = [
    "scan_loras",
    "get_lora_detail",
    "compute_sha256",
    "resolve_lora_path",
    "find_preview",
    "invalidate_cache",
]

_LORA_EXTS = (".safetensors", ".ckpt", ".pt", ".bin", ".sft")

# sidecar 后缀（按优先级）
_CIVITAI_SIDECARS = (".civitai.info", ".civitai.json")
_SIMPLE_SIDECARS = (".info.json", ".json")
_HASH_SIDECARS = (".cft-hash.json",)

_CACHE_LOCK = threading.RLock()
_SCAN_CACHE: Dict[str, Any] = {"stamp": 0.0, "items": [], "index": {}}
_CACHE_TTL = 20.0  # 秒；避免频繁全盘扫描

_META_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}


# ---------------------------------------------------------------- 工具函数


def _strip_lora_ext(file_name: str) -> str:
    low = file_name.lower()
    for ext in _LORA_EXTS:
        if low.endswith(ext):
            return file_name[: -len(ext)]
    return os.path.splitext(file_name)[0]


def _safe_read_json(path: str) -> Optional[Dict[str, Any]]:
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


def _html_to_text(html: str, limit: int = 1200) -> str:
    """C 站描述是 HTML，转成纯文本便于前端展示。"""
    if not html:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    text = re.sub(r"</p>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:limit]


# ---------------------------------------------------------------- 目录扫描


def _iter_lora_files(root: str):
    """递归遍历 lora 根目录，产出 (绝对路径, 相对路径)。"""
    for dirpath, dirnames, filenames in os.walk(root):
        # 跳过隐藏目录
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.lower().endswith(_LORA_EXTS) and not fn.startswith("."):
                abs_path = os.path.join(dirpath, fn)
                rel_path = os.path.relpath(abs_path, root)
                yield abs_path, rel_path.replace("\\", "/")


def _build_sidecar_index(directory: str) -> Dict[str, str]:
    """一次 scandir 建立「文件名 -> 完整文件名」索引，避免反复 stat。"""
    index: Dict[str, str] = {}
    try:
        with os.scandir(directory) as it:
            for entry in it:
                if entry.is_file():
                    index[entry.name] = entry.name
    except OSError:
        pass
    return index


def _find_sidecar(index: Dict[str, str], file_name: str, suffixes) -> Optional[str]:
    """在索引里查找某类 sidecar 的真实文件名。"""
    base = _strip_lora_ext(file_name)
    for prefix in (base, file_name):
        for suf in suffixes:
            cand = prefix + suf
            if cand in index:
                return cand
    return None


def find_preview(directory: str, file_name: str, index: Optional[Dict[str, str]] = None) -> Optional[str]:
    """查找本地预览图文件名。"""
    idx = index if index is not None else _build_sidecar_index(directory)
    base = _strip_lora_ext(file_name)
    for prefix in (base, file_name):
        for ext in (".preview.png", ".preview.jpg", ".preview.jpeg", ".preview.webp",
                    ".png", ".jpg", ".jpeg", ".webp", ".gif"):
            cand = prefix + ext
            if cand in idx:
                return cand
    return None


# ---------------------------------------------------------------- safetensors


def read_safetensors_metadata(path: str, max_header: int = 32 * 1024 * 1024) -> Dict[str, Any]:
    """读取 safetensors 文件头的 ``__metadata__`` 字段（不加载权重）。"""
    try:
        with open(path, "rb") as f:
            raw_len = f.read(8)
            if len(raw_len) < 8:
                return {}
            header_len = struct.unpack("<Q", raw_len)[0]
            if header_len <= 0 or header_len > max_header:
                return {}
            header = json.loads(f.read(header_len).decode("utf-8", "ignore"))
            meta = header.get("__metadata__") or {}
            if isinstance(meta, dict):
                return {str(k): str(v) for k, v in meta.items()}
    except Exception:
        pass
    return {}


def _extract_training_info(meta: Dict[str, Any]) -> Dict[str, Any]:
    """从 safetensors 头部挑出对用户有价值的训练参数。"""
    keys = {
        "ss_base_model_version": "base_model_version",
        "ss_network_module": "network_module",
        "ss_network_dim": "network_dim",
        "ss_network_alpha": "network_alpha",
        "ss_learning_rate": "learning_rate",
        "ss_unet_lr": "unet_lr",
        "ss_text_encoder_lr": "text_encoder_lr",
        "ss_num_train_images": "train_images",
        "ss_num_epochs": "epochs",
        "ss_max_train_steps": "max_train_steps",
        "ss_resolution": "resolution",
        "ss_clip_skip": "clip_skip",
        "ss_optimizer": "optimizer",
        "ss_noise_offset": "noise_offset",
        "ss_min_snr_gamma": "min_snr_gamma",
        "modelspec.title": "title",
        "modelspec.resolution": "resolution",
        "modelspec.architecture": "architecture",
        "modelspec.description": "description",
        "ss_sd_model_name": "sd_model_name",
        "ss_output_name": "output_name",
        "ss_tag_frequency": "tag_frequency",
        "ss_datasets": "datasets",
    }
    out: Dict[str, Any] = {}
    for src, dst in keys.items():
        val = meta.get(src)
        if val is None or val == "":
            continue
        out[dst] = val

    # tag_frequency 是 JSON 字符串，尝试解析成 {tag: count}，用于推荐触发词
    tf = out.get("tag_frequency")
    if isinstance(tf, str) and tf.strip().startswith("{"):
        try:
            parsed = json.loads(tf)
            merged: Dict[str, int] = {}
            for _dataset, tags in (parsed or {}).items():
                if isinstance(tags, dict):
                    for tag, cnt in tags.items():
                        try:
                            merged[tag] = merged.get(tag, 0) + int(cnt)
                        except (TypeError, ValueError):
                            continue
            if merged:
                out["top_tags"] = sorted(merged.items(), key=lambda kv: kv[1], reverse=True)[:40]
            out.pop("tag_frequency", None)
        except Exception:
            out.pop("tag_frequency", None)
    return out


# ---------------------------------------------------------------- 哈希


def compute_sha256(path: str, chunk: int = 8 * 1024 * 1024) -> Optional[str]:
    """计算文件 SHA256（大文件分块读取）。"""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while True:
                block = f.read(chunk)
                if not block:
                    break
                h.update(block)
        return h.hexdigest().upper()
    except Exception:
        return None


def _cached_sha256(directory: str, file_name: str, abs_path: str, index: Dict[str, str]) -> Optional[str]:
    """带磁盘缓存的 SHA256，避免重复计算大文件。"""
    cache_name = _find_sidecar(index, file_name, _HASH_SIDECARS)
    try:
        file_mtime = os.path.getmtime(abs_path)
        file_size = os.path.getsize(abs_path)
    except OSError:
        return None

    if cache_name:
        cached = _safe_read_json(os.path.join(directory, cache_name))
        if (
            cached
            and cached.get("mtime") == file_mtime
            and cached.get("size") == file_size
            and cached.get("sha256")
        ):
            return str(cached["sha256"])

    digest = compute_sha256(abs_path)
    if digest:
        out_path = os.path.join(directory, _strip_lora_ext(file_name) + ".cft-hash.json")
        try:
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(
                    {"sha256": digest, "mtime": file_mtime, "size": file_size, "computed_at": time.time()},
                    f,
                    ensure_ascii=False,
                )
        except OSError:
            pass
    return digest


# ---------------------------------------------------------------- 元数据合并


def _pick(d: Dict[str, Any], *names, default=None):
    for n in names:
        if n in d and d[n] not in (None, "", [], {}):
            return d[n]
    return default


def _from_civitai_json(raw: Dict[str, Any], cft_domain: str) -> Dict[str, Any]:
    """把 C 站 JSON（.civitai.info / .info.json）归一化。"""
    if not isinstance(raw, dict):
        return {}

    version = raw.get("version") if isinstance(raw.get("version"), dict) else {}
    files = raw.get("files") if isinstance(raw.get("files"), list) else []
    images = raw.get("images") if isinstance(raw.get("images"), list) else []

    first_file = files[0] if files and isinstance(files[0], dict) else {}
    hashes = first_file.get("hashes") if isinstance(first_file.get("hashes"), dict) else {}

    model_id = _pick(raw, "modelId", "model_id", "id")
    version_id = _pick(raw, "versionId", "version_id") or _pick(version, "id")

    out: Dict[str, Any] = {
        "modelId": model_id,
        "versionId": version_id,
        "name": _pick(raw, "name", default=""),
        "creator": _pick(raw, "creator", "username", default=""),
        "type": _pick(raw, "type", default=""),
        "nsfw": bool(raw.get("nsfw")) if raw.get("nsfw") is not None else None,
        "tags": raw.get("tags") if isinstance(raw.get("tags"), list) else [],
        "description": _html_to_text(str(_pick(raw, "description", default=""))),
        "stats": raw.get("stats") if isinstance(raw.get("stats"), dict) else {},
        "baseModel": _pick(raw, "baseModel") or _pick(version, "baseModel"),
        "trainedWords": raw.get("trainedWords") if isinstance(raw.get("trainedWords"), list) else [],
        "version_name": _pick(version, "name", default=""),
        "publishedAt": _pick(version, "publishedAt"),
        "updatedAt": _pick(version, "updatedAt"),
        "hashes": {
            "SHA256": hashes.get("SHA256"),
            "AutoV2": hashes.get("AutoV2"),
            "AutoV1": hashes.get("AutoV1"),
            "BLAKE3": hashes.get("BLAKE3"),
            "CRC32": hashes.get("CRC32"),
        },
        "file_name": _pick(first_file, "name", default=""),
        "file_size_kb": first_file.get("sizeKB"),
        "images": [],
    }

    # modelId 有时只出现在 url 里
    if not out["modelId"]:
        url = str(_pick(raw, "url", default=""))
        m = re.search(r"/models/(\d+)", url)
        if m:
            out["modelId"] = int(m.group(1))

    if out["modelId"]:
        out["url"] = f"https://{cft_domain}/models/{out['modelId']}"
    else:
        out["url"] = str(_pick(raw, "url", default=""))

    for img in images[:12]:
        if not isinstance(img, dict):
            continue
        out["images"].append(
            {
                "url": img.get("url"),
                "width": img.get("width"),
                "height": img.get("height"),
                "nsfw": img.get("nsfw"),
                # C 站示例图有 image / video 两种，前端据此决定用 <img> 还是 <video>。
                # 缺失时默认 image。
                "type": img.get("type") or "image",
            }
        )

    return {k: v for k, v in out.items() if v not in (None, "", [], {})}


def _collect_metadata_placeholder() -> None:
    """占位：保留函数位置，避免历史调用点断裂。"""
    return None


def _collect_metadata(directory: str, file_name: str, index: Dict[str, str], domain: str) -> Dict[str, Any]:
    """汇总一个 lora 的所有可用元数据。"""
    result: Dict[str, Any] = {"source": None, "civitai": {}, "training": {}, "images": []}

    # 1) C 站完整信息
    civ_name = _find_sidecar(index, file_name, _CIVITAI_SIDECARS)
    simple_name = _find_sidecar(index, file_name, _SIMPLE_SIDECARS)

    civ_raw = None
    if civ_name:
        civ_raw = _safe_read_json(os.path.join(directory, civ_name))
    if civ_raw is None and simple_name:
        civ_raw = _safe_read_json(os.path.join(directory, simple_name))

    if civ_raw:
        civ = _from_civitai_json(civ_raw, domain)
        if civ:
            result["civitai"] = civ
            result["source"] = "civitai"

    # 2) 兜底：直接读 safetensors 头部
    if not result["training"]:
        abs_path = os.path.join(directory, file_name)
        meta = read_safetensors_metadata(abs_path)
        if meta:
            result["training"] = _extract_training_info(meta)
            if result["source"] is None:
                result["source"] = "safetensors"

    return result


# ---------------------------------------------------------------- 对外接口


def _build_item(root: str, abs_path: str, rel_path: str, index: Dict[str, str], domain: str,
                with_meta: bool = True, user_map: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    directory = os.path.dirname(abs_path)
    file_name = os.path.basename(abs_path)
    rel_norm = rel_path.replace("\\", "/")

    try:
        size = os.path.getsize(abs_path)
        mtime = os.path.getmtime(abs_path)
    except OSError:
        size, mtime = 0, 0.0

    preview = find_preview(directory, file_name, index)
    folder = os.path.dirname(rel_norm)
    if folder == ".":
        folder = ""

    # 预览图 mtime：前端据此给 /preview URL 加版本号（换封面后 URL 变化，破缓存）。
    # 无预览图或 stat 失败时回 0（前端视作「无版本号」）。
    preview_mtime = 0.0
    if preview:
        try:
            preview_mtime = os.path.getmtime(os.path.join(directory, preview))
        except OSError:
            preview_mtime = 0.0

    item: Dict[str, Any] = {
        "id": rel_norm,
        "lora": rel_norm,
        "name": _strip_lora_ext(file_name),
        "file_name": file_name,
        "folder": folder,
        "root": root,
        "size": size,
        "size_mb": round(size / 1048576.0, 2),
        "mtime": mtime,
        "preview": f"{folder}/{preview}" if (preview and folder) else (preview or ""),
        "preview_mtime": preview_mtime,
        "has_meta": False,
        "source": None,
        "civitai": {},
        "training": {},
    }

    if with_meta:
        cache_key = abs_path
        with _CACHE_LOCK:
            cached = _META_CACHE.get(cache_key)
        if cached and cached[0] == mtime:
            merged = cached[1]
        else:
            merged = _collect_metadata(directory, file_name, index, domain)
            with _CACHE_LOCK:
                _META_CACHE[cache_key] = (mtime, merged)

        item["civitai"] = merged.get("civitai") or {}
        item["training"] = merged.get("training") or {}
        item["source"] = merged.get("source")
        item["has_meta"] = bool(item["civitai"] or item["training"])

        civ = item["civitai"]
        if civ:
            item["display_name"] = civ.get("name") or item["name"]
            item["base_model"] = civ.get("baseModel") or item["training"].get("base_model_version") or ""
            item["creator"] = civ.get("creator") or ""
            item["trained_words"] = civ.get("trainedWords") or []
            item["tags"] = civ.get("tags") or []
            item["model_id"] = civ.get("modelId")
            item["version_id"] = civ.get("versionId")
            item["url"] = civ.get("url") or ""
            item["nsfw"] = civ.get("nsfw")
            item["downloads"] = (civ.get("stats") or {}).get("downloadCount")
            item["remote_images"] = civ.get("images") or []
        else:
            item["base_model"] = item["training"].get("base_model_version") or ""
            item["remote_images"] = []

    # 用户自定义数据（标签 / 简介 / 封面）——与 C 站数据分离，刷新 C 站不会覆盖。
    # scan_loras 会预先一次性扫好传进来（user_map），避免每条 lora 都 stat 磁盘；
    # 单条详情等场景没传时，局部 import 后按需读取。
    if user_map is None:
        try:
            from . import cft_userdata  # 局部 import：避免模块级循环依赖
            ud = cft_userdata.read(rel_norm)
        except Exception:
            ud = {}
    else:
        ud = user_map.get(rel_norm) or {}
    item["user_tags"] = ud.get("tags") or []
    item["user_note"] = ud.get("note") or ""
    item["has_user"] = bool(ud.get("exists"))
    cov = ud.get("cover") or {}
    item["cover_url"] = cov.get("url") or ""
    item["cover_type"] = cov.get("type") or ""
    # 收藏：与 user_tags 同源同口径（都在 .cft-user.json 里，随扫描一次读出）
    item["favorite"] = bool(ud.get("favorite"))

    return item


def invalidate_cache() -> None:
    """清空扫描缓存（新增/删除 lora 后调用）。"""
    with _CACHE_LOCK:
        _SCAN_CACHE["stamp"] = 0.0
        _SCAN_CACHE["items"] = []
        _SCAN_CACHE["index"] = {}
        _META_CACHE.clear()


def scan_loras(force: bool = False, with_meta: bool = True) -> List[Dict[str, Any]]:
    """扫描全部 lora 目录，返回条目列表。结果带 TTL 缓存。"""
    with _CACHE_LOCK:
        now = time.time()
        if (
            not force
            and _SCAN_CACHE["items"]
            and _SCAN_CACHE["with_meta"] == with_meta
            and now - _SCAN_CACHE["stamp"] < _CACHE_TTL
        ):
            return _SCAN_CACHE["items"]

    domain = cft_config.get_site_domain()
    items: List[Dict[str, Any]] = []

    # 用户自定义数据一次性扫好（一次目录遍历），避免每条 lora 都 stat 磁盘。
    user_map: Dict[str, Any] = {}
    try:
        from . import cft_userdata  # 局部 import：避免模块级循环依赖
        user_map = cft_userdata.scan_user_data()
    except Exception:
        user_map = {}

    for root in cft_config.resolve_loras_dirs():
        if not os.path.isdir(root):
            continue
        try:
            with os.scandir(root) as it:
                subdirs = [e.name for e in it if e.is_dir() and not e.name.startswith(".")]
        except OSError:
            subdirs = []

        # 根目录下的散装文件
        root_index = _build_sidecar_index(root)
        for name in list(root_index.keys()):
            if name.lower().endswith(_LORA_EXTS):
                abs_path = os.path.join(root, name)
                items.append(_build_item(root, abs_path, name, root_index, domain, with_meta, user_map))

        # 子目录（每个子目录一个文件夹，模拟 CFT 的分类管理）
        for sub in subdirs:
            sub_path = os.path.join(root, sub)
            index = _build_sidecar_index(sub_path)
            for name in list(index.keys()):
                if name.lower().endswith(_LORA_EXTS):
                    abs_path = os.path.join(sub_path, name)
                    items.append(_build_item(root, abs_path, os.path.join(sub, name), index, domain, with_meta, user_map))

    items.sort(key=lambda x: (x.get("folder") or "", (x.get("name") or "").lower()))

    with _CACHE_LOCK:
        _SCAN_CACHE["stamp"] = time.time()
        _SCAN_CACHE["items"] = items
        _SCAN_CACHE["with_meta"] = with_meta
        _SCAN_CACHE["index"] = {it["id"]: it for it in items}

    return items


def resolve_lora_path(relative_name: str) -> Optional[str]:
    """把前端传来的相对路径解析成磁盘绝对路径，并做目录穿越防护。"""
    if not relative_name:
        return None
    rel = str(relative_name).replace("\\", "/").lstrip("/")
    if ".." in rel.split("/"):
        return None

    for root in cft_config.resolve_loras_dirs():
        abs_path = os.path.normpath(os.path.join(root, *rel.split("/")))
        try:
            if os.path.commonpath([os.path.abspath(abs_path), os.path.abspath(root)]) != os.path.abspath(root):
                continue
        except ValueError:
            continue
        if os.path.isfile(abs_path):
            return abs_path
    return None


def get_lora_detail(relative_name: str, deep: bool = True) -> Optional[Dict[str, Any]]:
    """获取单个 lora 的完整信息（含磁盘缓存的 SHA256）。"""
    abs_path = resolve_lora_path(relative_name)
    if not abs_path:
        return None

    directory = os.path.dirname(abs_path)
    file_name = os.path.basename(abs_path)
    index = _build_sidecar_index(directory)
    domain = cft_config.get_site_domain()

    root = None
    for r in cft_config.resolve_loras_dirs():
        try:
            if os.path.commonpath([os.path.abspath(abs_path), os.path.abspath(r)]) == os.path.abspath(r):
                root = r
                break
        except ValueError:
            continue

    rel = relative_name.replace("\\", "/")
    item = _build_item(root or directory, abs_path, rel, index, domain, with_meta=True)

    if deep:
        sha = _cached_sha256(directory, file_name, abs_path, index)
        item["sha256"] = sha or (item.get("civitai") or {}).get("hashes", {}).get("SHA256")

    # 预览图（本地）
    item["preview_file"] = find_preview(directory, file_name, index) or ""

    # 训练信息补充
    if not item.get("training"):
        item["training"] = _extract_training_info(read_safetensors_metadata(abs_path))

    return item
