"""用户自定义数据（标签 / 简介 / 封面）的隔离测试（临时目录，不碰真实 lora）。

直接以脚本方式运行（不依赖 pytest）：
    python tests/test_userdata.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import traceback
from typing import Any, Callable, Dict, List, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cft import cft_civitai, cft_config, cft_metadata, cft_userdata  # noqa: E402

_ROOT: str = ""
_SAVED: Any = None

DEFAULT_USER: Dict[str, Any] = {
    "tags": [], "note": "", "cover": None, "favorite": False, "exists": False,
}

PASS = 0
FAIL: List[str] = []


def check(cond: bool, label: str) -> None:
    global PASS
    if cond:
        PASS += 1
    else:
        FAIL.append(label)
        print(f"    ✗ {label}")


def group(name: str) -> Callable:
    def deco(fn):
        fn._group = name  # type: ignore[attr-defined]
        return fn
    return deco


def mk_lora(name: str, size: int = 64) -> str:
    p = os.path.join(_ROOT, name.replace("/", os.sep))
    os.makedirs(os.path.dirname(p) or _ROOT, exist_ok=True)
    with open(p, "wb") as f:
        f.write(b"z" * size)
    return p


def write_bytes(rel: str, data: bytes) -> str:
    p = os.path.join(_ROOT, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(p) or _ROOT, exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    return p


def read_bytes(rel: str) -> bytes:
    with open(os.path.join(_ROOT, rel.replace("/", os.sep)), "rb") as f:
        return f.read()


def R() -> str:
    return _ROOT


# ------------------------------------------------------------------ 场景搭建


def setup() -> None:
    global _ROOT, _SAVED
    _SAVED = cft_config.resolve_loras_dirs
    _ROOT = tempfile.mkdtemp(prefix="cft_userdata_test_")
    cft_config.resolve_loras_dirs = lambda: [_ROOT]  # type: ignore[assignment]


def teardown() -> None:
    global _SAVED
    cft_config.resolve_loras_dirs = _SAVED  # type: ignore[assignment]
    if _ROOT and os.path.isdir(_ROOT):
        shutil.rmtree(_ROOT, ignore_errors=True)


# ------------------------------------------------------------------ 用例


@group("读写往返：tags + note")
def t_read_write() -> None:
    mk_lora("rw.safetensors")

    d0 = cft_userdata.read("rw.safetensors")
    check(d0 == DEFAULT_USER, f"未写时返回默认形态（实际 {d0}）")

    d1 = cft_userdata.write(
        "rw.safetensors",
        tags=[" 风格 ", "风格", "", "人物"],
        note="第一行\n第二行",
    )
    check(d1["tags"] == ["风格", "人物"], f"标签去空/去重/去空格（实际 {d1['tags']}）")
    check(d1["note"] == "第一行\n第二行", "简介原样保存（含换行）")
    check(d1["exists"] is True, "写入后 exists=True")

    d2 = cft_userdata.read("rw.safetensors")
    check(d2 == d1, f"读回与写入一致（{d2} != {d1}）")

    # 磁盘上的文件确实是 <base>.cft-user.json
    p = cft_userdata.user_path("rw.safetensors")
    check(p is not None and os.path.basename(p) == "rw.cft-user.json",
          f"文件名应为 rw.cft-user.json（实际 {p}）")
    # 原子写不留 tmp 残留
    leftover = [f for f in os.listdir(R()) if f.endswith(".tmp")]
    check(leftover == [], f"原子写无 tmp 残留（{leftover}）")


@group("部分更新：不丢未传字段")
def t_partial_update() -> None:
    mk_lora("pu.safetensors")
    cft_userdata.write("pu.safetensors", tags=["T1"], note="N1")

    cft_userdata.write("pu.safetensors", note="N2")
    d = cft_userdata.read("pu.safetensors")
    check(d["tags"] == ["T1"], f"只写 note 时 tags 应保留（实际 {d['tags']}）")
    check(d["note"] == "N2", "note 已更新")

    cft_userdata.write("pu.safetensors", tags=["T2"])
    d = cft_userdata.read("pu.safetensors")
    check(d["tags"] == ["T2"], "tags 已更新")
    check(d["note"] == "N2", f"只写 tags 时 note 应保留（实际 {d['note']!r}）")


@group("健壮性：不存在 / JSON 损坏都不抛异常")
def t_missing_and_corrupt() -> None:
    d = cft_userdata.read("not-there.safetensors")
    check(d == DEFAULT_USER, "lora 不存在时返回默认形态")

    mk_lora("corrupt.safetensors")
    p = cft_userdata.user_path("corrupt.safetensors")
    assert p is not None
    with open(p, "w", encoding="utf-8") as f:
        f.write("{ this is not valid json :::")
    try:
        d = cft_userdata.read("corrupt.safetensors")
        check(d == DEFAULT_USER, f"JSON 损坏时返回默认形态（实际 {d}）")
    except Exception as exc:
        check(False, f"JSON 损坏时 read 不应抛异常：{type(exc).__name__}: {exc}")

    # 空文件
    with open(p, "w", encoding="utf-8") as f:
        f.write("")
    check(cft_userdata.read("corrupt.safetensors") == DEFAULT_USER, "空 JSON 文件返回默认形态")

    # 顶层不是 dict（数组）
    with open(p, "w", encoding="utf-8") as f:
        f.write("[1, 2, 3]")
    check(cft_userdata.read("corrupt.safetensors") == DEFAULT_USER, "顶层非对象返回默认形态")

    check(cft_userdata.read("") == DEFAULT_USER, "空名返回默认形态")
    check(cft_userdata.read("../../etc/passwd") == DEFAULT_USER, "越界名返回默认形态")


@group("封面：set_cover(remote) 字段正确")
def t_set_cover_remote() -> None:
    mk_lora("cov.safetensors")
    d = cft_userdata.set_cover("cov.safetensors", "https://image.civitai.com/x.jpeg")
    cov = d["cover"] or {}
    check(cov.get("kind") == "remote", f"kind=remote（实际 {cov.get('kind')}）")
    check(cov.get("url") == "https://image.civitai.com/x.jpeg", "url 正确")
    check(cov.get("type") == "image", f"type=image（实际 {cov.get('type')}）")
    check("set_at" in cov, "带 set_at 时间戳")
    check(not os.path.isfile(os.path.join(R(), "cov.preview.png")),
          "remote 封面不应派生本地预览图")

    d2 = cft_userdata.set_cover("cov.safetensors", "https://image.civitai.com/y.mp4", is_video=True)
    check((d2["cover"] or {}).get("type") == "video", "is_video=True -> type=video")
    check((d2["cover"] or {}).get("kind") == "remote", "仍是 remote")

    # 空 url 必须被拒
    try:
        cft_userdata.set_cover("cov.safetensors", "")
        check(False, "空 url 应被拒")
    except ValueError:
        check(True, "空 url 抛 ValueError")


@group("封面：download_cover 失败抛异常 / 成功落地")
def t_download_cover() -> None:
    mk_lora("dl.safetensors")
    saved = cft_civitai._build_session

    # --- 失败：会话构造直接抛错
    def boom():
        raise RuntimeError("网络不可用（已 mock）")

    cft_civitai._build_session = boom  # type: ignore[assignment]
    try:
        try:
            cft_userdata.download_cover("dl.safetensors", "https://image.civitai.com/z.png")
            check(False, "下载失败应抛异常")
        except Exception as exc:
            check(True, f"下载失败抛异常（{type(exc).__name__}）")

        try:
            cft_userdata.set_cover("dl.safetensors", "https://image.civitai.com/z.png", kind="downloaded")
            check(False, "set_cover(downloaded) 下载失败应抛异常")
        except Exception:
            check(True, "set_cover(downloaded) 下载失败抛异常")
    finally:
        cft_civitai._build_session = saved  # type: ignore[assignment]

    # --- 成功：假会话返回内容
    class FakeResp:
        status_code = 200
        content = b"FAKE_IMAGE_BYTES"

    class FakeSession:
        def get(self, url, timeout=None):  # noqa: ARG002
            return FakeResp()

    cft_civitai._build_session = lambda: FakeSession()  # type: ignore[assignment]
    try:
        name = cft_userdata.download_cover("dl.safetensors", "https://image.civitai.com/z.png")
        check(name == "dl.preview.png", f"图片落地为 dl.preview.png（实际 {name}）")
        check(read_bytes("dl.preview.png") == b"FAKE_IMAGE_BYTES", "图片内容正确")

        # 视频：必须落成 .mp4，不能写成 .png
        name2 = cft_userdata.download_cover("dl.safetensors", "https://image.civitai.com/v.mp4")
        check(name2 == "dl.preview.mp4", f"视频落地为 dl.preview.mp4（实际 {name2}）")
        check(read_bytes("dl.preview.mp4") == b"FAKE_IMAGE_BYTES", "视频内容正确")

        d = cft_userdata.set_cover(
            "dl.safetensors", "https://image.civitai.com/w.png", kind="downloaded"
        )
        cov = d["cover"] or {}
        check(cov.get("kind") == "downloaded", "kind=downloaded")
        check(os.path.isfile(os.path.join(R(), "dl.preview.png")), "downloaded 落地预览图")
    finally:
        cft_civitai._build_session = saved  # type: ignore[assignment]

    # --- 下载失败时不留 .part 残留
    leftovers = [f for f in os.listdir(R()) if f.endswith(".part")]
    check(leftovers == [], f"下载失败不留 .part（{leftovers}）")


@group("封面：clear_cover 还原备份 + 删视频")
def t_clear_cover_restore() -> None:
    mk_lora("clr.safetensors")
    write_bytes("clr.preview.png", b"CONTENT_A")
    write_bytes("clr.preview.bak.png", b"CONTENT_B")

    # 记录一个「下载型」封面，带备份文件名
    cft_userdata.write(
        "clr.safetensors",
        cover={
            "kind": "downloaded",
            "url": "https://image.civitai.com/a.jpeg",
            "type": "image",
            "backup": "clr.preview.bak.png",
        },
    )
    check(cft_metadata.find_preview(R(), "clr.safetensors") is not None, "清理前能查到预览图")

    d = cft_userdata.clear_cover("clr.safetensors")
    check(d["cover"] is None, f"clear 后 cover 为 None（实际 {d['cover']}）")
    check(read_bytes("clr.preview.png") == b"CONTENT_B",
          f"预览图应还原成备份内容（实际 {read_bytes('clr.preview.png')!r}）")
    check(cft_metadata.find_preview(R(), "clr.safetensors") is not None,
          "还原后 find_preview 仍能找到预览图")

    # 视频封面一并删除
    mk_lora("clrv.safetensors")
    write_bytes("clrv.preview.mp4", b"VIDEO")
    cft_userdata.write(
        "clrv.safetensors",
        cover={"kind": "downloaded", "url": "https://image.civitai.com/v.mp4", "type": "video"},
    )
    cft_userdata.clear_cover("clrv.safetensors")
    check(not os.path.isfile(os.path.join(R(), "clrv.preview.mp4")), "视频封面被删除")

    # 没有 backup 的 remote 封面：clear 只删记录，不动任何预览图
    mk_lora("clrr.safetensors")
    write_bytes("clrr.preview.png", b"KEEP_ME")
    cft_userdata.set_cover("clrr.safetensors", "https://image.civitai.com/r.jpeg")
    cft_userdata.clear_cover("clrr.safetensors")
    check(read_bytes("clrr.preview.png") == b"KEEP_ME", "remote 封面清除不影响原有预览图")


@group("安全：路径越界一律被拒")
def t_path_traversal() -> None:
    check(cft_userdata.read("../../etc/passwd") == DEFAULT_USER, "越界 read 返回默认")
    check(cft_userdata.user_path("../../etc/passwd") is None, "越界 user_path 返回 None")

    cases = [
        ("write", lambda: cft_userdata.write("../../etc/passwd", note="x")),
        ("set_cover", lambda: cft_userdata.set_cover("../../etc/passwd", "https://x/y.png")),
        ("download_cover", lambda: cft_userdata.download_cover("../../etc/passwd", "https://x/y.png")),
        ("clear_cover", lambda: cft_userdata.clear_cover("../../etc/passwd")),
        ("write 绝对路径", lambda: cft_userdata.write("/etc/passwd", note="x")),
        ("write 不存在", lambda: cft_userdata.write("ghost.safetensors", note="x")),
    ]
    for label, fn in cases:
        try:
            fn()
            check(False, f"{label} 越界/不存在应被拒")
        except ValueError:
            check(True, f"{label} 被拒")
        except Exception as exc:
            check(False, f"{label} 应抛 ValueError（实际 {type(exc).__name__}: {exc}）")


@group("汇总：list_user_tags / scan_user_data")
def t_aggregate() -> None:
    mk_lora("agg1.safetensors")
    mk_lora("agg2.safetensors")
    mk_lora("sub/agg3.safetensors")
    cft_userdata.write("agg1.safetensors", tags=["beta", "alpha"])
    cft_userdata.write("agg2.safetensors", tags=["alpha", "gamma"])
    cft_userdata.write("sub/agg3.safetensors", tags=["delta"])

    tags = cft_userdata.list_user_tags()
    # 同一临时目录里前面的用例也写过标签，因此只断言「本用例的标签被汇总」+ 去重有序的性质
    for t in ("alpha", "beta", "delta", "gamma"):
        check(t in tags, f"标签 {t} 应被汇总（实际 {tags}）")
    check(tags == sorted(set(tags)), f"返回已排序且去重（实际 {tags}）")
    check(tags.count("alpha") == 1, "跨文件重复标签只出现一次")

    m = cft_userdata.scan_user_data()
    check("agg1.safetensors" in m and m["agg1.safetensors"]["tags"] == ["beta", "alpha"],
          "scan_user_data 含根目录条目")
    check("sub/agg3.safetensors" in m and m["sub/agg3.safetensors"]["tags"] == ["delta"],
          "scan_user_data 含子目录条目（相对路径用 /）")


@group("合并：_build_item / get_lora_detail 带上用户数据")
def t_merge_into_items() -> None:
    mk_lora("mg.safetensors")
    cft_userdata.write("mg.safetensors", tags=["我的标签"], note="我的简介")

    cft_metadata.invalidate_cache()
    items = cft_metadata.scan_loras(force=True, with_meta=False)
    found = [it for it in items if it.get("lora") == "mg.safetensors"]
    check(len(found) == 1, "扫描能找到 mg.safetensors")
    if found:
        it = found[0]
        check(it.get("user_tags") == ["我的标签"], f"user_tags 合并（实际 {it.get('user_tags')}）")
        check(it.get("user_note") == "我的简介", "user_note 合并")
        check(it.get("has_user") is True, "has_user=True")

    cft_userdata.set_cover("mg.safetensors", "https://image.civitai.com/mg.jpeg")
    det = cft_metadata.get_lora_detail("mg.safetensors", deep=False)
    assert det is not None
    check(det.get("user_tags") == ["我的标签"], "详情带 user_tags")
    check(det.get("cover_url") == "https://image.civitai.com/mg.jpeg", "详情带 cover_url")
    check(det.get("cover_type") == "image", "详情带 cover_type")

    # 没有自定义数据的 lora：字段存在但为空
    mk_lora("plain.safetensors")
    cft_metadata.invalidate_cache()
    items = cft_metadata.scan_loras(force=True, with_meta=False)
    plain = [it for it in items if it.get("lora") == "plain.safetensors"][0]
    check(plain.get("user_tags") == [], "无自定义数据时 user_tags=[]")
    check(plain.get("has_user") is False, "无自定义数据时 has_user=False")
    check(plain.get("cover_url") == "", "无自定义数据时 cover_url=''")


@group("隔离：刷新 C 站不覆盖用户数据")
def t_civitai_does_not_touch_user_data() -> None:
    mk_lora("iso.safetensors")
    cft_userdata.write("iso.safetensors", tags=["KEEP"], note="KEEP_NOTE")
    cft_userdata.write(
        "iso.safetensors",
        cover={"kind": "remote", "url": "https://image.civitai.com/k.jpeg", "type": "image"},
    )

    saved = cft_civitai.save_civitai_info(os.path.join(R(), "iso.safetensors"),
                                          {"name": "C站名", "creator": "作者", "tags": ["c站标签"]})

    check(saved is not None and os.path.isfile(os.path.join(R(), "iso.civitai.info")),
          "C 站信息写入独立的 .civitai.info")
    d = cft_userdata.read("iso.safetensors")
    check(d["tags"] == ["KEEP"], f"刷新 C 站后自定义标签仍在（实际 {d['tags']}）")
    check(d["note"] == "KEEP_NOTE", "自定义简介仍在")
    check((d["cover"] or {}).get("url") == "https://image.civitai.com/k.jpeg", "自定义封面仍在")


@group("工具：_strip_lora_ext")
def t_strip_ext() -> None:
    check(cft_metadata._strip_lora_ext("x.safetensors") == "x", "x.safetensors -> x")
    check(cft_metadata._strip_lora_ext("my.lora.v2.safetensors") == "my.lora.v2",
          "带点的名字只去扩展名")
    check(cft_metadata._strip_lora_ext("a.b.ckpt") == "a.b", "a.b.ckpt -> a.b")
    mk_lora("dot.name.safetensors")
    p = cft_userdata.user_path("dot.name.safetensors")
    check(p is not None and os.path.basename(p) == "dot.name.cft-user.json",
          f"带点文件名的用户数据文件名正确（实际 {p}）")


@group("收藏：favorite 读写 / 部分更新 / 旧文件兼容")
def t_favorite() -> None:
    # 1) 默认形态：未收藏
    mk_lora("fav.safetensors")
    d0 = cft_userdata.read("fav.safetensors")
    check(d0.get("favorite") is False, f"未收藏时 favorite=False（实际 {d0.get('favorite')!r}）")

    # 2) write(favorite=True) -> 读回 True，且返回体带 favorite
    d1 = cft_userdata.write("fav.safetensors", favorite=True)
    check(d1.get("favorite") is True, f"write favorite=True 后返回 True（实际 {d1.get('favorite')!r}）")
    d2 = cft_userdata.read("fav.safetensors")
    check(d2.get("favorite") is True, "读回 favorite=True")
    check(d2["exists"] is True, "写入后 exists=True")

    # 3) 部分更新：只写 note 不该冲掉收藏（None = 不改）
    d3 = cft_userdata.write("fav.safetensors", note="随便写点")
    check(d3.get("favorite") is True, f"只写 note 后 favorite 仍为 True（实际 {d3.get('favorite')!r}）")
    # 只写 tags 同理
    d4 = cft_userdata.write("fav.safetensors", tags=["x"])
    check(d4.get("favorite") is True, f"只写 tags 后 favorite 仍为 True（实际 {d4.get('favorite')!r}）")
    check(d4.get("note") == "随便写点", "只写 tags 后 note 保留")

    # 4) write(favorite=False) -> 取消收藏
    d5 = cft_userdata.write("fav.safetensors", favorite=False)
    check(d5.get("favorite") is False, "write favorite=False 后取消收藏")
    check(cft_userdata.read("fav.safetensors").get("favorite") is False, "读回 favorite=False")

    # 5) 非布尔 favorite 按「不改」处理（路由层已挡，这里兜底）
    d6 = cft_userdata.write("fav.safetensors", tags=["y"], note="keep-me")
    check(d6.get("favorite") is False, "未传 favorite 时保持 False")

    # 6) 旧文件（没有 favorite 键）兼容：读出 False，写入时补默认键
    mk_lora("old.safetensors")
    op = cft_userdata.user_path("old.safetensors")
    assert op is not None
    with open(op, "w", encoding="utf-8") as f:
        f.write('{"version": 1, "tags": ["旧标签"], "note": "", "cover": null}')
    d7 = cft_userdata.read("old.safetensors")
    check(d7.get("favorite") is False, f"旧文件无 favorite 键时读出 False（实际 {d7.get('favorite')!r}）")
    check(d7.get("tags") == ["旧标签"], "旧文件标签正常读出")
    cft_userdata.write("old.safetensors", note="补一笔")
    import json as _json
    with open(op, "r", encoding="utf-8") as f:
        raw = _json.load(f)
    check(raw.get("favorite") is False, "旧文件再写入时补上 favorite=false")
    check(raw.get("tags") == ["旧标签"], "旧文件标签未被清掉")

    # 7) _shape 默认值
    s = cft_userdata._shape([], "", None, False)
    check(s.get("favorite") is False, f"_shape 默认 favorite=False（实际 {s.get('favorite')!r}）")
    check("favorite" in s, "_shape 输出含 favorite 键")


@group("收藏：随 /list 合并下发，且刷新 C 站不影响")
def t_favorite_merged_into_list() -> None:
    mk_lora("favlist.safetensors")
    cft_userdata.write("favlist.safetensors", tags=["F"], favorite=True)
    mk_lora("favlist2.safetensors")
    cft_userdata.write("favlist2.safetensors", tags=["F"])

    cft_metadata.invalidate_cache()
    items = cft_metadata.scan_loras(force=True, with_meta=False)
    a = [it for it in items if it.get("lora") == "favlist.safetensors"][0]
    b = [it for it in items if it.get("lora") == "favlist2.safetensors"][0]
    check(a.get("favorite") is True, f"收藏的 lora 在列表里 favorite=True（实际 {a.get('favorite')!r}）")
    check(b.get("favorite") is False, "未收藏的 lora 在列表里 favorite=False")

    # 刷新 C 站（写 .civitai.info）不该动收藏
    cft_civitai.save_civitai_info(os.path.join(R(), "favlist.safetensors"),
                                  {"name": "C站名", "creator": "作者", "tags": ["c站标签"]})
    check(cft_userdata.read("favlist.safetensors").get("favorite") is True,
          "刷新 C 站后收藏仍在")


TESTS: List[Tuple[str, Callable]] = [
    (t.__name__, t) for t in [
        t_read_write, t_partial_update, t_missing_and_corrupt, t_set_cover_remote,
        t_download_cover, t_clear_cover_restore, t_path_traversal, t_aggregate,
        t_merge_into_items, t_civitai_does_not_touch_user_data, t_favorite,
        t_favorite_merged_into_list, t_strip_ext,
    ]
]


def main() -> int:
    setup()
    try:
        for _name, fn in TESTS:
            g = getattr(fn, "_group", fn.__name__)
            before = len(FAIL)
            print(f"\n── {g}")
            try:
                fn()
            except Exception:
                FAIL.append(f"{g} 抛异常")
                print("    ✗ 抛异常：")
                traceback.print_exc()
            if len(FAIL) == before:
                print("    ✓")
    finally:
        teardown()

    print("\n" + "=" * 62)
    if FAIL:
        print(f"✗ {len(FAIL)} 项失败 / 共 {PASS + len(FAIL)} 项")
        for f in FAIL:
            print(f"    - {f}")
        return 1
    print(f"✓ 全部通过：{PASS} 项")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
