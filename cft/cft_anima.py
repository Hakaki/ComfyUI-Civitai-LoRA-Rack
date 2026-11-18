"""Anima 旧版 LoRA 的块序号兼容（28 / 40 / 52 块布局）。

Anima 2.9B（40 块）与 3.8B（52 块）是在原始 28 块模型上「块间插层」扩容得到的，
新块插在原有块**之间**，于是按旧布局训练的 LoRA 序号全部错位：

.. code-block:: text

    Anima 28 块   0  1  2  3  4  5  6 ...
    Anima 40 块   0  1  *  3  4  *  6 ...     （* = 新增块）

ComfyUI 不会提示这种错位：旧序号在更大的模型里依然存在，没有任何「key 未加载」
警告，实际表现是 LoRA 像没生效、或加大权重后画面反而变糊。

本模块在**加载时**把权重字典里的块序号重写成目标模型的编号，只在内存里改 key，
不读取、不写回、不转换任何 LoRA 文件。插入位置是社区公开测量的数据：

- 28 → 40：``sparklingcoffee777/ComfyUI-Anima-2.9B-loraPatch``
- 40 → 52：``KitagawaCoding/ComfyUI-Anima-3.8B-loraPatch``、
  ``INuBq8/ComfyUI-Anima-LoRA-ControlNet-Patch``
- 28 → 52：由上面两步组合（BFS 自动串起来，不硬编码第三张表）

只重写主 DiT 的块 key；text encoder、``llm_adapter``、semantic connector 等
自带独立编号的子结构一律不动；新增块在旧 LoRA 里没有对应项，保持原样。
"""

from __future__ import annotations

import logging
import re
from collections import deque
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple

logger = logging.getLogger(__name__)

__all__ = [
    "AnimaRemapError",
    "detect_lora_blocks",
    "enabled",
    "get_model_blocks",
    "is_anima_model",
    "remap_weights",
    "resolve_mapping",
]

# 目标模型里「新增块」占据的序号；约束：old_count + len(insertions) == new_count
_INSERTIONS: Dict[Tuple[int, int], Tuple[int, ...]] = {
    (28, 40): (2, 5, 8, 11, 14, 17, 21, 24, 27, 30, 33, 36),
    (40, 52): (3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47),
}

# 点分隔命名：diffusion_model.blocks.5.self_attn / transformer.blocks.5 / net.blocks.5
# 前缀必须是行首或 "."，避免把 double_blocks.5 之类当成主块
_DOTTED_RE = re.compile(r"(?P<prefix>(?:^|\.)blocks\.)(?P<index>\d+)(?=\.)")

# kohya / sd-scripts 命名：lora_unet_blocks_5_self_attn / lora_unet_net_blocks_5 / lycoris_blocks_5
_KOHYA_RE = re.compile(
    r"(?P<prefix>^(?:lora_unet_(?:net_)?|lycoris_)blocks_)(?P<index>\d+)(?=_)"
)

# 文本编码器自带独立编号，永不参与 DiT 插层映射
_TEXT_ENCODER_PREFIXES = (
    "lora_te_",
    "lora_te1_",
    "lora_te2_",
    "text_encoder.",
    "text_encoders.",
    "text_conditioner.",
    "clip_",
)
_TEXT_ENCODER_MARKERS = (".text_encoder.", ".text_encoders.", ".text_conditioner.")

# 自带独立块编号的子结构（3.8B 的 semantic connector 等）
_SKIP_MARKERS = (
    "llm_adapter",
    "semantic_attention",
    "semantic_attentions",
    "connector",
)


class AnimaRemapError(Exception):
    """映射无法安全完成（布局未知、新 LoRA 套旧模型、重映射后 key 冲突）。"""


def _skip_key(key: str) -> bool:
    """该 key 是否属于「有独立编号、不该动」的子结构。"""
    lowered = key.lower()
    if lowered.startswith(_TEXT_ENCODER_PREFIXES):
        return True
    if any(marker in lowered for marker in _TEXT_ENCODER_MARKERS):
        return True
    return any(marker in lowered for marker in _SKIP_MARKERS)


def _collect_indices(keys: Iterable[Any]) -> Set[int]:
    """收集所有主 DiT 块序号。"""
    indices: Set[int] = set()
    for key in keys:
        if not isinstance(key, str) or _skip_key(key):
            continue
        for pattern in (_DOTTED_RE, _KOHYA_RE):
            indices.update(int(m.group("index")) for m in pattern.finditer(key))
    return indices


def detect_lora_blocks(keys: Iterable[Any]) -> Optional[int]:
    """按最大块序号推断 LoRA 的布局代次。

    0..27 → 28 块，0..39 → 40 块，0..51 → 52 块。
    只覆盖部分块的 LoRA 归入「能容纳它最大序号的最小布局」，这是社区 remap 包的
    既定取舍：宁可漏映射，也不会把一个 40 块 LoRA 错当成 28 块。
    """
    indices = _collect_indices(keys)
    if not indices:
        return None

    highest = max(indices)
    if highest < 28:
        return 28
    if highest < 40:
        return 40
    if highest < 52:
        return 52
    raise AnimaRemapError(f"Anima LoRA 出现未知块序号 {highest}；已知布局为 28 / 40 / 52 块")


def _unet_config(model: Any) -> Mapping[str, Any]:
    inner = getattr(model, "model", None)
    config = getattr(inner, "model_config", None)
    unet_config = getattr(config, "unet_config", None)
    return unet_config if isinstance(unet_config, Mapping) else {}


def _diffusion_model(model: Any) -> Any:
    return getattr(getattr(model, "model", None), "diffusion_model", None)


