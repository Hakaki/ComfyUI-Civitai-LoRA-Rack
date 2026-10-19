"""插件加载与节点协议测试（用 stub 模拟 ComfyUI 运行时，无需启动 ComfyUI）。

用法：python tests/test_plugin.py
"""

from __future__ import annotations

import importlib.util
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
    """构造最小可用的 server / nodes / folder_paths stub。"""
    server = types.ModuleType("server")

    class Routes:
        def __init__(self):
            self.registered = []

        def _reg(self, method):
            def deco(path):
                def wrapper(fn):
                    self.registered.append((method, path, fn.__name__))
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

    # folder_paths stub：apply_loras 在「有激活条目」时会 import folder_paths，
    # 这里返回 None（找不到文件）让它安全跳过加载，仅验证协议解析不受权重越界影响。
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_full_path = lambda kind, name: None
    sys.modules["folder_paths"] = folder_paths

    return server, nodes


def main() -> int:
    print("=" * 68)
    print("1. 加载插件（stub 环境）")
    print("=" * 68)
    server, nodes = install_stubs()

    spec = importlib.util.spec_from_file_location(
        "cft_plugin",
        os.path.join(PLUGIN_DIR, "__init__.py"),
        submodule_search_locations=[PLUGIN_DIR],
    )
    plugin = importlib.util.module_from_spec(spec)
    sys.modules["cft_plugin"] = plugin
    spec.loader.exec_module(plugin)

    check("插件导入成功", True)
    check("节点映射存在", set(plugin.NODE_CLASS_MAPPINGS) == {"CFTLoraStack", "CFTLoraLoader"},
          str(list(plugin.NODE_CLASS_MAPPINGS)))
    check("WEB_DIRECTORY 指向 ./web", plugin.WEB_DIRECTORY == "./web", plugin.WEB_DIRECTORY)
    # v2.25：ComfyUI 会自动把 WEB_DIRECTORY 登记进 EXTENSION_WEB_DIRS，
    # 插件再手动登记会导致同一目录双 URL → 前端同一份 JS 加载两次（已修）
    # 手动注册时代用的键是 "cft-lora-stack"；改名后任何含 lora 的键都说明又手动注册了
    check("不再手动注册 EXTENSION_WEB_DIRS（避免双注册）",
          not any("lora" in str(k).lower() for k in nodes.EXTENSION_WEB_DIRS),
          str(list(nodes.EXTENSION_WEB_DIRS)))
    check("前端文件存在",
          os.path.isfile(os.path.join(PLUGIN_DIR, "web", "cft_lora_stack.js"))
          and os.path.isfile(os.path.join(PLUGIN_DIR, "web", "cft_lora_stack.css")))

    print()
    print("=" * 68)
    print("2. HTTP 路由注册")
    print("=" * 68)
    routes = server.PromptServer.instance.routes.registered
    expect = {
        ("GET", "/cft_lora/config"), ("GET", "/cft_lora/health"), ("GET", "/cft_lora/list"),
        ("POST", "/cft_lora/reload"), ("GET", "/cft_lora/detail"), ("POST", "/cft_lora/refresh"),
        ("POST", "/cft_lora/refresh_batch"),
        # 设置弹窗：C 站 API Key 校验 / 写入（cft_routes，v2.21）
        ("POST", "/cft_lora/config/test"), ("POST", "/cft_lora/config/set"),
        ("GET", "/cft_lora/preview"), ("GET", "/cft_lora/image"), ("GET", "/cft_lora/folders"),
        # 清理与文件操作（cft_cleanup）
        ("POST", "/cft_lora/cleanup_scan"), ("POST", "/cft_lora/cleanup"),
        ("GET", "/cft_lora/cleanup_trash"), ("POST", "/cft_lora/cleanup_restore"),
        ("POST", "/cft_lora/trash_delete"),
        ("GET", "/cft_lora/bundle"), ("POST", "/cft_lora/reveal"),
        ("POST", "/cft_lora/delete_local"),
        # 用户自定义数据（cft_userdata）
        ("GET", "/cft_lora/user_meta"), ("POST", "/cft_lora/user_meta"),
        ("GET", "/cft_lora/user_tags"), ("POST", "/cft_lora/set_cover"),
        ("POST", "/cft_lora/clear_cover"),
    }
    got = {(m, p) for m, p, _ in routes}
    for m, p in sorted(expect):
        check(f"{m:4} {p}", (m, p) in got)
    check("无多余路由", got == expect, f"多出 {got - expect}" if got - expect else "")

    print()
    print("=" * 68)
    print("3. 节点协议")
    print("=" * 68)
    stack_cls = plugin.NODE_CLASS_MAPPINGS["CFTLoraStack"]
    it = stack_cls.INPUT_TYPES()
    check("CFTLoraStack 有 lora_stack 输入", "lora_stack" in it["required"])
    check("CFTLoraStack 支持 model/clip 可选输入",
          {"model", "clip"} <= set(it.get("optional", {})))
    check("CFTLoraStack 返回 CLIP/MODEL/触发词",
          tuple(stack_cls.RETURN_TYPES) == ("CLIP", "MODEL", "STRING"), str(stack_cls.RETURN_TYPES))
    check("CFTLoraStack.FUNCTION 可调用",
          callable(getattr(stack_cls(), stack_cls.FUNCTION, None)), stack_cls.FUNCTION)

    loader_cls = plugin.NODE_CLASS_MAPPINGS["CFTLoraLoader"]
    check("CFTLoraLoader.FUNCTION 可调用",
          callable(getattr(loader_cls(), loader_cls.FUNCTION, None)), loader_cls.FUNCTION)

    print()
    print("=" * 68)
    print("3b. 权重不钳制（协议层：任意实数原样保留，不截断到 -3~3）")
    print("=" * 68)
    from cft.cft_nodes import _parse_stack

    raw = ('[{"lora":"w.safetensors","weight":-5,'
           '"text_encoder_weight":7.25,"trigger_weight":-3.5}]')
    p = _parse_stack(raw)[0]
    check("weight=-5 原样保留", p["weight"] == -5, str(p["weight"]))
    check("text_encoder_weight=7.25 原样保留", p["text_encoder_weight"] == 7.25, str(p["text_encoder_weight"]))
    check("trigger_weight=-3.5 原样保留", p["trigger_weight"] == -3.5, str(p["trigger_weight"]))

    p2 = _parse_stack('[{"lora":"w2.safetensors","weight":100.25}]')[0]
    check("weight=100.25 原样保留", p2["weight"] == 100.25, str(p2["weight"]))

    p3 = _parse_stack('[{"lora":"w3.safetensors"}]')[0]
    check("缺省 weight 回退 1.0", p3["weight"] == 1.0, str(p3["weight"]))
    check("缺省 trigger_weight 回退 0.0", p3["trigger_weight"] == 0.0, str(p3["trigger_weight"]))

    probe = stack_cls()
    try:
        out = probe.apply_loras(lora_stack=raw, model="MODEL", clip="CLIP")
        check("越界权重 apply_loras 不抛异常且透传", out[:2] == ("CLIP", "MODEL"), f"{out[0]}/{out[1]}")
    except Exception as exc:
        check("越界权重 apply_loras 不抛异常且透传", False, f"{type(exc).__name__}: {exc}")

    print()
    print("=" * 68)
    print("4. 执行逻辑（空堆 / 非法输入应原样透传，不抛异常）")
    print("=" * 68)
    inst = stack_cls()
    for raw in ["[]", "", "not-json", '{"loras":[]}']:
        try:
            out = inst.apply_loras(lora_stack=raw, model="MODEL", clip="CLIP")
            check(f"apply_loras({raw!r}) 透传", out[:2] == ("CLIP", "MODEL"),
                  f"返回 {out[0]} / {out[1]}")
        except Exception as exc:
            check(f"apply_loras({raw!r}) 透传", False, f"{type(exc).__name__}: {exc}")

    # 全部 hidden 时也应透传
    hidden = '[{"lora":"a/b.safetensors","weight":1,"hidden":true}]'
    try:
        out = inst.apply_loras(lora_stack=hidden, model="MODEL", clip="CLIP")
        check("全部隐藏时透传", out[:2] == ("CLIP", "MODEL"))
    except Exception as exc:
        check("全部隐藏时透传", False, f"{type(exc).__name__}: {exc}")

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
