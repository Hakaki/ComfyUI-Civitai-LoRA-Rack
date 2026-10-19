"""Civitai API 客户端。

复用 CFT 的 API Key / 镜像域名 / 代理设置，按文件哈希在线查询模型信息，
并把结果落盘成 CFT 同款的 ``.civitai.info``，与 CFT 生态保持互通。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, Optional

from . import cft_config

__all__ = ["query_by_hash", "query_by_model_id", "save_civitai_info", "normalize_version", "test_api_key"]

_TIMEOUT = 25


def _build_session():
    """构造 requests 会话，带上 CFT 的代理与鉴权。"""
    import requests

    session = requests.Session()
    proxy = cft_config.get_proxy()
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}

    api_key = cft_config.get_api_key()
    headers = {
        "User-Agent": "ComfyUI-Civitai-LoRA-Rack/1.0",
        "Accept": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    session.headers.update(headers)
    return session


def _api_bases():
    """候选 API 域名：先镜像站，再官方站兜底。"""
    domain = cft_config.get_site_domain()
    bases = [f"https://{domain}"]
    if domain != "civitai.com":
        bases.append("https://civitai.com")
    return bases


def _get_json(path: str) -> Optional[Dict[str, Any]]:
    last_err: Optional[str] = None
    for base in _api_bases():
        url = base + path
        try:
            session = _build_session()
            resp = session.get(url, timeout=_TIMEOUT)
            if resp.status_code == 404:
                last_err = f"404 on {base}"
                continue
            if resp.status_code >= 400:
                last_err = f"HTTP {resp.status_code} on {base}"
                continue
            return resp.json()
        except Exception as exc:  # 网络异常 / 代理失败
            last_err = f"{type(exc).__name__}: {exc} on {base}"
            continue
    if last_err:
        raise RuntimeError(last_err)
    return None


def normalize_version(raw: Dict[str, Any]) -> Dict[str, Any]:
    """把 C 站 model-version 响应裁剪成前端够用的结构。"""
    from .cft_metadata import _from_civitai_json

    return _from_civitai_json(raw, cft_config.get_site_domain())


# model 级信息缓存：同一模型的多个版本共用一份 creator/tags/description，
# 批量查询时能省掉大量重复请求。进程内缓存即可（重启后重新拉）。
_MODEL_LEVEL_CACHE: Dict[int, Dict[str, Any]] = {}


def _fetch_model_level(model_id: int) -> Dict[str, Any]:
    """取 model 级信息（creator / tags / description）。

    为什么需要单独查：C 站的 ``/api/v1/model-versions/by-hash/{hash}`` 只返回
    **版本级**字段（name / baseModel / stats / files / images），
    ``creator`` / ``tags`` / ``description`` 挂在 ``/api/v1/models/{id}`` 上。
    早期只查 by-hash 就把结果写回 .civitai.info，导致写回的文件永远缺作者 /
    标签 / 简介 —— 界面于是显示「有 C 站信息」却列不出作者。
    """
    mid = int(model_id)
    if mid in _MODEL_LEVEL_CACHE:
        return _MODEL_LEVEL_CACHE[mid]

    try:
        raw = _get_json(f"/api/v1/models/{mid}")
    except Exception:  # 网络/解析失败：不影响版本级信息，静默降级
        raw = None
    if not raw:
        return {}

    creator = raw.get("creator")
    if isinstance(creator, dict):
        creator = creator.get("username") or creator.get("displayName") or ""
    info = {
        "creator": creator or "",
        "tags": raw.get("tags") if isinstance(raw.get("tags"), list) else [],
        "description": raw.get("description") or "",
        "type": raw.get("type") or "",
    }
    _MODEL_LEVEL_CACHE[mid] = info
    return info


def _enrich_with_model_level(raw: Dict[str, Any]) -> Dict[str, Any]:
    """把 model 级字段补进版本级响应，让归一化后能拿到作者/标签/简介。"""
    model_id = raw.get("modelId") or raw.get("id")
    if not model_id:
        return raw
    info = _fetch_model_level(model_id)
    if not info:
        return raw

    merged = dict(raw)
    # 只在版本级响应确实缺该字段时才补，不覆盖已有值
    if not (merged.get("creator") or merged.get("username")) and info.get("creator"):
        merged["creator"] = info["creator"]
    if not (isinstance(merged.get("tags"), list) and merged.get("tags")) and info.get("tags"):
        merged["tags"] = info["tags"]
    if not merged.get("description") and info.get("description"):
        merged["description"] = info["description"]
    if not merged.get("type") and info.get("type"):
        merged["type"] = info["type"]
    return merged


def query_by_hash(file_hash: str) -> Dict[str, Any]:
    """按文件哈希（SHA256 / AutoV2 / AutoV1）查询 C 站。

    含 model 级补齐：by-hash 拿不到作者/标签/简介，会再查一次 /models/{id}。
    """
    h = str(file_hash or "").strip().upper()
    if not h:
        raise ValueError("hash 为空")
    raw = _get_json(f"/api/v1/model-versions/by-hash/{h}")
    if not raw:
        return {}
    return normalize_version(_enrich_with_model_level(raw))


def query_by_model_id(model_id: int, version_id: Optional[int] = None) -> Dict[str, Any]:
    """按模型 ID 查询（可指定版本 ID）。"""
    raw = _get_json(f"/api/v1/models/{int(model_id)}")
    if not raw:
        return {}

    versions = raw.get("versions") or []
    target = None
    if version_id:
        for v in versions:
            if int(v.get("id") or 0) == int(version_id):
                target = v
                break
    if target is None and versions:
        target = versions[0]
    if target is None:
        return {}

    merged = dict(target)
    merged.setdefault("modelId", raw.get("id"))
    merged.setdefault("name", raw.get("name"))
    merged.setdefault("type", raw.get("type"))
    merged.setdefault("nsfw", raw.get("nsfw"))
    merged.setdefault("tags", raw.get("tags"))
    merged.setdefault("creator", (raw.get("creator") or {}).get("username"))
    merged.setdefault("stats", raw.get("stats"))
    if not merged.get("description"):
        merged["description"] = raw.get("description")
    return normalize_version(merged)


def save_civitai_info(abs_lora_path: str, data: Dict[str, Any]) -> Optional[str]:
    """把 C 站信息落盘成 ``<file>.civitai.info``（社区通用的 sidecar 命名），
    这样其它工具也能直接复用这份元数据。"""
    if not abs_lora_path or not data:
        return None
    directory = os.path.dirname(abs_lora_path)
    file_name = os.path.basename(abs_lora_path)
    base = file_name[: -len(".safetensors")] if file_name.lower().endswith(".safetensors") else os.path.splitext(file_name)[0]
    out_path = os.path.join(directory, base + ".civitai.info")

    payload = dict(data)
    payload["_cft_lora_stack"] = {"synced_at": time.time()}
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return out_path
    except OSError:
        return None


def test_api_key(api_key: str) -> Dict[str, Any]:
    """验证 C 站 API Key 是否有效。

    走鉴权端点 ``GET /api/v1/me``：带有效 Bearer Token 返回 200 + 用户档案
    （``id`` / ``username`` / ``tier``）；Token 缺失或无效返回 401；网络不可达
    则返回 ``reason=network``。这是 C 站官方推荐的「验证 Token」方式，比匿名接口
    （如 /models）更能确认 Key 真的被服务端接受。
    """
    import requests

    session = requests.Session()
    proxy = cft_config.get_proxy()
    if proxy:
        session.proxies = {"http": proxy, "https": proxy}

    headers = {
        "User-Agent": "ComfyUI-Civitai-LoRA-Rack/1.0",
        "Accept": "application/json",
    }
    key = str(api_key or "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    session.headers.update(headers)

    domain = cft_config.get_site_domain()
    bases = [f"https://{domain}"]
    if domain != "civitai.com":
        bases.append("https://civitai.com")

    last_err: Optional[str] = None
    for base in bases:
        try:
            resp = session.get(base + "/api/v1/me", timeout=_TIMEOUT)
            if resp.status_code == 401:
                return {"ok": False, "reason": "unauthorized", "message": "Token 无效或缺失（C 站返回 401）"}
            if resp.status_code >= 400:
                last_err = f"HTTP {resp.status_code}"
                continue
            data = resp.json() if resp.content else {}
            if isinstance(data, dict) and data.get("id"):
                return {
                    "ok": True,
                    "username": data.get("username") or "",
                    "tier": data.get("tier") or "",
                    "message": "Token 有效",
                }
            return {"ok": False, "reason": "no_user", "message": "接口未返回用户信息"}
        except Exception as exc:  # 网络异常 / 代理失败 / 解析失败
            last_err = f"{type(exc).__name__}: {exc}"
            continue

    if last_err:
        return {"ok": False, "reason": "network", "message": f"无法连接 C 站：{last_err}"}
    return {"ok": False, "reason": "unknown", "message": "未知错误"}