def is_anima_model(model: Any) -> bool:
    """连接的是不是 Anima 系列模型。

    优先看 unet_config 里的 ``image_model``；旧版 ComfyUI 不填这个字段时，
    退回检测 Anima 独有的 ``llm_adapter`` 子模块。任何异常一律判否——
    宁可不动，也不能把别的架构的 LoRA 改坏。
    """
    try:
        if _unet_config(model).get("image_model") == "anima":
            return True
        return hasattr(_diffusion_model(model), "llm_adapter")
    except Exception:
        return False


def get_model_blocks(model: Any) -> Optional[int]:
    """连接模型的 DiT 块数；拿不到返回 None。"""
    blocks = getattr(_diffusion_model(model), "blocks", None)
    if blocks is not None:
        try:
            count = len(blocks)
        except TypeError:
            count = 0
        if isinstance(count, int) and count > 0:
            return count

    configured = _unet_config(model).get("num_blocks")
    if isinstance(configured, int) and configured > 0:
        return configured

    return None


def _build_mapping(source: int, target: int, insertions: Tuple[int, ...]) -> Dict[int, int]:
    """由「新增块序号」倒推 source → target 的逐块映射。"""
    inserted = set(insertions)
    kept = [index for index in range(target) if index not in inserted]
    if len(kept) != source:
        raise AnimaRemapError(f"插入表不一致：{source} 块 + {len(inserted)} 新块 != {target} 块")
    return {index: kept[index] for index in range(source)}


def resolve_mapping(source: int, target: int) -> Optional[Dict[int, int]]:
    """返回 ``{旧块序号: 新块序号}``；无需映射返回 None。

    直接一步到位时用现成的表；跨代（如 28 → 52）用 BFS 把相邻两步串起来，
    这样以后加了新代次只要补一行插入表，组合路径自动出现。
    """
    if source == target:
        return None

    if source > target:
        raise AnimaRemapError(
            f"LoRA 面向 {source} 块布局，而模型只有 {target} 块；"
            "新代次的 LoRA 无法向下降级映射"
        )

    direct = _INSERTIONS.get((source, target))
    if direct is not None:
        return _build_mapping(source, target, direct)

    queue = deque([(source, {index: index for index in range(source)})])
    seen = {source}

    while queue:
        current, current_map = queue.popleft()
        for (old_count, new_count), insertions in _INSERTIONS.items():
            if old_count != current or new_count in seen:
                continue

            step = _build_mapping(old_count, new_count, insertions)
            combined = {
                origin: step[intermediate]
                for origin, intermediate in current_map.items()
                if intermediate in step
            }
            if len(combined) != source:
                continue
            if new_count == target:
                return combined

            seen.add(new_count)
            queue.append((new_count, combined))

    raise AnimaRemapError(
        f"缺少 {source} → {target} 块的 Anima 映射表；"
        "可在设置里关闭「旧版 Anima LoRA 块映射」后按原样加载"
    )


def _rewrite_key(key: str, mapping: Mapping[int, int]) -> str:
    """把 key 里的块序号换成目标编号；两种命名风格依次处理。"""

    def replace(match: "re.Match[str]") -> str:
        source = int(match.group("index"))
        target = mapping.get(source)
        if target is None:
            raise AnimaRemapError(f"块 {source} 在目标布局里没有对应项（key={key!r}）")
        return f"{match.group('prefix')}{target}"

    rewritten = _DOTTED_RE.sub(replace, key)
    return _KOHYA_RE.sub(replace, rewritten)


def remap_weights(
    weights: Mapping[str, Any],
    model: Any,
    name: Optional[str] = None,
) -> Tuple[Mapping[str, Any], Optional[str]]:
    """按目标模型重写权重里的块序号。

    返回 ``(要加载的权重, 单行报告)``；不需要映射时原样返回并给出 None。
    映射结果是**新的浅拷贝字典**，绝不影响 :mod:`cft_nodes` 里的原始权重缓存
    （缓存按文件存原始权重，映射结果随目标模型变化，不能混存）。
    """
    if not is_anima_model(model):
        return weights, None

    source = detect_lora_blocks(weights.keys())
    if source is None:
        return weights, None

    target = get_model_blocks(model)
    if target is None:
        raise AnimaRemapError("无法确定 Anima 模型的 DiT 块数（ComfyUI 版本过旧？）")

    if source == target:
        return weights, None

    mapping = resolve_mapping(source, target)
    if not mapping:
        return weights, None

    mapped_values = set(mapping.values())
    inserted_blocks = [index for index in range(target) if index not in mapped_values]

    out: Dict[str, Any] = {}
    origin: Dict[str, str] = {}
    block_keys = 0
    changed_keys = 0

    for key, value in weights.items():
        if not isinstance(key, str) or _skip_key(key):
            out[key] = value
            continue
        if _DOTTED_RE.search(key) is None and _KOHYA_RE.search(key) is None:
            out[key] = value
            continue

        block_keys += 1
        new_key = _rewrite_key(key, mapping)
        if new_key != key:
            changed_keys += 1

        if new_key in out:
            raise AnimaRemapError(
                "重映射后 key 冲突："
                f"{origin.get(new_key, new_key)!r} 与 {key!r} 都指向 {new_key!r}"
            )

        out[new_key] = value
        origin[new_key] = key

    label = f'"{name}"：' if name else ""
    inserted_text = "、".join(str(index) for index in inserted_blocks) or "无"
    report = (
        f"Anima 块映射 {label}{source} -> {target} 块；"
        f"重写 {changed_keys}/{block_keys} 个块 key；插入块 {inserted_text} 保持原样"
    )
    return out, report


def enabled() -> bool:
    """配置开关：``anima_legacy_remap``，默认开启。"""
    try:
        from . import cft_config

        return bool(cft_config.get_anima_remap_enabled())
    except Exception:
        return True
