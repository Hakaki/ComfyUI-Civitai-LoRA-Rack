"""本地文件清理与定位。

两个能力：
1. **清理**：找出 lora 目录里「跟任何现存 lora 都不相关」的伴生文件（孤立预览图、
   孤立侧车、下载残留 ``.part``、0 字节空文件），可移到隔离区或彻底删除。
2. **定位/删除**：按 lora 相对路径列出它的完整文件清单（本体 + 全部伴生），
   支持跳转所在文件夹、或把整组文件删掉。

安全不变量（任何改动前都要成立，改代码时逐条对照）：
- **绝不删 lora 本体**：``.safetensors/.ckpt/.pt/.bin/.sft`` 永远不在清理候选里；
  只有「用户显式对某个 lora 点删除」时才会动本体，且那是另一条独立代码路径。
- **绝不越界**：所有路径 realpath 后必须落在 :func:`cft_config.resolve_loras_dirs()`
  的某个根目录内（含子目录），否则一律拒绝。隐藏目录（``.`` 开头）不参与扫描也不可写。
- **默认隔离不删除**：清理默认移到 ``<root>/.cft_trash/<时间戳>/``，保留清单可还原；
  彻底删除必须由调用方显式传 ``permanent=True``。
- **删除前重算**：不信任前端传来的清单，服务端收到请求后自己重扫并重新判定孤儿状态
  （防 TOCTOU，也防前端伪造路径）。
- **跳过占位文件**：``put_loras_here`` 之类不算垃圾。
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

from . import cft_config, cft_metadata

__all__ = [
    "CATEGORIES",
    "scan_orphans",
    "bundle_for",
    "clean",
    "restore",
    "purge_trash",
    "list_trash",
    "reveal",
]

# ------------------------------------------------------------------ 常量

# lora 本体后缀：清理时**永不**作为候选
LORA_EXTS = (".safetensors", ".ckpt", ".pt", ".bin", ".sft")

# 下载/写入残留
PARTIAL_EXTS = (".part", ".partial", ".tmp", ".temp", ".download", ".crdownload", ".aria2")

# 预览图后缀（与 cft_metadata.find_preview 保持一致）
PREVIEW_EXTS = (
    ".preview.png", ".preview.jpg", ".preview.jpeg", ".preview.webp",
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
)

# 通用 .json：无法确定是不是 lora 侧车（用户可能自己放了配置），单列且默认不勾选
GENERIC_JSON_EXTS = (".json",)

# 明确的 lora 侧车后缀（来自 cft_metadata 的常量，避免两处漂移）
# 刻意**剔除裸 .json**：cft_metadata._SIMPLE_SIDECARS 里含 ".json"，
# 若照搬进来，用户目录里任何 .json 都会被判成侧车并落入默认勾选的 orphan_meta。
# 裸 .json 统一走 GENERIC_JSON_EXTS（默认不勾选）。
META_EXTS = tuple(
    dict.fromkeys(
        suf
        for suf in (
            tuple(cft_metadata._CIVITAI_SIDECARS)
            + tuple(cft_metadata._SIMPLE_SIDECARS)
            + tuple(cft_metadata._HASH_SIDECARS)
        )
        if suf.lower() not in GENERIC_JSON_EXTS
    )
)

# 占位/说明文件，永不视为垃圾
IGNORE_NAMES = ("put_loras_here", "readme", "license")

TRASH_DIRNAME = ".cft_trash"
MANIFEST_NAME = "_cft_trash_manifest.json"

# 单次操作文件数上限（防手滑传进来十万个路径）
MAX_FILES_PER_CALL = 5000

# 分类定义：前端直接照这个渲染复选框
CATEGORIES: List[Dict[str, Any]] = [
    {"id": "orphan_preview", "label": "孤立预览图", "default_on": True,
     "hint": "同目录已经没有对应 lora 的图片"},
    {"id": "orphan_meta", "label": "孤立信息文件", "default_on": True,
     "hint": ".civitai.info / .info.json / .cft-hash.json 等，主文件已不在"},
    {"id": "partial", "label": "下载残留", "default_on": True,
     "hint": ".part / .tmp 等没下完的半成品"},
    {"id": "empty_file", "label": "0 字节空文件", "default_on": True,
     "hint": "体积为 0 的侧车或空图，没有任何信息量"},
    {"id": "orphan_json", "label": "孤立 .json（需谨慎）", "default_on": False,
     "hint": "不确定是否为 lora 侧车，默认不清理"},
]
_CATEGORY_IDS = {c["id"] for c in CATEGORIES}


# ------------------------------------------------------------------ 基础工具


def _batch_id() -> str:
    """生成批次号 ``<时间戳>-<随机后缀>``。

    只用时间戳会撞：同一秒内连续两次清理会落进同一个目录，第二次的文件被并进第一次
    的批次，还原时一次全出来，语义就乱了。

    后缀取 **4 字节**（8 位十六进制 ≈ 4.29e9 种）。原先只用 2 字节（65536 种），
    同一秒内两次清理有约 1/65536 的概率撞号；撞号时 :func:`clean` 会把两批文件并进
    同一个目录，而 :func:`_write_manifest` 是覆盖写 —— 前一批的清单记录会被吃掉。
    概率再低也不该由随机数独自兜底，因此调用方一律走 :func:`_claim_batch`。
    """
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(4)}"


def _claim_batch(stamp: str, roots: List[str]) -> str:
    """领取一个在所有根目录下都还没被占用的批次号。

    为什么不能只靠随机后缀：一旦撞号，:func:`clean` 的 ``os.makedirs(..., exist_ok=True)``
    会静默地把两批文件并进同一个隔离目录，而 :func:`_write_manifest` 用 ``"w"`` 覆盖写，
    前一批的清单记录直接丢失 —— 表现为「两次清理只看到一个批次、一次还原全出来」。
    这里做一层确定性检查：只要任意一个根目录下已经存在同名批次目录，就换号。
    """
    for _ in range(8):
        if not any(os.path.exists(os.path.join(r, TRASH_DIRNAME, stamp)) for r in roots):
            return stamp
        stamp = _batch_id()
    # 连续 8 次都撞（现实中不可能）—— 用更长的后缀强行避开
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(8)}"


def _real(p: str) -> str:
    return os.path.realpath(os.path.abspath(p))


def _root_of(path: str) -> Optional[str]:
    """返回 path 所属的 lora 根目录；不在任何根目录内则 None。"""
    rp = _real(path)
    for root in cft_config.resolve_loras_dirs():
        rr = _real(root)
        try:
            if os.path.commonpath([rp, rr]) == rr:
                return rr
        except ValueError:
            continue
    return None


def is_safe_path(path: str, allow_trash: bool = False) -> bool:
    """路径是否在 lora 根目录内、且没有踩到隐藏目录/隔离区。"""
    if not path:
        return False
    rp = _real(path)
    root = _root_of(rp)
    if not root:
        return False
    try:
        rel = os.path.relpath(rp, root)
    except ValueError:
        return False
    parts = rel.replace("\\", "/").split("/")
    for part in parts[:-1]:
        if not part or part == ".":
            return False
        if part.startswith(".") and not (allow_trash and part == TRASH_DIRNAME):
            return False
    if parts and parts[-1].startswith("."):
        return False
    return True


def _hidden_dir(path: str) -> bool:
    """路径所在目录链（不含根）是否含隐藏目录。"""
    root = _root_of(path)
    if not root:
        return True
    rel = os.path.relpath(_real(path), root)
    parts = rel.replace("\\", "/").split("/")[:-1]
    return any(p.startswith(".") for p in parts)


def _ignored(name: str) -> bool:
    low = name.lower()
    return any(low == n or low.startswith(n) for n in IGNORE_NAMES)


def _strip_suffix(name: str, suffix: str) -> str:
    return name[: -len(suffix)] if name.lower().endswith(suffix.lower()) else name


def _owner_exists(base: str, owners: Dict[str, str]) -> bool:
    """base 是否存在同名 lora 本体（owners 是 小写文件名 -> 真实名 的表）。

    要试两种写法：伴生文件既可能是 ``<base>.<sidecar>``（``good.preview.png``），
    也可能是 ``<完整 lora 名>.<sidecar>``（``good.safetensors.extra-info.json``
    ——有些工具会把 lora 扩展名一起带上）。只试一种会把后者误判成孤儿。
    """
    low = base.lower()
    stems = [low]
    for ext in LORA_EXTS:
        if low.endswith(ext):
            stems.append(low[: -len(ext)])
            break
    for stem in stems:
        for ext in LORA_EXTS:
            if (stem + ext) in owners:
                return True
    return False


def _classify(name: str) -> Tuple[str, Optional[str], Optional[str]]:
    """判定单个文件属于哪个清理分类。

    返回 ``(category_id, matched_suffix, owner_base)``；不适用时 category_id 为 None。
    匹配顺序：部分残留 → 预览图 → 明确侧车 → 通用 json（长后缀优先，
    避免 ``.safetensors.xxx-info.json`` 被当成 ``.json``）。
    """
    low = name.lower()

    for suf in PARTIAL_EXTS:
        if low.endswith(suf):
            return "partial", suf, _strip_suffix(name, suf)

    for suf in sorted(PREVIEW_EXTS, key=len, reverse=True):
        if low.endswith(suf):
            return "orphan_preview", suf, _strip_suffix(name, suf)

    for suf in sorted(META_EXTS, key=len, reverse=True):
        if low.endswith(suf):
            return "orphan_meta", suf, _strip_suffix(name, suf)

    for suf in GENERIC_JSON_EXTS:
        if low.endswith(suf):
            return "orphan_json", suf, _strip_suffix(name, suf)

    return None, None, None


def _file_size(p: str) -> int:
    try:
        return os.path.getsize(p)
    except OSError:
        return 0


# ------------------------------------------------------------------ 扫描


def scan_orphans() -> Dict[str, Any]:
    """扫描所有 lora 目录，返回按分类归组的清理候选。"""
    roots = [_real(r) for r in cft_config.resolve_loras_dirs() if os.path.isdir(r)]

    groups: Dict[str, List[Dict[str, Any]]] = {c["id"]: [] for c in CATEGORIES}
    scanned_dirs = 0
    total_files = 0

    for root in roots:
        # 逐目录：先 scandir 建「本体文件名（小写）」索引，再判伴生文件有没有主。
        # 不缓存跨目录索引——每个目录只扫一次 scandir，比维护全局表更不容易出错。
        for dirpath, dirnames, _fns in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            owners: Dict[str, str] = {}
            try:
                with os.scandir(dirpath) as it:
                    for e in it:
                        if e.is_file() and e.name.lower().endswith(LORA_EXTS):
                            owners[e.name.lower()] = e.name
            except OSError:
                owners = {}
            scanned_dirs += 1

            try:
                entries = sorted(os.listdir(dirpath))
            except OSError:
                continue

            for fn in entries:
                if fn.startswith(".") or _ignored(fn):
                    continue
                full = os.path.join(dirpath, fn)
                if not os.path.isfile(full):
                    continue
                total_files += 1
                if fn.lower().endswith(LORA_EXTS):
                    continue  # lora 本体永不入清理候选

                cat, suf, base = _classify(fn)
                if not cat or base is None:
                    continue

                size = _file_size(full)
                if _owner_exists(base, owners):
                    # 主文件还在：只有 0 字节的才值得清
                    if size == 0:
                        groups["empty_file"].append(
                            _entry(root, dirpath, fn, cat, suf, base, has_owner=True)
                        )
                    continue

                if size == 0 and cat != "orphan_json":
                    cat = "empty_file"

                groups[cat].append(_entry(root, dirpath, fn, cat, suf, base, has_owner=False))

    out_groups: List[Dict[str, Any]] = []
    total_size = 0
    total_count = 0
    for meta in CATEGORIES:
        items = groups[meta["id"]]
        size = sum(i["size"] for i in items)
        total_size += size
        total_count += len(items)
        out_groups.append({
            "id": meta["id"],
            "label": meta["label"],
            "hint": meta["hint"],
            "default_on": meta["default_on"],
            "count": len(items),
            "size": size,
            "size_mb": round(size / 1024 / 1024, 2),
            "items": items,
        })

    return {
        "groups": out_groups,
        "total": total_count,
        "total_size": total_size,
        "total_size_mb": round(total_size / 1024 / 1024, 2),
        "roots": roots,
        "scanned_dirs": scanned_dirs,
        "scanned_files": total_files,
    }


def _entry(root: str, dirpath: str, fn: str, cat: str, suf: Optional[str],
           base: Optional[str], has_owner: bool) -> Dict[str, Any]:
    abs_path = os.path.join(dirpath, fn)
    try:
        rel = os.path.relpath(abs_path, root).replace("\\", "/")
        mtime = os.path.getmtime(abs_path)
    except OSError:
        rel = fn
        mtime = 0.0
    return {
        "path": abs_path,
        "rel": rel,
        "root": root,
        "name": fn,
        "dir": os.path.relpath(dirpath, root).replace("\\", "/") or ".",
        "size": _file_size(abs_path),
        "size_mb": round(_file_size(abs_path) / 1024 / 1024, 3),
        "mtime": mtime,
        "category": cat,
        "suffix": suf or "",
        "base": base or "",
        "has_owner": has_owner,
    }


# ------------------------------------------------------------------ lora 文件组


def bundle_for(relative_name: str) -> Optional[Dict[str, Any]]:
    """列出某个 lora 的完整文件清单（本体 + 预览图 + 全部侧车）。"""
    abs_path = cft_metadata.resolve_lora_path(relative_name)
    if not abs_path:
        return None
    root = _root_of(abs_path)
    if not root:
        return None

    directory = os.path.dirname(abs_path)
    file_name = os.path.basename(abs_path)
    index = cft_metadata._build_sidecar_index(directory)

    files: List[Dict[str, Any]] = [
        {"name": file_name, "kind": "lora", "size": _file_size(abs_path), "required": True}
    ]

    preview = cft_metadata.find_preview(directory, file_name, index)
    if preview:
        files.append({
            "name": preview, "kind": "preview",
            "size": _file_size(os.path.join(directory, preview)), "required": False,
        })

    seen = {file_name, preview}
    groups = (
        ("civitai", cft_metadata._CIVITAI_SIDECARS),
        ("info", cft_metadata._SIMPLE_SIDECARS),
        ("hash", cft_metadata._HASH_SIDECARS),
    )
    for kind, suffixes in groups:
        found = cft_metadata._find_sidecar(index, file_name, suffixes)
        if found and found not in seen:
            seen.add(found)
            files.append({
                "name": found, "kind": kind,
                "size": _file_size(os.path.join(directory, found)), "required": False,
            })

    try:
        rel_dir = os.path.relpath(directory, root).replace("\\", "/")
    except ValueError:
        rel_dir = ""
    folder = "." if rel_dir in ("", ".") else rel_dir
    lora_rel = file_name if not folder or folder == "." else f"{folder}/{file_name}"

    return {
        "lora": lora_rel,
        "abs_path": abs_path,
        "dir": directory,
        "folder": folder,
        "root": root,
        "file_name": file_name,
        "size": sum(f["size"] for f in files),
        "size_mb": round(sum(f["size"] for f in files) / 1024 / 1024, 2),
        "files": files,
    }


# ------------------------------------------------------------------ 执行清理


def _resolve_targets(categories: Optional[List[str]], roots: Optional[List[str]]) -> Tuple[List[str], Dict[str, Any]]:
    """重扫并挑出真正要处理的路径（不信任前端清单）。

    若指定了 ``roots``，只保留这些根目录下的候选（前端按目录分别清理时用）。
    """
    report = scan_orphans()
    allow: Optional[set] = None
    if categories:
        wanted = {c for c in categories if c in _CATEGORY_IDS}
        if not wanted:
            return [], report
        allow = wanted
    allow_roots = {_real(r) for r in roots} if roots else None

    picked: List[str] = []
    for g in report["groups"]:
        if allow is not None and g["id"] not in allow:
            continue
        for it in g["items"]:
            if allow_roots is not None and _real(it["root"]) not in allow_roots:
                continue
            picked.append(it["path"])
            if len(picked) >= MAX_FILES_PER_CALL:
                return picked, report
    return picked, report


def clean(
    categories: Optional[List[str]] = None,
    roots: Optional[List[str]] = None,
    permanent: bool = False,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """执行清理。``permanent=False``（默认）时移到隔离区，可 :func:`restore` 还原。"""
    targets, report = _resolve_targets(categories, roots)

    # 删除前重新校验：路径合法 + 仍然不存在主文件（TOCTOU 防护）
    verified: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []
    for p in targets:
        rp = _real(p)
        if not is_safe_path(rp):
            rejected.append({"path": p, "reason": "unsafe_path"})
            continue
        if os.path.basename(rp).lower().endswith(LORA_EXTS):
            rejected.append({"path": p, "reason": "refuse_lora_body"})
            continue
        if not os.path.isfile(rp):
            rejected.append({"path": p, "reason": "not_found"})
            continue
        verified.append({
            "path": rp,
            "size": _file_size(rp),
            "rel": os.path.relpath(rp, _root_of(rp) or _real(p)).replace("\\", "/"),
            "root": _root_of(rp),
        })

    total_size = sum(v["size"] for v in verified)

    if dry_run:
        return {
            "dry_run": True,
            "ok": True,
            "permanent": bool(permanent),
            "candidates": verified[:200],
            "candidate_count": len(verified),
            "rejected": rejected[:50],
            "rejected_count": len(rejected),
            "total_size": total_size,
            "total_size_mb": round(total_size / 1024 / 1024, 2),
            "report": _slim_report(report),
        }

    # 批次号必须在所有根目录下都未被占用，否则两批会被并进同一个隔离目录
    # （os.makedirs(exist_ok=True) 不报错）+ 清单被覆盖写。
    stamp = _claim_batch(_batch_id(), roots or cft_config.resolve_loras_dirs())
    moved: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []

    if not permanent:
        # 按根目录分批，各根目录一个时间戳子目录
        by_root: Dict[str, List[Dict[str, Any]]] = {}
        for v in verified:
            by_root.setdefault(v["root"], []).append(v)
        for root, items in by_root.items():
            trash_root = os.path.join(root, TRASH_DIRNAME, stamp)
            # 每个根目录只写自己那份清单：之前这里把跨根目录累计的 moved 整个写进去，
            # 导致第二个根目录的清单里混进了第一个根目录的文件记录。
            moved_here: List[Dict[str, Any]] = []
            for v in items:
                dst = os.path.join(trash_root, v["rel"])
                try:
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    if os.path.exists(dst):
                        raise FileExistsError("目标已存在")
                    shutil.move(v["path"], dst)
                    moved_here.append({"from": v["path"], "to": dst, "size": v["size"]})
                except Exception as exc:
                    failed.append({"path": v["path"], "error": f"{type(exc).__name__}: {exc}"})
            moved.extend(moved_here)
            _write_manifest(trash_root, root, moved_here, stamp)
    else:
        for v in verified:
            try:
                os.remove(v["path"])
                moved.append({"from": v["path"], "to": None, "size": v["size"]})
            except Exception as exc:
                failed.append({"path": v["path"], "error": f"{type(exc).__name__}: {exc}"})

    moved_size = sum(m["size"] for m in moved)
    return {
        "ok": not failed,
        "dry_run": False,
        "permanent": bool(permanent),
        "stamp": None if permanent else stamp,
        "moved": len(moved),
        "deleted": len(moved) if permanent else 0,
        "quarantined": 0 if permanent else len(moved),
        "failed": len(failed),
        "failures": failed[:50],
        "rejected": rejected[:50],
        "rejected_count": len(rejected),
        "total_size": moved_size,
        "total_size_mb": round(moved_size / 1024 / 1024, 2),
        "trash_dirs": sorted({os.path.dirname(m["to"]) for m in moved if m.get("to")}),
        "report": _slim_report(report),
    }


def _slim_report(report: Dict[str, Any]) -> Dict[str, Any]:
    """扫描报告瘦身：清完之后的分组数已经变了，返回清理前的概览即可。"""
    return {
        "total": report["total"],
        "total_size_mb": report["total_size_mb"],
        "groups": [
            {k: g[k] for k in ("id", "label", "count", "size_mb")} for g in report["groups"]
        ],
    }


def _write_manifest(trash_root: str, original_root: str, moved: List[Dict[str, Any]], stamp: str) -> None:
    try:
        payload = {
            "stamp": stamp,
            "original_root": original_root,
            "trash_root": trash_root,
            "created_at": time.time(),
            "items": moved,
        }
        with open(os.path.join(trash_root, MANIFEST_NAME), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # 清单写不了不影响已完成的移动
        print(f"[Civitai-LoRA-Rack] 写清理清单失败：{exc}", file=sys.stderr)


def list_trash() -> List[Dict[str, Any]]:
    """列出所有隔离批次，供前端展示/还原。

    跨多根目录时，同一个批次号可能散落在多个根目录下。这里按批次号**聚合**成
    一条（count / size 累加，root 取第一个），避免前端看到两行相同批次号、
    点「还原」却只还原一份的困惑（:func:`restore` 现在会还原所有同名批次）。
    """
    by_stamp: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for root in cft_config.resolve_loras_dirs():
        base = os.path.join(root, TRASH_DIRNAME)
        if not os.path.isdir(base):
            continue
        try:
            stamps = sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d)))
        except OSError:
            continue
        for stamp in stamps:
            tdir = os.path.join(base, stamp)
            manifest = {}
            mpath = os.path.join(tdir, MANIFEST_NAME)
            if os.path.isfile(mpath):
                try:
                    with open(mpath, "r", encoding="utf-8") as f:
                        manifest = json.load(f)
                except Exception:
                    manifest = {}
            count, size = 0, 0
            for _dp, _dn, fns in os.walk(tdir):
                for fn in fns:
                    if fn == MANIFEST_NAME:
                        continue
                    count += 1
                    size += _file_size(os.path.join(_dp, fn))
            if stamp not in by_stamp:
                by_stamp[stamp] = {
                    "stamp": stamp,
                    "root": root,
                    "path": tdir,
                    "count": 0,
                    "size": 0,
                    "size_mb": 0.0,
                    "original_root": manifest.get("original_root", root),
                }
                order.append(stamp)
            by_stamp[stamp]["count"] += count
            by_stamp[stamp]["size"] += size
            by_stamp[stamp]["size_mb"] = round(by_stamp[stamp]["size"] / 1024 / 1024, 2)
    return [by_stamp[s] for s in order]


def restore(stamp: str) -> Dict[str, Any]:
    """把某个隔离批次原样还原回去。

    跨多根目录时，同一个批次号可能在每个根目录下都有一份（:func:`clean` 会
    在**每个**根目录下各写一个同名批次目录）。因此这里遍历**所有**根目录，
    把每一份同名批次都还原，而不是只认第一个命中的根目录 —— 否则隔离区里
    两行相同批次号，点「还原」却只还原了其中一个。
    """
    stamp = str(stamp or "").strip()
    if not stamp or os.path.sep in stamp or stamp.startswith("."):
        return {"ok": False, "error": "批次号非法"}

    # 收集所有根目录下同名批次目录（可能有 0..N 份）
    targets: List[str] = []
    for root in cft_config.resolve_loras_dirs():
        cand = os.path.join(root, TRASH_DIRNAME, stamp)
        if os.path.isdir(cand):
            targets.append(cand)
    if not targets:
        return {"ok": False, "error": f"找不到隔离批次：{stamp}"}

    restored, failed = 0, []
    for target_dir in targets:
        root = _root_of(os.path.join(target_dir, TRASH_DIRNAME))
        if not root:
            failed.append({"path": target_dir, "error": "隔离目录不在 lora 目录内"})
            continue
        for dirpath, dirnames, filenames in os.walk(target_dir):
            dirnames[:] = [d for d in dirnames if d != TRASH_DIRNAME]
            for fn in filenames:
                if fn == MANIFEST_NAME:
                    continue
                src = os.path.join(dirpath, fn)
                rel = os.path.relpath(src, target_dir)
                dst = os.path.join(root, rel)
                if not is_safe_path(dst):
                    failed.append({"path": src, "error": "unsafe_path"})
                    continue
                try:
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    if os.path.exists(dst):
                        raise FileExistsError("目标已被占用")
                    shutil.move(src, dst)
                    restored += 1
                except Exception as exc:
                    failed.append({"path": src, "error": f"{type(exc).__name__}: {exc}"})

        # 这一份全还原干净了就清掉这份的批次目录
        left = sum(len(fns) for _dp, _dn, fns in os.walk(target_dir) if _dp != target_dir)
        if not failed and left <= 1:
            shutil.rmtree(target_dir, ignore_errors=True)
            try:
                os.rmdir(os.path.dirname(target_dir))
            except OSError:
                pass

    return {"ok": not failed, "restored": restored, "failed": len(failed), "failures": failed[:50]}


def purge_trash(stamp: Optional[str] = None, all: bool = False) -> Dict[str, Any]:
    """**彻底删除**隔离区里的文件（走 ``os.remove``），并清掉批次目录。

    - ``stamp`` 指定单个批次；``stamp == "*"`` 或 ``all=True`` 删除全部批次。
    - 只接受批次号，绝不接受外部传入的绝对路径：所有待删路径由后端在
      ``<root>/.cft_trash/<stamp>/`` 之下自行拼出。
    - 每个待删路径都要过 :func:`is_safe_path(p, allow_trash=True)`（与 :func:`clean`
      同一把尺子，只是额外放行 ``.cft_trash`` 这一层）。批次号校验与 :func:`restore`
      完全一致。
    - ``.cft_trash`` 目录本身**永不删除**（空了也留着），避免误伤后续清理流程。
    - 清单文件 ``_cft_trash_manifest.json`` 不计入 ``deleted``/``freed``（与
      :func:`list_trash` 的口径一致），随批次目录一并删除。
    """
    do_all = bool(all) or (str(stamp or "").strip() == "*")

    roots = list(cft_config.resolve_loras_dirs())

    # 收集待处理的批次：[(root, 批次目录绝对路径, 批次号)]
    batches: List[Tuple[str, str, str]] = []
    if do_all:
        for root in roots:
            base = os.path.join(root, TRASH_DIRNAME)
            if not os.path.isdir(base):
                continue
            try:
                names = sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d)))
            except OSError:
                continue
            for name in names:
                batches.append((root, os.path.join(base, name), name))
    else:
        s = str(stamp or "").strip()
        # 与 restore() 同一套校验：非空、不含分隔符、不以点开头、非 ".."。
        if not s or os.path.sep in s or "/" in s or s.startswith(".") or s == "..":
            return {
                "ok": False, "error": "批次号非法", "deleted": 0, "freed": 0,
                "freed_mb": 0.0, "errors": [], "removed_dirs": [], "stamps": [],
            }
        # 跨多根目录时同名批次可能有多份，逐份都删（与 restore 口径一致）。
        found = False
        for root in roots:
            cand = os.path.join(root, TRASH_DIRNAME, s)
            if os.path.isdir(cand):
                batches.append((root, cand, s))
                found = True
        if not found:
            return {
                "ok": False, "error": f"找不到隔离批次：{s}", "deleted": 0, "freed": 0,
                "freed_mb": 0.0, "errors": [], "removed_dirs": [], "stamps": [],
            }

    deleted = 0
    freed = 0
    errors: List[Dict[str, Any]] = []
    removed_dirs: List[str] = []
    stamps: List[str] = []

    for _root, tdir, s in batches:
        stamps.append(s)
        for dirpath, dirnames, filenames in os.walk(tdir):
            dirnames[:] = [d for d in dirnames if d != TRASH_DIRNAME]
            for fn in filenames:
                if fn == MANIFEST_NAME:
                    continue
                p = os.path.join(dirpath, fn)
                if not is_safe_path(p, allow_trash=True):
                    errors.append({"path": p, "error": "unsafe_path"})
                    continue
                size = _file_size(p)
                try:
                    os.remove(p)
                    deleted += 1
                    freed += size
                except Exception as exc:
                    errors.append({"path": p, "error": f"{type(exc).__name__}: {exc}"})
        # 数据文件删净后，连批次目录（含清单）一起删掉。空目录在这里被清走。
        try:
            shutil.rmtree(tdir, ignore_errors=True)
            removed_dirs.append(s)
        except Exception as exc:
            errors.append({"path": tdir, "error": f"{type(exc).__name__}: {exc}"})
        # 刻意不动 .cft_trash 本身：即使空了也保留。

    return {
        "ok": not errors,
        "deleted": deleted,
        "freed": freed,
        "freed_mb": round(freed / 1024 / 1024, 2),
        "errors": errors[:50],
        "removed_dirs": removed_dirs,
        "stamps": stamps,
    }


# ------------------------------------------------------------------ 定位


def reveal(relative_name: str) -> Dict[str, Any]:
    """在系统文件管理器中定位到该 lora 文件（选中态）。"""
    abs_path = cft_metadata.resolve_lora_path(relative_name)
    if not abs_path:
        return {"ok": False, "error": f"找不到 Lora：{relative_name}"}
    if not is_safe_path(abs_path):
        return {"ok": False, "error": "路径不在 lora 目录内，已拒绝"}

    directory = os.path.dirname(abs_path)
    try:
        if sys.platform.startswith("win"):
            # 必须用 ShellExecuteW，不能用 subprocess 传 list。
            # Python 的 list2cmdline 会把整个 `/select,<路径>` 参数加引号，
            # 实际命令行变成 explorer "/select,F:\...\x.safetensors"，
            # explorer 认不出带引号的开关，于是打开默认（文档）文件夹。
            # ShellExecuteW 的 lpParameters 原样传递，写成 /select,"路径" 才是对的。
            import ctypes

            rc = ctypes.windll.shell32.ShellExecuteW(
                None, "open", "explorer.exe", f'/select,"{abs_path}"', None, 1
            )
            if rc <= 32:  # <=32 表示调用失败（0 = 内存不足，5 = 拒绝访问，…）
                raise OSError(f"ShellExecuteW 返回码 {rc}")
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", abs_path])
        else:
            subprocess.Popen(["xdg-open", directory])
    except Exception as exc:
        return {"ok": False, "error": f"打开文件管理器失败：{exc}", "dir": directory}

    return {"ok": True, "dir": directory, "path": abs_path}


def open_folder(relative_name: str) -> Dict[str, Any]:
    """直接打开所在文件夹（不选中文件）。"""
    abs_path = cft_metadata.resolve_lora_path(relative_name)
    if not abs_path:
        return {"ok": False, "error": f"找不到 Lora：{relative_name}"}
    directory = os.path.dirname(abs_path)
    try:
        if sys.platform.startswith("win"):
            os.startfile(directory)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", directory])
        else:
            subprocess.Popen(["xdg-open", directory])
    except Exception as exc:
        return {"ok": False, "error": f"打开文件夹失败：{exc}", "dir": directory}
    return {"ok": True, "dir": directory}


# ------------------------------------------------------------------ 删除 lora


def delete_lora(relative_name: str, include_body: bool = True, permanent: bool = False) -> Dict[str, Any]:
    """删除某个 lora 及其全部伴生文件。

    默认 (``permanent=False``) 同样走隔离区，可 :func:`restore` 还原 —— 与清理功能
    保持一致的安全水位。``include_body=False`` 时只删伴生、保留本体。
    """
    bundle = bundle_for(relative_name)
    if not bundle:
        return {"ok": False, "error": f"找不到 Lora：{relative_name}"}

    root = bundle["root"]
    directory = bundle["dir"]
    targets: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for f in bundle["files"]:
        p = os.path.join(directory, f["name"])
        if f["kind"] == "lora" and not include_body:
            skipped.append({"name": f["name"], "reason": "keep_lora_body"})
            continue
        if not is_safe_path(p):
            skipped.append({"name": f["name"], "reason": "unsafe_path"})
            continue
        if not os.path.isfile(p):
            skipped.append({"name": f["name"], "reason": "not_found"})
            continue
        targets.append({"path": _real(p), "name": f["name"], "size": f["size"], "kind": f["kind"]})

    if not targets:
        return {"ok": False, "error": "没有可删除的文件", "skipped": skipped, "bundle": bundle}

    # 同 clean()：批次号必须在根目录下未被占用，否则会并进已存在的批次目录
    # 并把它的清单覆盖掉。
    stamp = _claim_batch(_batch_id(), [root])
    done: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []

    if permanent:
        for t in targets:
            try:
                os.remove(t["path"])
                done.append({"from": t["path"], "to": None, "size": t["size"], "name": t["name"]})
            except Exception as exc:
                failed.append({"path": t["path"], "error": f"{type(exc).__name__}: {exc}"})
    else:
        trash_root = os.path.join(root, TRASH_DIRNAME, stamp)
        for t in targets:
            rel = os.path.relpath(t["path"], root)
            dst = os.path.join(trash_root, rel)
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if os.path.exists(dst):
                    raise FileExistsError("目标已存在")
                shutil.move(t["path"], dst)
                done.append({"from": t["path"], "to": dst, "size": t["size"], "name": t["name"]})
            except Exception as exc:
                failed.append({"path": t["path"], "error": f"{type(exc).__name__}: {exc}"})
        _write_manifest(trash_root, root, done, stamp)

    return {
        "ok": not failed,
        "lora": bundle["lora"],
        "permanent": bool(permanent),
        "stamp": None if permanent else stamp,
        "removed": len(done),
        "failed": len(failed),
        "failures": failed,
        "skipped": skipped,
        "freed": sum(d["size"] for d in done),
        "freed_mb": round(sum(d["size"] for d in done) / 1024 / 1024, 2),
        "trash_dir": None if permanent else os.path.join(root, TRASH_DIRNAME, stamp),
        "restorable": (not permanent) and bool(done),
    }
