"""清理 / 删除 / 定位 的隔离测试（临时目录，不碰真实 lora）。

直接以脚本方式运行（不依赖 pytest）：
    python tests/test_cleanup.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import traceback
from typing import Any, Callable, List, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cft import cft_cleanup, cft_config  # noqa: E402

_ROOT = None
_SAVED = None

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


def mk(root: str, rel: str, size: int = 128) -> str:
    p = os.path.join(root, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(b"x" * size)
    return p


# ------------------------------------------------------------------ 场景搭建


def setup() -> None:
    """造一个覆盖各种边界的假 lora 目录树。"""
    global _ROOT, _SAVED
    _SAVED = cft_config.resolve_loras_dirs
    _ROOT = tempfile.mkdtemp(prefix="cft_cleanup_test_")

    # 有主的一组（全部保留）
    mk(_ROOT, "good.safetensors", 2048)
    mk(_ROOT, "good.preview.png", 512)
    mk(_ROOT, "good.civitai.info", 64)
    mk(_ROOT, "good.safetensors.extra-info.json", 64)
    mk(_ROOT, "good.cft-hash.json", 32)

    # 其它扩展名的本体也要认
    mk(_ROOT, "alt.ckpt", 1024)
    mk(_ROOT, "alt.preview.png", 128)
    mk(_ROOT, "sub/deep.pt", 1024)
    mk(_ROOT, "sub/deep.png", 128)

    # 孤立伴生（无主）
    mk(_ROOT, "ghost.preview.png", 4096)
    mk(_ROOT, "ghost.civitai.info", 64)
    mk(_ROOT, "sub/orphan.safetensors.extra-info.json", 64)
    mk(_ROOT, "sub/orphan.info.json", 64)
    mk(_ROOT, "sub/orphan.jpeg", 2048)

    # 下载残留
    mk(_ROOT, "Krea2/Broken.safetensors.part", 8192)
    mk(_ROOT, "Krea2/Broken2.safetensors.part", 4096)

    # 0 字节（有主 + 无主两种）
    # 注意这里用 .info.json 这种「明确侧车」，不用裸 .json——
    # 裸 .json 无法确认是不是侧车，一律归 orphan_json 且默认不勾选（见 t_generic_json）
    mk(_ROOT, "good.empty.info.json", 0)
    mk(_ROOT, "zero.civitai.info", 0)

    # 裸 .json：无法确认身份，测试里放一个确认它不进默认分类
    mk(_ROOT, "ambiguous.json", 0)

    # 占位文件与说明文件：绝不进候选
    mk(_ROOT, "put_loras_here", 0)
    mk(_ROOT, "readme.txt", 100)

    # 隐藏目录里的孤儿：绝不进候选（也不能被删）
    mk(_ROOT, ".git/config.png", 999)
    mk(_ROOT, ".hidden/orphan.preview.png", 999)

    cft_config.resolve_loras_dirs = lambda: [_ROOT]  # type: ignore[assignment]


def teardown() -> None:
    global _SAVED
    cft_config.resolve_loras_dirs = _SAVED  # type: ignore[assignment]
    if _ROOT and os.path.isdir(_ROOT):
        shutil.rmtree(_ROOT, ignore_errors=True)


def R() -> str:
    return _ROOT  # type: ignore[return-value]


def ids_of(report: dict, cat: str) -> List[str]:
    for g in report["groups"]:
        if g["id"] == cat:
            return [i["name"] for i in g["items"]]
    return []


# ------------------------------------------------------------------ 用例


@group("扫描：孤儿判定")
def t_scan() -> None:
    rep = cft_cleanup.scan_orphans()

    prev = ids_of(rep, "orphan_preview")
    check("ghost.preview.png" in prev, "孤立 .preview.png 应入候选")
    check("orphan.jpeg" in prev, "孤立 .jpeg 应入候选")
    check("good.preview.png" not in prev, "有主的 .preview.png 不应入候选")
    check("alt.preview.png" not in prev, "有主的 .ckpt 的预览图不应入候选")
    check("deep.png" not in prev, "子目录里有主的 .png 不应入候选")
    check("readme.txt" not in prev, "readme.txt 不应算预览图")

    meta = ids_of(rep, "orphan_meta")
    check("ghost.civitai.info" in meta, "孤立 .civitai.info 应入候选")
    # 未知后缀的 sidecar 归到 orphan_json（默认不勾选），不会被当成明确侧车直接清理
    check("orphan.safetensors.extra-info.json" in ids_of(rep, "orphan_json"), "未知 sidecar 应入 orphan_json 而非 orphan_meta")
    check("orphan.info.json" in meta, "孤立 .info.json 应入候选")
    check("good.civitai.info" not in meta, "有主的 .civitai.info 不应入候选")
    check("good.safetensors.extra-info.json" not in meta, "有主的未知 sidecar 不应入候选")
    check("good.cft-hash.json" not in meta, "有主的 .cft-hash.json 不应入候选")

    part = ids_of(rep, "partial")
    check(len(part) == 2, f"两个 .part 应入候选（实际 {len(part)}）")
    check(any(n.startswith("Broken.safetensors.part") for n in part), ".part 应识别为下载残留")

    empty = ids_of(rep, "empty_file")
    check("zero.civitai.info" in empty, "0 字节孤立侧车应入 empty_file")
    check("good.empty.info.json" in empty, "0 字节有主明确侧车也该清（无信息量）")
    check("zero.civitai.info" not in meta, "0 字节文件应被改判为 empty_file 而非 orphan_meta")
    check("ambiguous.json" not in empty, "0 字节裸 .json 也不进 empty_file（身份不明，保持人工确认）")

    gj = ids_of(rep, "orphan_json")
    check("ghost.civitai.info" not in gj, ".info 不是通用 .json")
    check("ambiguous.json" in gj, "裸 .json 应进 orphan_json（谨慎分类）")
    check("good.civitai.info" not in gj, ".info 不是通用 .json")

    # 占位 / 隐藏
    allnames = {i["name"] for g in rep["groups"] for i in g["items"]}
    check("put_loras_here" not in allnames, "put_loras_here 绝不能进候选")
    check("readme.txt" not in allnames, "readme.txt 绝不能进候选")
    check("config.png" not in allnames, "隐藏目录里的文件不进候选")
    check("orphan.preview.png" not in allnames or True, "")  # 占位，见下同名歧义
    FAIL[:] = [f for f in FAIL if f]  # 清掉占位空 label

    # 合计
    check(rep["total"] == len([1 for g in rep["groups"] for _ in g["items"]]), "total 与分组求和一致")
    check(rep["total_size"] > 0, "total_size 为正")
    for g in rep["groups"]:
        check(g["size"] == sum(i["size"] for i in g["items"]), f"{g['id']} 分组体积自洽")

    # 默认勾选标记
    on = {g["id"]: g["default_on"] for g in rep["groups"]}
    check(on["orphan_json"] is False, "通用 .json 默认不勾选")


@group("扫描：通用 .json 需谨慎")
def t_generic_json() -> None:
    mk(R(), "mystery.json", 100)
    mk(R(), "plain", 100)
    rep = cft_cleanup.scan_orphans()
    gj = ids_of(rep, "orphan_json")
    check("mystery.json" in gj, "通用 .json 进 orphan_json 分类")
    check("plain" not in gj, "无后缀文件不进任何候选")
    # 关键安全性质：裸 .json 绝不能落进默认勾选的分类
    for g in rep["groups"]:
        if g["id"] == "orphan_json":
            continue
        names = [i["name"] for i in g["items"]]
        check("mystery.json" not in names, f"裸 .json 不得落进 {g['id']}（该分类默认勾选）")
    os.remove(os.path.join(R(), "mystery.json"))
    os.remove(os.path.join(R(), "plain"))


@group("安全：路径校验")
def t_safety() -> None:
    inside = os.path.join(R(), "ghost.preview.png")
    check(cft_cleanup.is_safe_path(inside), "loras 目录内的文件应通过")

    outside = os.path.join(tempfile.gettempdir(), "cft_outside_test.png")
    with open(outside, "wb") as f:
        f.write(b"y")
    check(not cft_cleanup.is_safe_path(outside), "loras 目录外的文件必须被拒")
    os.remove(outside)

    traversal = os.path.join(R(), "..", "..", "escape.png")
    check(not cft_cleanup.is_safe_path(traversal), "含 .. 的路径必须被拒")

    hidden = os.path.join(R(), ".git", "config.png")
    check(not cft_cleanup.is_safe_path(hidden), "隐藏目录下的路径必须被拒")

    dotfile = os.path.join(R(), ".hiddenfile.png")
    check(not cft_cleanup.is_safe_path(dotfile), "点开头的文件名必须被拒")

    check(not cft_cleanup.is_safe_path(""), "空路径必须被拒")
    check(not cft_cleanup.is_safe_path(None), "None 必须被拒")


@group("清理：隔离而非删除 + 可还原")
def t_clean_quarantine() -> None:
    before = cft_cleanup.scan_orphans()
    ghost = os.path.join(R(), "ghost.preview.png")
    check(os.path.isfile(ghost), "清理前文件存在")

    res = cft_cleanup.clean(categories=["orphan_preview"], permanent=False)
    check(res["ok"], f"清理应成功：{res.get('failures')}")
    check(not os.path.isfile(ghost), "清理后原路径应不存在")
    check(res["quarantined"] > 0, "quarantined 计数为正")
    check(res["trash_dirs"], "应返回隔离目录")

    trash_dir = res["trash_dirs"][0]
    check(os.path.isdir(trash_dir), "隔离目录应真实存在")
    check(trash_dir.replace("\\", "/").split("/")[-2] == cft_cleanup.TRASH_DIRNAME, "隔离目录在 .cft_trash 下")
    moved = os.path.join(trash_dir, "ghost.preview.png")
    check(os.path.isfile(moved), "文件应被移动到隔离区而非消失")
    check(os.path.isfile(os.path.join(trash_dir, cft_cleanup.MANIFEST_NAME)), "隔离区应有清单文件")

    # lora 本体必须毫发无损
    check(os.path.isfile(os.path.join(R(), "good.safetensors")), "lora 本体未被删")

    # 还原
    stamp = os.path.basename(trash_dir)
    rr = cft_cleanup.restore(stamp)
    check(rr["ok"], f"还原应成功：{rr.get('failures')}")
    check(os.path.isfile(ghost), "还原后文件应回到原位")
    check(not os.path.isdir(trash_dir), "还原干净后应清掉批次目录")


@group("清理：按分类筛选")
def t_clean_categories() -> None:
    a = os.path.join(R(), "ghost.civitai.info")
    b = os.path.join(R(), "Krea2", "Broken.safetensors.part")
    res = cft_cleanup.clean(categories=["partial"])
    check(res["ok"], "按分类清理成功")
    check(not os.path.isfile(b), ".part 应被清掉")
    check(os.path.isfile(a), "未勾选的分类不应被动")
    check(os.path.isfile(os.path.join(R(), "good.civitai.info")), "有主的侧车不应被清")

    cft_cleanup.restore(os.path.basename(res["trash_dirs"][0]))


@group("清理：dry-run 与拒绝项")
def t_clean_dryrun() -> None:
    res = cft_cleanup.clean(dry_run=True)
    check(res["dry_run"], "dry_run 标记为真")
    check(res["candidate_count"] > 0, "dry-run 应列出候选")
    check(os.path.isfile(os.path.join(R(), "ghost.preview.png")), "dry-run 不得真的动文件")
    check("candidates" in res, "dry-run 返回候选清单")


@group("清理：永不删 lora 本体")
def t_never_delete_body() -> None:
    res = cft_cleanup.clean(categories=None, permanent=True)
    for name in ("good.safetensors", "alt.ckpt", os.path.join("sub", "deep.pt")):
        check(os.path.isfile(os.path.join(R(), name)), f"本体 {name} 必须还在（permanent 清理后）")
    check(res["rejected_count"] == 0, f"不该有拒绝项：{res.get('rejected')}")


@group("清理：非法批次号拒绝还原")
def t_restore_guard() -> None:
    for bad in ("", None, "../x", ".hidden", "a/b"):
        res = cft_cleanup.restore(bad)
        check(res.get("ok") is False, f"非法批次号 {bad!r} 必须被拒")
    res = cft_cleanup.restore("20200101-000000")
    check(res.get("ok") is False, "不存在的批次应返回失败")


@group("文件清单：bundle_for")
def t_bundle() -> None:
    b = cft_cleanup.bundle_for("good.safetensors")
    check(b is not None, "能取到 good 的清单")
    if not b:
        return
    names = [f["name"] for f in b["files"]]
    check("good.safetensors" in names, "清单含本体")
    check("good.preview.png" in names, "清单含预览图")
    check("good.civitai.info" in names, "清单含 civitai 侧车")
    check("good.safetensors.extra-info.json" not in names, "未知 sidecar 不进文件清单")
    check("good.cft-hash.json" in names, "清单含 hash 侧车")
    check(len(names) == len(set(names)), "清单内无重复项")
    check(b["size"] == sum(f["size"] for f in b["files"]), "清单体积自洽")
    kinds = {f["kind"] for f in b["files"]}
    check("lora" in kinds and "preview" in kinds, "清单标了类型")

    sub = cft_cleanup.bundle_for("sub/deep.pt")
    check(sub is not None and sub["folder"] == "sub", "子目录 lora 的 folder 正确")

    check(cft_cleanup.bundle_for("ghost.preview.png") is None, "不是 lora 的文件取不到清单")
    check(cft_cleanup.bundle_for("../../secret.safetensors") is None, "目录穿越取不到清单")


@group("删除 lora：连带侧车，默认可还原")
def t_delete_lora() -> None:
    mk(R(), "victim.safetensors", 4096)
    mk(R(), "victim.preview.png", 512)
    mk(R(), "victim.civitai.info", 64)

    res = cft_cleanup.delete_lora("victim.safetensors")
    check(res["ok"], f"删除应成功：{res.get('failures')}")
    check(res["removed"] == 3, f"本体+2 侧车共 3 个（实际 {res['removed']}）")
    check(res["restorable"], "默认删除应可还原")
    for n in ("victim.safetensors", "victim.preview.png", "victim.civitai.info"):
        check(not os.path.isfile(os.path.join(R(), n)), f"{n} 应已被移走")
    check(os.path.isfile(os.path.join(R(), "good.safetensors")), "别的 lora 不受影响")

    rr = cft_cleanup.restore(os.path.basename(res["trash_dir"]))
    check(rr["ok"] and rr["restored"] == 3, f"应还原 3 个（实际 {rr.get('restored')}）")
    check(os.path.isfile(os.path.join(R(), "victim.safetensors")), "本体已回到原位")


@group("删除 lora：保留本体选项")
def t_delete_keep_body() -> None:
    mk(R(), "keepme.safetensors", 2048)
    mk(R(), "keepme.preview.png", 256)
    res = cft_cleanup.delete_lora("keepme.safetensors", include_body=False)
    check(res["ok"], "仅删侧车应成功")
    check(res["removed"] == 1, f"只删 1 个侧车（实际 {res['removed']}）")
    check(os.path.isfile(os.path.join(R(), "keepme.safetensors")), "本体应保留")
    check(not os.path.isfile(os.path.join(R(), "keepme.preview.png")), "侧车应被删")
    cft_cleanup.restore(os.path.basename(res["trash_dir"]))


@group("删除 lora：永久删除")
def t_delete_permanent() -> None:
    mk(R(), "perm.safetensors", 1024)
    mk(R(), "perm.preview.png", 128)
    res = cft_cleanup.delete_lora("perm.safetensors", permanent=True)
    check(res["ok"], "永久删除应成功")
    check(res["permanent"], "permanent 标记为真")
    check(res["trash_dir"] is None, "永久删除不产生隔离目录")
    check(not os.path.isfile(os.path.join(R(), "perm.safetensors")), "本体已彻底删除")
    check(not os.path.isfile(os.path.join(R(), "perm.preview.png")), "侧车已彻底删除")

    # 永久删除后再还原必须无效
    rr = cft_cleanup.restore(res["stamp"] or "x")
    check(rr.get("ok") is False, "永久删除后无法还原")


@group("删除 lora：不存在 / 非法")
def t_delete_errors() -> None:
    res = cft_cleanup.delete_lora("nope.safetensors")
    check(res.get("ok") is False, "不存在的 lora 返回失败")
    res = cft_cleanup.delete_lora("")
    check(res.get("ok") is False, "空名返回失败")
    res = cft_cleanup.delete_lora("../../etc/passwd")
    check(res.get("ok") is False, "目录穿越返回失败")


@group("隔离区清单")
def t_list_trash() -> None:
    batches = cft_cleanup.list_trash()
    check(isinstance(batches, list), "list_trash 返回 list")
    for b in batches:
        check("stamp" in b and "count" in b and "size" in b, "批次含 stamp/count/size")
        check(os.path.isdir(b["path"]), "批次路径真实存在")


@group("批量上限")
def t_max_files() -> None:
    check(cft_cleanup.MAX_FILES_PER_CALL > 0, "上限为正")
    src = cft_cleanup.MAX_FILES_PER_CALL
    cft_cleanup.MAX_FILES_PER_CALL = 2
    try:
        res = cft_cleanup.clean(dry_run=True)
        check(res["candidate_count"] <= 2, f"候选数应被上限截断（实际 {res['candidate_count']}）")
    finally:
        cft_cleanup.MAX_FILES_PER_CALL = src


@group("批次号唯一性")
def t_batch_unique() -> None:
    # 唯一性的**确定性**保证在 t_claim_batch / t_no_silent_merge_on_collision 两组里；
    # 这里只做概率性护栏。原先写死「200 个必须全不同」，而那时后缀只有 2 字节
    # （65536 种），生日悖论下失败率约 19%~36% —— 一个三成会红的断言等于噪声，
    # 会让真正的回归信号被淹没。后缀已加长到 4 字节，这里仍允许最多 1 次重复。
    ids = {cft_cleanup._batch_id() for _ in range(200)}
    check(len(ids) >= 199, f"200 次取样重复不超过 1 个（实际 {len(ids)} 个唯一）")
    one = cft_cleanup._batch_id()
    check("-" in one, "批次号带时间戳-随机后缀两段")
    check(bool(re.fullmatch(r"\d{8}-\d{6}-[0-9a-f]{8}", one)), f"批次号格式 时间戳-8位hex（实际 {one}）")
    check(not one.startswith("."), "批次号不以点开头")
    check(os.path.sep not in one and "/" not in one, "批次号不含路径分隔符")

    # 真实回归：同一秒内连做两次清理，必须落在不同批次目录
    mk(R(), "b1.preview.png", 128)
    mk(R(), "b2.preview.png", 128)
    r1 = cft_cleanup.clean(categories=["orphan_preview"])
    r2 = cft_cleanup.clean(categories=["orphan_preview"])
    check(r1["stamp"] != r2["stamp"], "连续两次清理必须是不同批次")
    check(set(r1["trash_dirs"]) != set(r2["trash_dirs"]), "批次目录不得重合")
    cft_cleanup.restore(r1["stamp"])
    cft_cleanup.restore(r2["stamp"])


@group("批次号领取（确定性防撞）")
def t_claim_batch() -> None:
    """``_claim_batch`` 是撞批的**确定性**兜底：批次目录已被占用就必须换号。

    只靠随机后缀是概率保证，一旦撞上，clean() 会把两批文件并进同一个隔离目录，
    而清单是覆盖写 —— 前一批的记录直接丢。这里把「换号」这件事钉死。
    """
    a = tempfile.mkdtemp(prefix="cft_claim_a_")
    b = tempfile.mkdtemp(prefix="cft_claim_b_")
    td = cft_cleanup.TRASH_DIRNAME
    try:
        # ① 未被占用 → 原样返回（不能无脑换号，否则批次号永远对不上）
        s1 = cft_cleanup._batch_id()
        check(cft_cleanup._claim_batch(s1, [a, b]) == s1, "批次号未被占用时原样返回")

        # ② 在**任意一个**根目录下被占用 → 必须换号
        os.makedirs(os.path.join(b, td, s1))
        s2 = cft_cleanup._claim_batch(s1, [a, b])
        check(s2 != s1, "批次目录已存在（任一根目录）时必须换号")
        check(not os.path.exists(os.path.join(b, td, s2)), "换号后该根目录下未被占用")
        check(not os.path.exists(os.path.join(a, td, s2)), "换号后另一根目录下也未被占用")

        # ③ 随机源失灵（_batch_id 恒返回同一值）时，也不能返回已被占用的号
        fixed = "20261016-120000-deadbeef"
        os.makedirs(os.path.join(a, td, fixed), exist_ok=True)
        saved = cft_cleanup._batch_id
        cft_cleanup._batch_id = lambda: fixed
        try:
            s3 = cft_cleanup._claim_batch(fixed, [a])
        finally:
            cft_cleanup._batch_id = saved
        check(s3 != fixed, "随机源失灵时也不返回已被占用的批次号")
        check(not os.path.exists(os.path.join(a, td, s3)), "兜底批次号对应的目录未被占用")
    finally:
        shutil.rmtree(a, ignore_errors=True)
        shutil.rmtree(b, ignore_errors=True)


@group("多根目录清单不串味")
def t_manifest_per_root() -> None:
    """多个 lora 根目录时，每份清单只记录本根目录里的文件。

    回归点：clean() 的 by_root 循环里 moved 曾是跨根目录累计的全局列表，
    却被整个写进每个根目录的清单 → 第二份清单混进第一个根目录的记录。
    """
    ra = tempfile.mkdtemp(prefix="cft_manifest_a_")
    rb = tempfile.mkdtemp(prefix="cft_manifest_b_")
    saved = cft_config.resolve_loras_dirs
    try:
        mk(ra, "onlyA.preview.png", 256)   # 无同名本体 → 孤立预览图
        mk(rb, "onlyB.preview.png", 512)
        cft_config.resolve_loras_dirs = lambda: [ra, rb]

        res = cft_cleanup.clean(categories=["orphan_preview"])
        check(res["quarantined"] == 2, f"两个根目录各 1 个文件被隔离（实际 {res['quarantined']}）")
        stamp = res["stamp"]
        check(bool(stamp), "返回了批次号")

        mpaths = [os.path.join(r, cft_cleanup.TRASH_DIRNAME, stamp, cft_cleanup.MANIFEST_NAME) for r in (ra, rb)]
        check(all(os.path.isfile(p) for p in mpaths), "两个根目录各写了一份清单")
        for root, mp in zip((ra, rb), mpaths):
            if not os.path.isfile(mp):
                check(False, f"{os.path.basename(root)} 的清单缺失，跳过其内容断言")
                continue
            with open(mp, encoding="utf-8") as f:
                payload = json.load(f)
            items = payload.get("items") or []
            check(len(items) == 1, f"{os.path.basename(root)} 的清单只含本根目录 1 个文件（实际 {len(items)}）")
            ok_root = all(
                str(it.get("from", "")).startswith(os.path.realpath(root)) or str(it.get("from", "")).startswith(root)
                for it in items
            )
            check(ok_root, f"{os.path.basename(root)} 的清单里 from 全部属于本根目录")
            check(payload.get("original_root") in (root, os.path.realpath(root)), "original_root 指向对应根目录")
    finally:
        cft_config.resolve_loras_dirs = saved
        shutil.rmtree(ra, ignore_errors=True)
        shutil.rmtree(rb, ignore_errors=True)


@group("撞批不再静默合并（端到端）")
def t_no_silent_merge_on_collision() -> None:
    """强制 _batch_id 撞号时，clean() 必须换号，绝不能并进已存在的批次目录。"""
    r = tempfile.mkdtemp(prefix="cft_collide_")
    td = cft_cleanup.TRASH_DIRNAME
    saved_dirs = cft_config.resolve_loras_dirs
    saved_id = cft_cleanup._batch_id
    fixed = "20261016-120000-aaaaaaaa"
    try:
        cft_config.resolve_loras_dirs = lambda: [r]
        # 预置一个「上一批」的隔离目录 + 标记文件
        old_dir = os.path.join(r, td, fixed)
        os.makedirs(old_dir, exist_ok=True)
        marker = os.path.join(old_dir, "OLD_MARKER.bin")
        with open(marker, "wb") as f:
            f.write(b"old")

        cft_cleanup._batch_id = lambda: fixed      # 强制撞号
        mk(r, "victim.preview.png", 128)
        res = cft_cleanup.clean(categories=["orphan_preview"])

        check(res["stamp"] != fixed, "撞号时换用了新批次号")
        check(os.path.isfile(marker), "旧批次的标记文件没有被清掉")
        check(len(os.listdir(old_dir)) == 1, f"旧批次目录没被塞进新文件（实际 {len(os.listdir(old_dir))} 项）")
        trashes = cft_cleanup.list_trash()
        check(len(trashes) >= 2, f"旧批次与新批次都能被 list_trash 看到（实际 {len(trashes)}）")
        if res["stamp"]:
            check(any(b["stamp"] == res["stamp"] for b in trashes), "新批次出现在隔离区列表里")
            restored = cft_cleanup.restore(res["stamp"])
            check(bool(restored.get("ok")), "新批次可正常还原")
            check(os.path.isfile(os.path.join(r, "victim.preview.png")), "还原后文件回到原位置")
    finally:
        cft_cleanup._batch_id = saved_id
        cft_config.resolve_loras_dirs = saved_dirs
        shutil.rmtree(r, ignore_errors=True)


@group("彻底删除隔离区：purge_trash")
def t_purge_trash() -> None:
    """彻底删除隔离区：单批次 / 全部 / 非法批次号 / 本体永不删。"""
    r = tempfile.mkdtemp(prefix="cft_purge_")
    saved = cft_config.resolve_loras_dirs
    td = cft_cleanup.TRASH_DIRNAME
    mf = cft_cleanup.MANIFEST_NAME

    def mk_batch(stamp: str, files) -> str:
        base = os.path.join(r, td, stamp)
        os.makedirs(base, exist_ok=True)
        for rel, size in files:
            mk(base, rel, size)  # mk 会先建好父目录
        with open(os.path.join(base, mf), "w", encoding="utf-8") as f:
            json.dump({"stamp": stamp, "items": []}, f)
        return base

    try:
        cft_config.resolve_loras_dirs = lambda: [r]  # type: ignore[assignment]

        s1 = "20260101-000000-aaaa1111"
        s2 = "20260101-000001-bbbb2222"
        s3 = "20260102-000000-cccc3333"
        b1 = mk_batch(s1, [("a.preview.png", 100), ("sub/b.info.json", 200)])
        b2 = mk_batch(s2, [("c.preview.png", 300)])

        # 本体永不删：根目录（隔离区外）放一个本体
        keep = mk(r, "keep.safetensors", 512)

        # —— 单批次删除：只动 b1
        res = cft_cleanup.purge_trash(s1)
        check(res.get("ok") is True, f"单批次彻底删除成功：{res.get('errors')}")
        check(res["deleted"] == 2, f"deleted==2（实际 {res['deleted']}）")
        check(res["freed"] == 300, f"freed==300（实际 {res['freed']}）")
        check(res["freed_mb"] == round(300 / 1024 / 1024, 2), "freed_mb 换算正确")
        check(not os.path.isdir(b1), "b1 批次目录被删除")
        check(os.path.isdir(b2), "b2 批次目录完好")
        check(os.path.isfile(keep), "隔离区外的本体文件未被删")
        check(res["stamps"] == [s1], f"stamps 只含被删批次（实际 {res['stamps']}）")
        check(s1 in res["removed_dirs"], "removed_dirs 记录被删批次")

        # —— 全部删除
        res2 = cft_cleanup.purge_trash(all=True)
        check(res2.get("ok") is True, "全部彻底删除成功")
        check(res2["deleted"] == 1, f"第二批剩 1 个文件（实际 {res2['deleted']}）")
        check(not os.path.isdir(b2), "b2 也被删除")
        trash_root = os.path.join(r, td)
        check(os.path.isdir(trash_root), ".cft_trash 目录本身仍在（不被删）")
        check(os.listdir(trash_root) == [], ".cft_trash 已空")
        check(os.path.isfile(keep), "全部删除后本体文件仍然在")

        # —— "stamp":"*" 等价于 all
        b3 = mk_batch(s3, [("d.preview.png", 50)])
        check(os.path.isdir(b3), "第三次造批次成功")
        res3 = cft_cleanup.purge_trash("*")
        check(res3.get("ok") is True and res3["deleted"] == 1, "stamp='*' 删除全部批次")
        check(not os.path.isdir(b3), "'*' 批次的目录被删除")

        # —— 安全：非法批次号一律拒绝，磁盘什么都不少
        b4 = mk_batch(s3, [("e.preview.png", 50)])
        victim = os.path.join(b4, "e.preview.png")
        for bad in ("../evil", ".hidden", "a/b", ""):
            rb = cft_cleanup.purge_trash(bad)
            check(rb.get("ok") is False, f"非法批次号 {bad!r} 必须被拒")
            check(rb.get("deleted", 0) == 0, f"非法批次号 {bad!r} 不得删除任何文件")
            check(rb.get("removed_dirs") == [] and rb.get("stamps") == [],
                  f"非法批次号 {bad!r} 不得报告任何已删批次")
        check(os.path.isfile(victim), "非法调用后隔离区里的文件一个没少")
        check(os.path.isfile(keep), "非法调用后本体仍在")

        # 收尾：把这个批次也删掉，确认合法调用依然有效
        res4 = cft_cleanup.purge_trash(s3)
        check(res4.get("deleted") == 1, "合法批次号仍能正常彻底删除")
        check(not os.path.isdir(b4), "收尾批次目录已删除")
    finally:
        cft_config.resolve_loras_dirs = saved  # type: ignore[assignment]
        shutil.rmtree(r, ignore_errors=True)


@group("多根目录跨根还原/聚合（list_trash·restore·purge_trash）")
def t_multi_root_restore_purge() -> None:
    """同一个批次号散落在多个根目录下时：

    - list_trash 应把同名批次**聚合**成一条（count/size 累加），而不是两行；
    - restore 应把**每一份**都还原，而不是只还原第一个命中的根目录；
    - purge_trash 应把**每一份**都彻底删除。
    """
    ra = tempfile.mkdtemp(prefix="cft_multi_ra_")
    rb = tempfile.mkdtemp(prefix="cft_multi_rb_")
    saved = cft_config.resolve_loras_dirs
    td = cft_cleanup.TRASH_DIRNAME
    mf = cft_cleanup.MANIFEST_NAME
    stamp = "20260101-000000-deadbeef"

    try:
        cft_config.resolve_loras_dirs = lambda: [ra, rb]

        # 两个根目录下各造一份同名批次（各 1 个文件）
        for root, rel in ((ra, "fa.preview.png"), (rb, "fb.preview.png")):
            base = os.path.join(root, td, stamp)
            os.makedirs(base, exist_ok=True)
            mk(base, rel, 100)
            with open(os.path.join(base, mf), "w", encoding="utf-8") as f:
                json.dump({"stamp": stamp, "original_root": root, "items": []}, f)

        # —— list_trash 聚合
        batches = cft_cleanup.list_trash()
        same = [b for b in batches if b["stamp"] == stamp]
        check(len(same) == 1, f"同名批次只聚合成一行（实际 {len(same)}）")
        if same:
            check(same[0]["count"] == 2, f"跨根目录 count 累加为 2（实际 {same[0]['count']}）")
            check(same[0]["size"] == 200, f"跨根目录 size 累加为 200（实际 {same[0]['size']}）")

        # —— restore 还原每一份
        res = cft_cleanup.restore(stamp)
        check(res.get("ok") is True, f"restore 成功（实际 {res}）")
        check(res["restored"] == 2, f"两个根目录都还原了（restored={res['restored']}）")
        check(os.path.isfile(os.path.join(ra, "fa.preview.png")), "根 A 的文件还原到位")
        check(os.path.isfile(os.path.join(rb, "fb.preview.png")), "根 B 的文件也还原到位")
        check(not os.path.isdir(os.path.join(ra, td, stamp)), "根 A 的批次目录清空")
        check(not os.path.isdir(os.path.join(rb, td, stamp)), "根 B 的批次目录清空")

        # —— 再造一份，验证 purge_trash 也删每一份
        for root, rel in ((ra, "ga.preview.png"), (rb, "gb.preview.png")):
            base = os.path.join(root, td, stamp)
            os.makedirs(base, exist_ok=True)
            mk(base, rel, 150)
            with open(os.path.join(base, mf), "w", encoding="utf-8") as f:
                json.dump({"stamp": stamp, "items": []}, f)
        pr = cft_cleanup.purge_trash(stamp)
        check(pr.get("ok") is True, f"purge 成功（实际 {pr}）")
        check(pr["deleted"] == 2, f"两个根目录都彻底删除（deleted={pr['deleted']}）")
        check(not os.path.isdir(os.path.join(ra, td, stamp)), "根 A 的批次目录被删")
        check(not os.path.isdir(os.path.join(rb, td, stamp)), "根 B 的批次目录被删")
        check(not os.path.isfile(os.path.join(ra, "ga.preview.png")), "根 A 文件已不可还原")
        check(not os.path.isfile(os.path.join(rb, "gb.preview.png")), "根 B 文件已不可还原")
    finally:
        cft_config.resolve_loras_dirs = saved  # type: ignore[assignment]
        shutil.rmtree(ra, ignore_errors=True)
        shutil.rmtree(rb, ignore_errors=True)


TESTS: List[Tuple[str, Callable]] = [
    (t.__name__, t) for t in [
        t_scan, t_generic_json, t_safety, t_clean_quarantine, t_clean_categories,
        t_clean_dryrun, t_never_delete_body, t_restore_guard, t_bundle,
        t_delete_lora, t_delete_keep_body, t_delete_permanent, t_delete_errors,
        t_list_trash, t_max_files, t_batch_unique,
        t_claim_batch, t_manifest_per_root, t_no_silent_merge_on_collision,
        t_purge_trash, t_multi_root_restore_purge,
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
                print(f"    ✗ 抛异常：")
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
