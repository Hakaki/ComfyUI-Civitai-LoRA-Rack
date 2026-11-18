"""Anima 旧版 LoRA 块序号映射测试（纯逻辑，不需要 ComfyUI 运行时）。

用法：python tests/test_anima_remap.py
"""

from __future__ import annotations

import importlib.util
import os
import sys

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAILURES = []


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'[OK]  ' if ok else '[FAIL]'} {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)
    return ok


def load_module():
    """直接按文件加载，避免触发 cft 包对 ComfyUI 运行时的依赖。"""
    path = os.path.join(PLUGIN_DIR, "cft", "cft_anima.py")
    spec = importlib.util.spec_from_file_location("cft_anima_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


anima = load_module()


class FakeDiffusion:
    def __init__(self, blocks: int):
        self.blocks = list(range(blocks))
        self.llm_adapter = object()  # Anima 特征

    def __len__(self):  # 防某些实现走 len()
        return len(self.blocks)


class FakeModel:
    def __init__(self, blocks: int):
        self.model = type("Inner", (), {})()
        self.model.diffusion_model = FakeDiffusion(blocks)
        self.model.model_config = {}


class NonAnimaModel:
    class Inner:
        diffusion_model = type("DM", (), {"blocks": list(range(30))})()
        model_config = {"unet_config": {"image_model": "sd3"}}

    model = Inner()


def make_kohya(blocks: int, per_block: int = 2):
    """合成 kohya 风格权重：lora_unet_blocks_N_self_attn_q_proj.*"""
    out = {}
    for index in range(blocks):
        for suffix in ("lora_down.weight", "lora_up.weight")[:per_block]:
            out[f"lora_unet_blocks_{index}_self_attn_q_proj.{suffix}"] = "t"
    return out


def block_indices(mapping_module, keys):
    found = set()
    for key in keys:
        for pattern in (mapping_module._KOHYA_RE, mapping_module._DOTTED_RE):
            match = pattern.search(key)
            if match:
                found.add(int(match.group("index")))
    return found


print("[1] 布局识别")
w28 = make_kohya(28)
check("28 块 → 28", anima.detect_lora_blocks(w28.keys()) == 28)
check("40 块 → 40", anima.detect_lora_blocks(make_kohya(40).keys()) == 40)
check("52 块 → 52", anima.detect_lora_blocks(make_kohya(52).keys()) == 52)
check("无块 key → None", anima.detect_lora_blocks(["lora_unet_x_embedder.weight"]) is None)
try:
    anima.detect_lora_blocks(make_kohya(60).keys())
    check("60 块应报错", False)
except anima.AnimaRemapError:
    check("未知布局报错", True)

print("\n[2] 28 → 40 映射表")
mapping = anima.resolve_mapping(28, 40)
expect = {0: 0, 1: 1, 2: 3, 3: 4, 4: 6, 5: 7, 6: 9, 17: 25, 21: 31, 24: 35, 26: 38, 27: 39}
check("映射条数 28", len(mapping) == 28)
check("抽查关键映射", all(mapping.get(k) == v for k, v in expect.items()),
      str({k: mapping.get(k) for k in expect}))
check("值唯一且落在 0..39", len(set(mapping.values())) == 28 and max(mapping.values()) < 40)
inserted = sorted(set(range(40)) - set(mapping.values()))
check("插入块正是 12 个", inserted == [2, 5, 8, 11, 14, 17, 21, 24, 27, 30, 33, 36], str(inserted))

print("\n[3] 重映射行为")
out, report = anima.remap_weights(w28, FakeModel(40), "demo")
check("key 数量守恒", len(out) == len(w28))
check("块号全部 < 40", max(block_indices(anima, out)) < 40)
check("块 2 的 key 已迁到 3", "lora_unet_blocks_3_self_attn_q_proj.lora_down.weight" in out)
check("旧块 2 已空出", "lora_unet_blocks_2_self_attn_q_proj.lora_down.weight" not in out)
check("报告含 28 -> 40", report is not None and "28 -> 40" in report, str(report))

print("\n[4] 28 → 52 组合")
m52 = anima.resolve_mapping(28, 52)
check("组合映射 28 条", m52 is not None and len(m52) == 28)
check("末块 27 → 51", m52.get(27) == 51, str(m52.get(27)))
check("首块 0 → 0", m52.get(0) == 0)

print("\n[5] 不做映射的情形")
same, same_report = anima.remap_weights(w28, FakeModel(28), "demo")
check("同代次原样返回", same is w28 and same_report is None)
other, other_report = anima.remap_weights(w28, NonAnimaModel(), "demo")
check("非 Anima 原样返回", other is w28 and other_report is None)
check("is_anima_model 判否", anima.is_anima_model(NonAnimaModel()) is False)
check("is_anima_model 判是", anima.is_anima_model(FakeModel(40)) is True)

print("\n[6] 非法情形")
try:
    anima.remap_weights(make_kohya(40), FakeModel(28), "demo")
    check("新代次向下降级应报错", False)
except anima.AnimaRemapError:
    check("新代次向下降级报错", True)
try:
    anima.resolve_mapping(28, 64)
    check("缺失映射应报错", False)
except anima.AnimaRemapError:
    check("缺失映射报错", True)

print("\n[7] 跳过规则与两种命名")
mixed = {
    "lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": 1,
    "text_encoders.clip_l.transformer.text_model.encoder.layers.0.mlp.fc1.lora_A.weight": 2,
    "diffusion_model.llm_adapter.blocks_5.fc.weight": 3,
    "diffusion_model.connector.blocks.5.fc.weight": 4,
    "lora_unet_blocks_5_self_attn_q_proj.lora_down.weight": 5,
    "diffusion_model.blocks.5.self_attn.q_proj.lora_A.weight": 6,
}
out_mixed, _ = anima.remap_weights(mixed, FakeModel(40), "mixed")
check("TE lora_te_ 不动", "lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight" in out_mixed)
check("TE text_encoders. 不动",
      "text_encoders.clip_l.transformer.text_model.encoder.layers.0.mlp.fc1.lora_A.weight" in out_mixed)
check("llm_adapter 不动", "diffusion_model.llm_adapter.blocks_5.fc.weight" in out_mixed)
check("connector 不动", "diffusion_model.connector.blocks.5.fc.weight" in out_mixed)
check("kohya 风格改写 5→7", "lora_unet_blocks_7_self_attn_q_proj.lora_down.weight" in out_mixed)
check("diffusers 风格改写 5→7",
      "diffusion_model.blocks.7.self_attn.q_proj.lora_A.weight" in out_mixed)

print("\n[8] 缓存安全（浅拷贝不污染原字典）")
before = set(w28.keys())
anima.remap_weights(w28, FakeModel(40), "demo")
check("原权重字典未被修改", set(w28.keys()) == before)

print()
if FAILURES:
    print(f"失败 {len(FAILURES)} 项：{FAILURES}")
    sys.exit(1)
print("全部通过")
