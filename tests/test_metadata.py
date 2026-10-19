"""Civitai LoRA Rack（CLR）后端自测脚本（不依赖 ComfyUI 运行时）。

用法：
    python tests/test_metadata.py            # 全量扫描
    python tests/test_metadata.py --limit 5  # 只看前 5 条详情
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cft import cft_config, cft_metadata  # noqa: E402


def _line(title: str = "") -> None:
    print("\n" + "=" * 68)
    if title:
        print(title)
        print("=" * 68)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=3, help="展示详情的条目数")
    parser.add_argument("--json", action="store_true", help="输出完整 JSON")
    args = parser.parse_args()

    failures = []

    # ---------------------------------------------------------- 1. 配置
    _line("1. CFT 配置探测")
    status = cft_config.get_status()
    print(f"  配置文件      : {status['config_path']}")
    print(f"  站点域名      : {status['site_domain']}")
    print(f"  代理          : {status['proxy'] or '(未启用)'}")
    print(f"  API Key       : {status['api_key_masked'] or '(无)'}")
    print(f"  loras 根目录  : {status['loras_dirs']}")
    if not status.get("config_path"):
        failures.append("未解析到配置文件路径")
    if not status["loras_dirs"]:
        failures.append("未解析到 loras 目录")

    # ---------------------------------------------------------- 2. 扫描
    _line("2. 全量扫描 lora")
    t0 = time.time()
    items = cft_metadata.scan_loras(force=True, with_meta=True)
    cost = time.time() - t0
    print(f"  条目总数      : {len(items)}  (耗时 {cost:.2f}s)")
    if not items:
        failures.append("扫描结果为空")
        print("\n".join(f"  [FAIL] {f}" for f in failures))
        return 1

    folders = {}
    for it in items:
        folders[it.get("folder") or "(根目录)"] = folders.get(it.get("folder") or "(根目录)", 0) + 1
    print("  文件夹分布    :")
    for k, v in sorted(folders.items()):
        print(f"    - {k}: {v}")

    with_meta = sum(1 for it in items if it.get("has_meta"))
    with_civitai = sum(1 for it in items if it.get("civitai"))
    with_preview = sum(1 for it in items if it.get("preview"))
    print(f"  带元数据      : {with_meta} ({with_meta * 100 // len(items)}%)")
    print(f"  带 C 站信息   : {with_civitai}")
    print(f"  带本地预览图  : {with_preview}")

    if with_civitai == 0:
        failures.append("没有任何条目解析出 C 站信息")

    # ---------------------------------------------------------- 3. 详情抽查
    _line("3. 详情抽查")
    sample = [it for it in items if it.get("civitai")][: args.limit]
    if args.limit <= 0:
        sample = []
    for it in sample:
        detail = cft_metadata.get_lora_detail(it["lora"], deep=False)
        if not detail:
            failures.append(f"get_lora_detail 失败：{it['lora']}")
            continue
        civ = detail.get("civitai") or {}
        tr = detail.get("training") or {}
        print(f"\n  ▸ {detail['lora']}")
        print(f"     显示名      : {detail.get('display_name')}")
        print(f"     基座模型    : {detail.get('base_model')}")
        print(f"     作者        : {detail.get('creator')}")
        print(f"     大小        : {detail.get('size_mb')} MB")
        print(f"     数据来源    : {detail.get('source')}")
        print(f"     预览图      : {detail.get('preview') or '(无)'}")
        print(f"     C 站链接    : {detail.get('url') or '(无)'}")
        print(f"     版本        : {civ.get('version_name') or '-'}")
        print(f"     下载量      : {detail.get('downloads')}")
        print(f"     标签        : {detail.get('tags')}")
        print(f"     触发词      : {detail.get('trained_words')}")
        print(f"     示例图      : {len(detail.get('remote_images') or [])} 张")
        if tr:
            keys = ["base_model_version", "network_dim", "network_alpha", "learning_rate",
                    "epochs", "max_train_steps", "resolution", "title"]
            picked = {k: tr[k] for k in keys if k in tr}
            print(f"     训练参数    : {picked}")
            top = tr.get("top_tags")
            if top:
                print(f"     高频标签    : {[t for t, _ in top[:8]]}")

    # ---------------------------------------------------------- 4. 哈希
    _line("4. SHA256 （缓存读写）")
    target = sample[0] if sample else (items[0] if items else None)
    if target is None:
        print("  无可测条目，跳过")
        return 1
    detail_deep = cft_metadata.get_lora_detail(target["lora"], deep=True)
    sha = (detail_deep or {}).get("sha256")
    print(f"  {target['lora']}")
    print(f"  SHA256 = {sha}")
    if not sha:
        failures.append("SHA256 计算失败")

    t1 = time.time()
    again = cft_metadata.get_lora_detail(target["lora"], deep=True)
    cached_cost = time.time() - t1
    print(f"  二次读取耗时 {cached_cost:.3f}s -> 命中缓存: {again.get('sha256') == sha}")

    # sidecar 里已有的哈希是否一致（校验解析正确性）
    sidecar_sha = ((detail_deep or {}).get("civitai") or {}).get("hashes", {}).get("SHA256")
    if sidecar_sha and sha and sidecar_sha.upper() != sha.upper():
        failures.append(f"SHA256 与 C 站记录不一致：{sidecar_sha} vs {sha}")
    print(f"  C 站记录 SHA256 = {sidecar_sha}")

    # ---------------------------------------------------------- 5. 安全
    _line("5. 路径穿越防护")
    for evil in ["../../../../Windows/System32/calc.exe", "..%2F..%2Fetc%2Fpasswd", "../../../secret.txt"]:
        resolved = cft_metadata.resolve_lora_path(evil)
        ok = resolved is None
        print(f"  {'[OK]  ' if ok else '[FAIL]'} 拒绝 {evil!r} -> {resolved}")
        if not ok:
            failures.append(f"路径穿越未拦截：{evil}")

    # ---------------------------------------------------------- 6. 协议
    _line("6. lora_stack 协议解析")
    from cft.cft_nodes import _parse_stack

    cases = [
        ("", 0),
        ("[]", 0),
        ('[{"lora":"a/b.safetensors","weight":0.8,"text_encoder_weight":0.5}]', 1),
        ('{"loras":[{"lora":"x.safetensors","weight":1}]}', 1),
        ("not-json", 0),
        ('[{"path":"p.safetensors","clip_weight":0.3,"hidden":true}]', 1),
    ]
    for raw, expect in cases:
        parsed = _parse_stack(raw)
        ok = len(parsed) == expect
        print(f"  {'[OK]  ' if ok else '[FAIL]'} {raw[:52]!r:56} -> {len(parsed)} 条")
        if not ok:
            failures.append(f"协议解析错误：{raw!r}")

    if cases[5][0]:
        p = _parse_stack(cases[5][0])[0]
        assert p["text_encoder_weight"] == 0.3 and p["hidden"] is True
        print("       字段别名 clip_weight -> text_encoder_weight、hidden 解析正确")

    # ---------------------------------------------------------- 汇总
    _line("结果")
    if failures:
        print(f"  [FAIL] 共 {len(failures)} 项问题：")
        for f in failures:
            print(f"    - {f}")
        return 1

    print("  [PASS] 全部检查通过")
    if args.json:
        print(json.dumps(items[:3], ensure_ascii=False, indent=2)[:3000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
