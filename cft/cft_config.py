"""插件自有配置：C 站 API Key / 镜像域名 / 代理 / 附加模型目录。

**不读取、不依赖任何外部工具的配置文件** —— 所有网络凭据都由用户在
插件设置弹窗里自行填写，落盘到 ComfyUI 用户目录：

    <ComfyUI>/user/default/Civitai-LoRA-Rack/config.json

也支持用环境变量 ``CLR_CONFIG`` 指定别的 json 文件（便于 Docker / 便携部署）。

配置字段：

```json
{
  "api_key": "",
  "site_domain": "civitai.com",
  "proxy_enabled": false,
  "proxy_address": "",
  "extra_loras_dirs": []
}
```

设计原则：
- 只读本机、不上传；API Key 不会出现在任何日志或接口响应里（只回脱敏值）。
- 没有配置文件时全部走默认值，插件依然能启动、能离线读元数据。
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, List, Optional

__all__ = [
    "get_config",
    "get_status",
    "get_api_key",
    "get_api_key_masked",
    "get_proxy",
    "get_site_domain",
    "resolve_loras_dirs",
    "reload_config",
    "set_api_key",
    "config_path",
]

_LOCK = threading.RLock()
_CACHE: Optional[Dict[str, Any]] = None
_CACHE_PATH: Optional[str] = None
_CACHE_MTIME: float = 0.0

# 默认 C 站域名；用户可改成镜像站（如 civitai.red）
DEFAULT_SITE_DOMAIN = "civitai.com"

# 环境变量：指向自定义配置文件
_ENV_CONFIG = "CLR_CONFIG"

DEFAULT_CONFIG: Dict[str, Any] = {
    "api_key": "",
    "site_domain": DEFAULT_SITE_DOMAIN,
    "proxy_enabled": False,
    "proxy_address": "",
    "extra_loras_dirs": [],
}


def _default_config_dir() -> str:
    """ComfyUI 用户目录下的插件配置目录。"""
    try:
        import folder_paths  # type: ignore

        user_dir = folder_paths.get_user_directory()
        if user_dir:
            return os.path.join(user_dir, "default", "Civitai-LoRA-Rack")
    except Exception:
        pass
    # 没有 ComfyUI 运行时（例如单独跑测试）：退回用户主目录
    return os.path.join(os.path.expanduser("~"), ".comfyui", "Civitai-LoRA-Rack")


def config_path() -> str:
    """当前生效的配置文件完整路径。"""
    env = os.environ.get(_ENV_CONFIG, "").strip()
    if env:
        return env
    return os.path.join(_default_config_dir(), "config.json")


def _read_raw(path: str) -> Dict[str, Any]:
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            with open(path, "r", encoding=enc) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except UnicodeDecodeError:
            continue
        except Exception:
            return {}
    return {}


def _write_raw(path: str, data: Dict[str, Any]) -> None:
    """原子写 JSON（临时文件 + os.replace），UTF-8、不转义中文、缩进 2。"""
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _invalidate() -> None:
    global _CACHE, _CACHE_PATH, _CACHE_MTIME
    with _LOCK:
        _CACHE = None
        _CACHE_PATH = None
        _CACHE_MTIME = 0.0


def get_config(force: bool = False) -> Dict[str, Any]:
    """读取并缓存配置；文件变更（mtime）时自动失效。缺省值会补齐。"""
    global _CACHE, _CACHE_PATH, _CACHE_MTIME

    with _LOCK:
        path = config_path()
        merged = dict(DEFAULT_CONFIG)

        if not os.path.isfile(path):
            return merged

        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return merged

        if not force and _CACHE is not None and _CACHE_PATH == path and _CACHE_MTIME == mtime:
            return _CACHE

        raw = _read_raw(path)
        merged.update({k: v for k, v in raw.items() if v is not None})
        _CACHE = merged
        _CACHE_PATH = path
        _CACHE_MTIME = mtime
        return merged


def reload_config() -> Dict[str, Any]:
    """强制重新读盘。"""
    _invalidate()
    return get_config(force=True)


def set_api_key(api_key: str) -> Dict[str, Any]:
    """写入 API Key（合并，不动其他字段），并返回最新状态。"""
    path = config_path()
    raw = _read_raw(path) if os.path.isfile(path) else {}
    if not isinstance(raw, dict):
        raw = {}
    raw["api_key"] = str(api_key or "").strip()
    _write_raw(path, raw)
    _invalidate()
    return get_status()


def get_api_key() -> str:
    return str(get_config().get("api_key") or "").strip()


def get_api_key_masked() -> str:
    """脱敏展示：仅末 4 位可见。"""
    key = get_api_key()
    return ("*" * 8 + key[-4:]) if len(key) >= 4 else ""


def get_proxy() -> Optional[str]:
    """代理地址（http://host:port），未启用返回 None。"""
    cfg = get_config()
    if not cfg.get("proxy_enabled"):
        return None
    addr = str(cfg.get("proxy_address") or "").strip()
    if not addr:
        return None
    if not addr.startswith(("http://", "https://", "socks")):
        addr = "http://" + addr
    return addr


def get_site_domain() -> str:
    """C 站域名；用户可填镜像站。"""
    domain = str(get_config().get("site_domain") or "").strip()
    return domain or DEFAULT_SITE_DOMAIN


def resolve_loras_dirs() -> List[str]:
    """LoRA 模型根目录列表。

    依次尝试：
    1. ComfyUI 自己的 ``folder_paths``（正常运行时一定有）
    2. 配置里的 ``extra_loras_dirs``（非标准目录的用户手动补）
    3. 从插件位置推导 ``<ComfyUI>/models/loras``（脱离 ComfyUI 跑测试时的兜底）
    """
    dirs: List[str] = []

    try:
        import folder_paths  # type: ignore

        for d in folder_paths.get_folder_paths("loras"):
            if d and os.path.isdir(d) and d not in dirs:
                dirs.append(d)
    except Exception:
        pass

    if not dirs:
        for d in get_config().get("extra_loras_dirs") or []:
            d = str(d or "").strip()
            if d and os.path.isdir(d) and d not in dirs:
                dirs.append(d)

    if not dirs:
        # custom_nodes/<本插件>/cft/cft_config.py → 上溯三级 = ComfyUI 根
        plugin_dir = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
        guess = os.path.join(os.path.dirname(os.path.dirname(plugin_dir)), "models", "loras")
        if os.path.isdir(guess):
            dirs.append(guess)

    return dirs


def get_status() -> Dict[str, Any]:
    """给前端用的配置状态（**绝不返回 api_key 明文**）。"""
    key = get_api_key()
    return {
        "config_path": config_path(),
        "site_domain": get_site_domain(),
        "proxy": get_proxy() or "",
        "has_api_key": bool(key),
        "api_key_masked": ("*" * 8 + key[-4:]) if len(key) >= 4 else "",
        "loras_dirs": resolve_loras_dirs(),
    }
