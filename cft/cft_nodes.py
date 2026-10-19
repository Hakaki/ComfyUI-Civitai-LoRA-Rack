"""CLR - LoRA 加载器节点。

节点协议与主流的 LoRA Stack 节点保持一致，已有工作流里的 lora_str JSON 可以直接搬过来：

.. code-block:: json

    [
      {
        "lora": "Anima/xxx.safetensors",
        "name": "xxx",
        "weight": 1.0,
        "text_encoder_weight": 1.0,
        "trigger_weight": 1.0,
        "hidden": false
      }
    ]

``hidden`` 为 true 时该条目不参与加载（前端显隐开关）。
``trigger_weight`` 大于 0 时，该 lora 的触发词会被拼进 ``trigger_words`` 输出。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

__all__ = ["CFTLoraStack", "CFTLoraLoader"]

# 已加载 lora 权重的进程内缓存： {绝对路径: 权重字典}
_LORA_CACHE: Dict[str, Any] = {}
_LORA_CACHE_ORDER: List[str] = []
_LORA_CACHE_LIMIT = 8


def _clear_lora_cache() -> None:
    _LORA_CACHE.clear()
    _LORA_CACHE_ORDER.clear()


def _load_torch_file_cached(abs_path: str):
    """带 LRU 的 lora 权重加载，避免同一 lora 反复读盘。"""
    import comfy.utils

    if abs_path in _LORA_CACHE:
        return _LORA_CACHE[abs_path]

    weights = comfy.utils.load_torch_file(abs_path, safe_load=True)

    while len(_LORA_CACHE_ORDER) >= _LORA_CACHE_LIMIT:
        oldest = _LORA_CACHE_ORDER.pop(0)
        _LORA_CACHE.pop(oldest, None)

    _LORA_CACHE[abs_path] = weights
    _LORA_CACHE_ORDER.append(abs_path)
    return weights


def _apply_lora(model, clip, lora_weights, strength_model: float, strength_clip: float):
    """把 lora 权重打到 model / clip 上，优先用 ComfyUI 官方实现。"""
    try:
        from comfy.sd import load_lora_for_models  # 官方实现，随版本演进

        return load_lora_for_models(model, clip, lora_weights, strength_model, strength_clip)
    except Exception:
        pass

    import comfy.lora

    key_map: Dict[str, Any] = {}
    if model is not None:
        key_map = comfy.lora.model_lora_keys_unet(model.model, key_map)
    if clip is not None:
        key_map = comfy.lora.model_lora_keys_clip(clip.cond_stage_model, key_map)

    loaded = comfy.lora.load_lora(lora_weights, key_map)

    new_model = model.clone() if model is not None else None
    if new_model is not None:
        new_model.add_patches(loaded, strength_model)

    new_clip = clip.clone() if clip is not None else None
    if new_clip is not None:
        new_clip.add_patches(loaded, strength_clip)

    return new_model, new_clip


def _parse_stack(raw: Any) -> List[Dict[str, Any]]:
    """解析前端传来的 LoRA 堆数据，容忍多种历史格式。"""
    if raw is None or raw == "":
        return []

    data = raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            logger.warning("[Civitai-LoRA-Rack] lora_stack 不是合法 JSON，已忽略：%s", text[:200])
            return []

    if isinstance(data, dict):
        data = data.get("loras") or data.get("lora") or []

    if not isinstance(data, list):
        return []

    out: List[Dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        path = item.get("lora") or item.get("path") or item.get("file")
        if not path:
            continue
        out.append(
            {
                "lora": str(path).replace("\\", "/"),
                "weight": item.get("weight", 1.0),
                "text_encoder_weight": item.get("text_encoder_weight", item.get("clip_weight", 1.0)),
                "trigger_weight": item.get("trigger_weight", 0.0),
                "hidden": bool(item.get("hidden", False)),
            }
        )
    return out


def _collect_trigger_words(entries: List[Dict[str, Any]]) -> str:
    """汇总需要参与提示词的触发词。"""
    from . import cft_metadata

    words: List[str] = []
    seen = set()

    for entry in entries:
        try:
            if float(entry.get("trigger_weight") or 0) <= 0:
                continue
        except (TypeError, ValueError):
            continue

        detail = cft_metadata.get_lora_detail(entry["lora"], deep=False)
        if not detail:
            continue
        candidates = (detail.get("civitai") or {}).get("trainedWords") or []
        if not candidates:
            top = (detail.get("training") or {}).get("top_tags") or []
            candidates = [t for t, _ in top[:5]]
        for w in candidates:
            w = str(w).strip()
            if w and w not in seen:
                seen.add(w)
                words.append(w)

    return ", ".join(words)


class CFTLoraStack:
    """CLR - LoRA 加载器：一次性管理并应用多条 LoRA。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_stack": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "[]",
                        "dynamicPrompts": False,
                    },
                ),
            },
            "optional": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "reset_cache": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("CLIP", "MODEL", "STRING")
    RETURN_NAMES = ("CLIP", "MODEL", "触发词")
    FUNCTION = "apply_loras"
    CATEGORY = "Civitai/LoRA"
    DESCRIPTION = "管理多条 LoRA、调节权重，并查看 Civitai 上的模型信息。"

    def apply_loras(
        self,
        lora_stack: str = "[]",
        model=None,
        clip=None,
        reset_cache: bool = False,
    ) -> Tuple[Any, Any, str]:
        if reset_cache:
            _clear_lora_cache()

        entries = _parse_stack(lora_stack)
        active = [e for e in entries if not e["hidden"]]

        if not active:
            logger.info("[Civitai-LoRA-Rack] LoRA 堆为空或全部隐藏，直接透传")
            return (clip, model, "")

        if model is None and clip is None:
            logger.warning("[Civitai-LoRA-Rack] 未接入 MODEL / CLIP，Lora 无法生效")
            return (clip, model, "")

        import folder_paths

        out_model = model
        out_clip = clip

        for entry in active:
            rel = entry["lora"]
            abs_path = folder_paths.get_full_path("loras", rel)
            if not abs_path:
                logger.error("[Civitai-LoRA-Rack] 找不到 Lora 文件：%s", rel)
                continue

            try:
                strength_model = float(entry["weight"])
                strength_clip = float(entry["text_encoder_weight"])
            except (TypeError, ValueError):
                strength_model, strength_clip = 1.0, 1.0

            try:
                weights = _load_torch_file_cached(abs_path)
                out_model, out_clip = _apply_lora(out_model, out_clip, weights, strength_model, strength_clip)
                logger.info(
                    "[Civitai-LoRA-Rack] 已应用 %s (model=%.3f, clip=%.3f)",
                    rel,
                    strength_model,
                    strength_clip,
                )
            except Exception as exc:
                logger.exception("[Civitai-LoRA-Rack] 加载 Lora 失败 %s: %s", rel, exc)

        trigger_words = _collect_trigger_words(active)
        return (out_clip, out_model, trigger_words)


class CFTLoraLoader:
    """单条 LoRA 加载器（CLS）：只想加载一条 LoRA 时的简单入口。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_name": ("STRING", {"default": "", "multiline": False}),
                "strength_model": ("FLOAT", {"default": 1.0, "min": -20.0, "max": 20.0, "step": 0.01}),
                "strength_clip": ("FLOAT", {"default": 1.0, "min": -20.0, "max": 20.0, "step": 0.01}),
            },
            "optional": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
            },
        }

    RETURN_TYPES = ("CLIP", "MODEL")
    RETURN_NAMES = ("CLIP", "MODEL")
    FUNCTION = "load_one"
    CATEGORY = "Civitai/LoRA"

    def load_one(self, lora_name: str, strength_model: float, strength_clip: float,
                 model=None, clip=None):
        if not lora_name:
            return (clip, model)

        import folder_paths

        abs_path = folder_paths.get_full_path("loras", lora_name)
        if not abs_path:
            logger.error("[Civitai-LoRA-Slot] 找不到 Lora：%s", lora_name)
            return (clip, model)

        weights = _load_torch_file_cached(abs_path)
        out_model, out_clip = _apply_lora(model, clip, weights, strength_model, strength_clip)
        return (out_clip, out_model)
