"""C 站 model 级字段补齐的回归测试（monkeypatch 掉网络层，不需要启动 ComfyUI）。

背景：``/api/v1/model-versions/by-hash/{hash}`` 只返回**版本级**字段，
``creator`` / ``tags`` / ``description`` 挂在 ``/api/v1/models/{id}`` 上。
早期只查 by-hash 就把结果写回 .civitai.info，于是写回的文件永远缺作者/标签/简介，
界面显示「有 C 站信息」却列不出作者（用户实测：Anima V2）。

用法：python tests/test_civitai_enrich.py
"""

from __future__ import annotations

import os
import sys
import types

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

# ComfyUI 运行时 stub：只用网络层与配置
sys.modules.setdefault("folder_paths", types.ModuleType("folder_paths"))

from cft import cft_civitai  # noqa: E402

FAILURES = []


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'[OK]  ' if ok else '[FAIL]'} {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)
    return ok


# 与线上真实响应同构：by-hash 只有版本级字段；models 才有 creator/tags/description
BY_HASH_VERSION = {
    "id": 998877,
    "modelId": 2638819,
    "name": "Anima V2",
    "baseModel": "Anima",
    "description": "",
    "trainedWords": [],
    "stats": {"downloadCount": 2179, "thumbsUpCount": 207},
    "files": [{"name": "748cm_v2_anima.safetensors", "sizeKB": 89725.125,
               "hashes": {"SHA256": "C04BA8", "AutoV2": "C04BA8"}}],
    "images": [{"url": "https://image.civitai.com/x.jpeg", "width": 512, "height": 512}],
    # by-hash 内嵌的 model 只是个 stub，没有 creator/tags
    "model": {"name": "Anima", "nsfw": False, "type": "LORA"},
}

MODEL_LEVEL = {
    "id": 2638819,
    "name": "Anima",
    "type": "LORA",
    "creator": {"username": "some_author", "imageUrl": ""},
    "description": "<p>artist styles, <b>anima</b></p>",
    "tags": ["anima", "style", "character"],
    "modelVersions": [{"id": 998877}],
}

HASH = "C04BA86523BAE56F1DA319EB9B6120A6D5F98D505427BD9365375F8C6CED09EF"


def install_fake(by_hash=BY_HASH_VERSION, model=MODEL_LEVEL, raise_on_model=False):
    """替换网络层，返回调用记录列表。"""
    calls = []

    def fake_get_json(path: str):
        calls.append(path)
        if path.startswith("/api/v1/model-versions/by-hash/"):
            return by_hash
        if path.startswith("/api/v1/models/"):
            if raise_on_model:
                raise RuntimeError("模拟模型接口 500")
            return model
        return None

    cft_civitai._get_json = fake_get_json
    cft_civitai._MODEL_LEVEL_CACHE.clear()
    return calls


def main() -> int:
    print("=" * 68)
    print("1. by-hash 缺作者/标签/简介 → 用 model 级补齐")
    print("=" * 68)
    calls = install_fake()
    got = cft_civitai.query_by_hash(HASH)
    check("补齐后拿到 creator", got.get("creator") == "some_author", str(got.get("creator")))
    check("补齐后拿到 tags", got.get("tags") == ["anima", "style", "character"], str(got.get("tags")))
    check("补齐后拿到 description（HTML 已转纯文本）", "anima" in (got.get("description") or "") and "<p>" not in (got.get("description") or ""), repr(got.get("description"))[:60])
    check("版本级字段未受影响（name/baseModel/stats）",
          got.get("name") == "Anima V2" and got.get("baseModel") == "Anima" and (got.get("stats") or {}).get("downloadCount") == 2179,
          f"name={got.get('name')} baseModel={got.get('baseModel')}")
    check("url 由 modelId 拼出", (got.get("url") or "").endswith("/models/2638819"), str(got.get("url")))
    check("确实多打了一次 /models 请求", any(p.startswith("/api/v1/models/") for p in calls), str(calls))

    print()
    print("=" * 68)
    print("2. by-hash 已自带 creator/tags 时不得被覆盖")
    print("=" * 68)
    rich = dict(BY_HASH_VERSION)
    rich["creator"] = "version_author"
    rich["tags"] = ["ver_tag"]
    rich["description"] = "ver desc"
    install_fake(by_hash=rich)
    got2 = cft_civitai.query_by_hash(HASH)
    check("creator 保留版本级的值", got2.get("creator") == "version_author", str(got2.get("creator")))
    check("tags 保留版本级的值", got2.get("tags") == ["ver_tag"], str(got2.get("tags")))
    check("description 保留版本级的值", got2.get("description") == "ver desc", str(got2.get("description")))

    print()
    print("=" * 68)
    print("3. model 接口失败时优雅降级（仍返回版本级信息）")
    print("=" * 68)
    install_fake(raise_on_model=True)
    try:
        got3 = cft_civitai.query_by_hash(HASH)
        check("model 接口异常不抛错", True)
        check("仍拿到版本级 name", got3.get("name") == "Anima V2", str(got3.get("name")))
        check("拿不到 creator 时留空（不编造）", not got3.get("creator"), str(got3.get("creator")))
    except Exception as exc:
        check("model 接口异常不抛错", False, f"{type(exc).__name__}: {exc}")

    install_fake(model=None)
    got4 = cft_civitai.query_by_hash(HASH)
    check("model 接口无数据时降级", got4.get("name") == "Anima V2" and not got4.get("creator"), "")

    print()
    print("=" * 68)
    print("4. by-hash 查不到时不发多余的 model 请求")
    print("=" * 68)
    calls = install_fake(by_hash=None)
    got5 = cft_civitai.query_by_hash(HASH)
    check("返回空结果", got5 == {}, str(got5))
    check("没有多打 /models 请求", not any(p.startswith("/api/v1/models/") for p in calls), str(calls))

    print()
    print("=" * 68)
    print("5. 同一模型的多个版本只查一次 model（缓存）")
    print("=" * 68)
    calls = install_fake()
    cft_civitai.query_by_hash(HASH)
    cft_civitai.query_by_hash(HASH)
    cft_civitai.query_by_hash(HASH)
    model_calls = [p for p in calls if p.startswith("/api/v1/models/")]
    check("3 次查询只打 1 次 model 接口", len(model_calls) == 1, f"实际 {len(model_calls)} 次")

    print()
    print("=" * 68)
    print("结果")
    print("=" * 68)
    if FAILURES:
        print(f"  [FAIL] {len(FAILURES)} 项未通过：")
        for f in FAILURES:
            print(f"    - {f}")
        return 1
    print("  [PASS] 全部检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
