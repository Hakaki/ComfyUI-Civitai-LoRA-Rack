"""POST /cft_lora/refresh_batch 路由的 stub 测试（不启动 ComfyUI）。

做法：
- 用最小 stub 伪装 ComfyUI 的 server / nodes / folder_paths；
- import 插件包（会注册路由），拿到 refresh_batch 的处理函数；
- monkeypatch cft_metadata / cft_civitai 的阻塞函数为假实现；
- 直接以假 request 调用协程，断言其返回结构与分支逻辑。

用法：python tests/test_routes_batch.py
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import types

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

FAILURES = []


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"  {'[OK]  ' if ok else '[FAIL]'} {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)
    return ok


def install_stubs():
    server = types.ModuleType("server")

    class Routes:
        def __init__(self):
            self.registered = []  # (method, path, fn)

        def _reg(self, method):
            def deco(path):
                def wrapper(fn):
                    self.registered.append((method, path, fn))
                    return fn
                return wrapper
            return deco

        def get(self, path):
            return self._reg("GET")(path)

        def post(self, path):
            return self._reg("POST")(path)

    class PromptServerImpl:
        def __init__(self):
            self.routes = Routes()

    server.PromptServer = PromptServerImpl
    server.PromptServer.instance = PromptServerImpl()
    sys.modules["server"] = server

    nodes = types.ModuleType("nodes")
    nodes.EXTENSION_WEB_DIRS = {}
    sys.modules["nodes"] = nodes

    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_full_path = lambda kind, name: None
    sys.modules["folder_paths"] = folder_paths

    return server


class FakeRequest:
    """只实现 handler 用到的最小接口：await request.json()。"""

    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


def json_of(resp) -> dict:
    body = resp.body
    if body is None:
        body = getattr(resp, "text", "") or ""
    if isinstance(body, str):
        body = body.encode("utf-8")
    return json.loads(body.decode("utf-8"))


def main() -> int:
    print("=" * 68)
    print("加载插件（stub 环境）并取 refresh_batch 处理函数")
    print("=" * 68)
    server = install_stubs()
    spec = importlib.util.spec_from_file_location(
        "cft_plugin",
        os.path.join(PLUGIN_DIR, "__init__.py"),
        submodule_search_locations=[PLUGIN_DIR],
    )
    plugin = importlib.util.module_from_spec(spec)
    sys.modules["cft_plugin"] = plugin
    spec.loader.exec_module(plugin)

    routes_mod = sys.modules["cft_plugin.cft.cft_routes"]
    meta_mod = sys.modules["cft_plugin.cft.cft_metadata"]
    civ_mod = sys.modules["cft_plugin.cft.cft_civitai"]

    handler = None
    for method, path, fn in server.PromptServer.instance.routes.registered:
        if method == "POST" and path == "/cft_lora/refresh_batch":
            handler = fn
            break
    check("refresh_batch 路由已注册", handler is not None)
    if handler is None:
        return 1

    calls = {"invalidate": 0, "saved": [], "queried": []}

    # ---- monkeypatch 阻塞函数 ----
    def fake_scan(force=False, with_meta=True):
        return [
            {"lora": "miss1.safetensors"},  # 缺 C 站信息
            {"lora": "miss2.safetensors"},  # 缺 C 站信息
            {"lora": "has.safetensors", "creator": "x", "tags": ["a"], "trained_words": ["w"]},  # 已有信息
        ]

    def fake_resolve(name):
        if name == "boom.safetensors":
            raise RuntimeError("磁盘炸了")
        if name.startswith("gone"):
            return None
        return "/models/" + name

    def fake_detail(name, deep=True):
        return {"lora": name, "sha256": "HASH_" + name}

    def fake_query(h):
        calls["queried"].append(h)
        if h in ("HASH_miss1.safetensors", "HASH_ok.safetensors"):
            return {"name": "m", "creator": "author"}
        return {}

    def fake_save(abs_path, info):
        calls["saved"].append(abs_path)
        return abs_path + ".civitai.info"

    def fake_invalidate():
        calls["invalidate"] += 1

    meta_mod.scan_loras = fake_scan
    meta_mod.resolve_lora_path = fake_resolve
    meta_mod.get_lora_detail = fake_detail
    meta_mod.invalidate_cache = fake_invalidate
    civ_mod.query_by_hash = fake_query
    civ_mod.save_civitai_info = fake_save

    print()
    print("=" * 68)
    print("1. only_missing + names 为空 → 自动挑选「缺 C 站信息」条目")
    print("=" * 68)
    calls["invalidate"] = 0
    calls["saved"].clear()
    resp = asyncio.run(handler(FakeRequest({"names": [], "only_missing": True})))
    data = json_of(resp)
    check("返回 ok=True", data.get("ok") is True, json.dumps(data)[:120])
    payload = data.get("data") or {}
    names = [r["name"] for r in payload.get("results", [])]
    check("只挑选缺失项 miss1/miss2", sorted(names) == ["miss1.safetensors", "miss2.safetensors"], str(names))
    check("返回结构含 results/total/found/not_found/failed/truncated",
          {"results", "total", "found", "not_found", "failed", "truncated"} <= set(payload), str(sorted(payload)))
    check("miss1 命中 found=True", any(r["name"] == "miss1.safetensors" and r["found"] for r in payload["results"]))
    check("miss2 未收录 found=False 且无 error", any(r["name"] == "miss2.safetensors" and not r["found"] and not r["error"] for r in payload["results"]))
    check("命中写盘一次", len(calls["saved"]) == 1, str(calls["saved"]))
    check("invalidate_cache 调用一次", calls["invalidate"] == 1, str(calls["invalidate"]))

    print()
    print("=" * 68)
    print("2. 显式 names：命中 / 未收录 / 无 hash / 找不到 / 单条异常不中断")
    print("=" * 68)
    calls["invalidate"] = 0
    calls["saved"].clear()
    body = {"names": ["ok.safetensors", "miss2.safetensors", "gone1.safetensors", "boom.safetensors"], "only_missing": False}
    resp = asyncio.run(handler(FakeRequest(body)))
    payload = json_of(resp)["data"]
    by = {r["name"]: r for r in payload["results"]}
    check("total=4", payload["total"] == 4, str(payload["total"]))
    check("ok 命中", by["ok.safetensors"]["found"] is True, json.dumps(by["ok.safetensors"]))
    check("miss2 未收录（无 error）", by["miss2.safetensors"]["found"] is False and by["miss2.safetensors"]["error"] is None)
    check("gone1 记 error=not_found", by["gone1.safetensors"]["error"] == "not_found", json.dumps(by["gone1.safetensors"]))
    check("boom 单条异常被捕获（含 RuntimeError）", "RuntimeError" in str(by["boom.safetensors"]["error"]), json.dumps(by["boom.safetensors"]))
    check("found 计数=1", payload["found"] == 1, str(payload["found"]))
    check("failed 计数=2（gone1+boom）", payload["failed"] == 2, str(payload["failed"]))
    check("not_found 计数=1（miss2）", payload["not_found"] == 1, str(payload["not_found"]))

    print()
    print("=" * 68)
    print("3. 截断：超过 200 条只处理前 200 条并标注 truncated")
    print("=" * 68)
    calls["invalidate"] = 0
    many = [f"l{i}.safetensors" for i in range(250)]
    resp = asyncio.run(handler(FakeRequest({"names": many, "only_missing": False})))
    payload = json_of(resp)["data"]
    check("truncated=True", payload["truncated"] is True, str(payload["truncated"]))
    check("total=200", payload["total"] == 200, str(payload["total"]))

    print()
    print("=" * 68)
    print("4. 单条超时：error=timeout，不拖垮整批")
    print("=" * 68)
    import time as _time
    orig_timeout = routes_mod._BATCH_TIMEOUT
    routes_mod._BATCH_TIMEOUT = 0.05
    orig_query = civ_mod.query_by_hash

    def slow_query(h):
        _time.sleep(0.4)
        return {"name": "m"}

    civ_mod.query_by_hash = slow_query
    try:
        resp = asyncio.run(handler(FakeRequest({"names": ["slow.safetensors"], "only_missing": False})))
        payload = json_of(resp)["data"]
        rec = payload["results"][0]
        check("超时记 error=timeout", rec["error"] == "timeout", json.dumps(rec))
    finally:
        civ_mod.query_by_hash = orig_query
        routes_mod._BATCH_TIMEOUT = orig_timeout

    print()
    print("=" * 68)
    print("5. only_missing=False 且 names 为空 → 空批次，不发查询")
    print("=" * 68)
    calls["invalidate"] = 0
    resp = asyncio.run(handler(FakeRequest({"names": [], "only_missing": False})))
    payload = json_of(resp)["data"]
    check("total=0", payload["total"] == 0, str(payload["total"]))
    check("truncated=False", payload["truncated"] is False)
    check("invalidate 仍调用一次", calls["invalidate"] == 1, str(calls["invalidate"]))

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
    raise SystemExit(main())
