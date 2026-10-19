"""cft_config.set_api_key / cft_civitai.test_api_key 离线自测。

隔离策略：用临时目录 + 环境变量 CLR_CONFIG 指向临时 config.json，
确保不会触碰机器上真实的插件配置。
- set_api_key：写回 config.json 的 api_key，且 merge 不覆盖其他字段；
  get_api_key 能重新读到；get_status 的 has_api_key / api_key_masked 正确。
- test_api_key：返回结构为 dict 且含 'ok' 键（无网环境下应为 False，不崩）。
"""

import importlib.util
import json
import os
import sys
import tempfile
import types

PLUGIN = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
PKG_DIR = os.path.join(PLUGIN, "cft")


def _load():
    # 构造一个最小的 cft 包，仅挂 cft_config 与 cft_civitai（二者互相 import）
    pkg = types.ModuleType("cft")
    pkg.__path__ = [PKG_DIR]
    sys.modules["cft"] = pkg

    cfg_spec = importlib.util.spec_from_file_location("cft.cft_config", os.path.join(PKG_DIR, "cft_config.py"))
    cfg = importlib.util.module_from_spec(cfg_spec)
    sys.modules["cft.cft_config"] = cfg
    cfg_spec.loader.exec_module(cfg)

    civ_spec = importlib.util.spec_from_file_location("cft.cft_civitai", os.path.join(PKG_DIR, "cft_civitai.py"))
    civ = importlib.util.module_from_spec(civ_spec)
    sys.modules["cft.cft_civitai"] = civ
    civ_spec.loader.exec_module(civ)
    return cfg, civ


def _check(name, cond):
    print(("  PASS " if cond else "  FAIL ") + name)
    if not cond:
        raise SystemExit("测试未通过：" + name)


def main():
    cfg, civ = _load()

    with tempfile.TemporaryDirectory() as td:
        cfg_path = os.path.join(td, "config.json")
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump({"proxy_enabled": False, "site_domain": "civitai.com"}, f)
        os.environ["CLR_CONFIG"] = cfg_path

        # ---- set_api_key 写读闭环 + merge ----
        status = cfg.set_api_key("sk-test-abcdef123456")
        raw = json.load(open(cfg_path, encoding="utf-8"))
        _check("set_api_key 写入 api_key", raw.get("api_key") == "sk-test-abcdef123456")
        _check("set_api_key 不覆盖其他字段(proxy_enabled)", raw.get("proxy_enabled") is False)
        _check("set_api_key 不覆盖其他字段(site_domain)", raw.get("site_domain") == "civitai.com")
        _check("get_api_key 重新读到", cfg.get_api_key() == "sk-test-abcdef123456")
        _check("get_status.has_api_key", bool(status.get("has_api_key")))
        _check("get_status.api_key_masked 脱敏", str(status.get("api_key_masked", "")).endswith("3456"))

        # 清空
        cfg.set_api_key("")
        _check("清空后 get_api_key 为空", cfg.get_api_key() == "")
        _check("清空后 has_api_key 为 False", not cfg.get_status().get("has_api_key"))

    # ---- test_api_key 返回结构（无网环境下应为 ok=False，但不崩）----
    for key in ("", "sk-bogus-invalid"):
        info = civ.test_api_key(key)
        _check(f"test_api_key({key!r}) 返回 dict", isinstance(info, dict))
        _check(f"test_api_key({key!r}) 含 'ok' 键", "ok" in info)
        print(f"    [info] key={key!r} -> {info.get('reason') or info.get('message')}")

    print("\nALL PASS")


if __name__ == "__main__":
    main()
