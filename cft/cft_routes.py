"""供前端调用的 HTTP 接口。

全部挂在 ComfyUI 自带的 aiohttp 服务上（与原生扩展同一套路），
不额外起端口，避免用户再开防火墙。
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
from typing import Any, Dict, List
from urllib.parse import quote, unquote, urlparse

from aiohttp import web

from . import cft_cleanup, cft_config, cft_civitai, cft_metadata, cft_userdata

logger = logging.getLogger(__name__)

__all__ = ["register_routes"]

PREFIX = "/cft_lora"

# 允许代理的图片域名（防盗链 + SSRF 防护）
_ALLOWED_IMAGE_HOSTS = (
    "civitai.com",
    "civitai.red",
    "image.civitai.com",
    "imagecache.civitai.com",
)

# 批量查 C 站（/refresh_batch）参数：
#   _BATCH_MAX         单次最多处理条数（超出截断）
#   _BATCH_CONCURRENCY 并发上限（避免打爆 C 站 / 代理）
#   _BATCH_TIMEOUT     单条查询超时秒数（超时记 error="timeout"，不拖垮整批）
_BATCH_MAX = 200
_BATCH_CONCURRENCY = 4
_BATCH_TIMEOUT = 60


def _ok(data: Any = None, **extra) -> web.Response:
    payload: Dict[str, Any] = {"ok": True}
    if data is not None:
        payload["data"] = data
    payload.update(extra)
    return web.json_response(payload)


def _err(message: str, status: int = 400, **extra) -> web.Response:
    payload: Dict[str, Any] = {"ok": False, "error": str(message)}
    payload.update(extra)
    return web.json_response(payload, status=status)


def _slim(item: Dict[str, Any]) -> Dict[str, Any]:
    """列表接口用的精简结构：去掉描述和示例图，减小传输量。"""
    civ = item.get("civitai") or {}
    return {
        "id": item.get("id"),
        "lora": item.get("lora"),
        "name": item.get("name"),
        "display_name": item.get("display_name") or item.get("name"),
        "folder": item.get("folder"),
        "file_name": item.get("file_name"),
        "size_mb": item.get("size_mb"),
        "mtime": item.get("mtime"),
        "preview": item.get("preview") or "",
        "has_meta": item.get("has_meta", False),
        "source": item.get("source"),
        "base_model": item.get("base_model") or "",
        "creator": item.get("creator") or "",
        "tags": item.get("tags") or [],
        "trained_words": item.get("trained_words") or [],
        "model_id": item.get("model_id"),
        "version_id": item.get("version_id"),
        "url": item.get("url") or "",
        "nsfw": item.get("nsfw"),
        "downloads": item.get("downloads"),
        "version_name": civ.get("version_name") or "",
        "remote_images": item.get("remote_images") or [],
        "training": item.get("training") or {},
        # 用户自定义数据（标签 / 简介 / 封面 / 收藏）——与 C 站数据分离，随列表一起返回，
        # 前端无需额外请求即可拿到。
        "user_tags": item.get("user_tags") or [],
        "user_note": item.get("user_note") or "",
        "has_user": item.get("has_user", False),
        "cover_url": item.get("cover_url") or "",
        "cover_type": item.get("cover_type") or "",
        "favorite": item.get("favorite", False),
        # 预览图文件 mtime：前端拿它拼 `/preview?name=...&v=<mtime>` 做 URL 版本号。
        # 换封面会改动 <base>.preview.png 的 mtime，URL 随之变化 → 浏览器不会命中旧缓存。
        "preview_mtime": item.get("preview_mtime") or 0,
    }


def register_routes() -> bool:
    """把路由注册到 ComfyUI 的 PromptServer 上。"""
    try:
        from server import PromptServer
    except Exception as exc:  # 独立测试环境（无 ComfyUI）
        logger.warning("[Civitai-LoRA-Rack] 未找到 ComfyUI server，跳过路由注册：%s", exc)
        return False

    routes = PromptServer.instance.routes

    # ---------------------------------------------------------- 配置与状态
    @routes.get(PREFIX + "/config")
    async def cft_config_status(request: web.Request) -> web.Response:
        return _ok(cft_config.get_status())

    @routes.post(PREFIX + "/config/set")
    async def cft_config_set(request: web.Request) -> web.Response:
        """写入 C 站 API Key（merge 进插件自己的 config.json，不覆盖其他字段）。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        api_key = str((body or {}).get("api_key") or "").strip()
        try:
            status = cft_config.set_api_key(api_key)
            return _ok(status)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 写入配置失败")
            return _err(str(exc), 500)

    @routes.post(PREFIX + "/config/test")
    async def cft_config_test(request: web.Request) -> web.Response:
        """验证 C 站 API Key 是否有效（调用 /api/v1/me 鉴权端点）。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        api_key = str((body or {}).get("api_key") or "").strip()
        # 未传则验证当前已存配置
        if not api_key:
            api_key = cft_config.get_api_key()
        try:
            info = cft_civitai.test_api_key(api_key)
            return _ok(info)
        except Exception as exc:
            return _err(str(exc), 400)

    @routes.get(PREFIX + "/health")
    async def cft_health(request: web.Request) -> web.Response:
        dirs = cft_config.resolve_loras_dirs()
        return _ok({"loras_dirs": dirs, "ready": bool(dirs)})

    # ---------------------------------------------------------- lora 列表
    @routes.get(PREFIX + "/list")
    async def cft_list(request: web.Request) -> web.Response:
        try:
            force = request.query.get("force") in ("1", "true", "yes")
            full = request.query.get("full") in ("1", "true", "yes")
            items = await asyncio.to_thread(cft_metadata.scan_loras, force, True)
            data = items if full else [_slim(i) for i in items]

            folders: Dict[str, int] = {}
            for it in items:
                f = it.get("folder") or "(根目录)"
                folders[f] = folders.get(f, 0) + 1

            return _ok(
                data,
                total=len(items),
                folders=[{"name": k, "count": v} for k, v in sorted(folders.items())],
                loras_dirs=cft_config.resolve_loras_dirs(),
            )
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 列表接口失败")
            return _err(exc, 500)

    @routes.post(PREFIX + "/reload")
    async def cft_reload(request: web.Request) -> web.Response:
        cft_metadata.invalidate_cache()
        cft_config.reload_config()
        items = await asyncio.to_thread(cft_metadata.scan_loras, True, True)
        return _ok({"total": len(items)})

    # ---------------------------------------------------------- 单个详情
    @routes.get(PREFIX + "/detail")
    async def cft_detail(request: web.Request) -> web.Response:
        name = unquote(request.query.get("name", ""))
        if not name:
            return _err("缺少 name 参数")
        try:
            deep = request.query.get("deep", "1") in ("1", "true", "yes")
            detail = await asyncio.to_thread(cft_metadata.get_lora_detail, name, deep)
            if not detail:
                return _err(f"找不到 Lora：{name}", 404)
            return _ok(detail)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 详情接口失败")
            return _err(exc, 500)

    # ---------------------------------------------------------- 在线刷新
    @routes.post(PREFIX + "/refresh")
    async def cft_refresh(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            body = {}

        name = str(body.get("name") or "")
        if not name:
            return _err("缺少 name 参数")

        abs_path = cft_metadata.resolve_lora_path(name)
        if not abs_path:
            return _err(f"找不到 Lora：{name}", 404)

        try:
            detail = await asyncio.to_thread(cft_metadata.get_lora_detail, name, True)
            file_hash = (detail or {}).get("sha256") or ((detail or {}).get("civitai") or {}).get("hashes", {}).get("SHA256")

            remote: Dict[str, Any] = {}
            if file_hash:
                remote = await asyncio.to_thread(cft_civitai.query_by_hash, file_hash)

            saved_path = None
            if remote:
                saved_path = await asyncio.to_thread(cft_civitai.save_civitai_info, abs_path, remote)
                cft_metadata.invalidate_cache()

            return _ok(
                {
                    "hash": file_hash,
                    "found": bool(remote),
                    "info": remote,
                    "saved_to": saved_path,
                    "name": name,
                }
            )
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 刷新接口失败")
            return _err(f"C 站查询失败：{exc}", 502)

    # ---------------------------------------------------- 批量查 C 站信息
    @routes.post(PREFIX + "/refresh_batch")
    async def cft_refresh_batch(request: web.Request) -> web.Response:
        """批量按文件哈希查询 C 站并写回 .civitai.info。

        body: {"names": ["a.safetensors", ...], "only_missing": true|false}
        - names 为空且 only_missing 为真时，后端自行挑选「缺 C 站信息」的条目。
        - 名单上限 _BATCH_MAX（超出截断并标注 truncated）。
        - 单条失败/超时不影响整批（记进该条 error）。
        """
        try:
            body = await request.json()
        except Exception:
            body = {}

        raw_names = body.get("names") or []
        if isinstance(raw_names, str):
            raw_names = [raw_names]
        names: List[str] = [str(n) for n in raw_names if str(n).strip()]
        only_missing = bool(body.get("only_missing"))

        # 让用户传 `names` 太多时也能优雅截断（先截断，再决定是否自动挑选）
        if len(names) > _BATCH_MAX:
            names = names[:_BATCH_MAX]
            truncated = True
        else:
            truncated = False

        if not names and only_missing:
            try:
                items = await asyncio.to_thread(cft_metadata.scan_loras, False, True)
            except Exception as exc:
                logger.exception("[Civitai-LoRA-Rack] 批量刷新：扫描失败")
                return _err(f"扫描 Lora 失败：{exc}", 500)
            candidates = [
                it.get("lora")
                for it in items
                if it.get("lora")
                and not it.get("creator")
                and not (it.get("tags") or [])
                and not (it.get("trained_words") or [])
            ]
            if len(candidates) > _BATCH_MAX:
                candidates = candidates[:_BATCH_MAX]
                truncated = True
            names = candidates

        sem = asyncio.Semaphore(_BATCH_CONCURRENCY)

        async def _one(name: str) -> Dict[str, Any]:
            rec: Dict[str, Any] = {"name": name, "found": False, "hash": None, "error": None}
            async with sem:
                try:
                    abs_path = await asyncio.to_thread(cft_metadata.resolve_lora_path, name)
                    if not abs_path:
                        rec["error"] = "not_found"
                        return rec

                    detail = await asyncio.to_thread(cft_metadata.get_lora_detail, name, True)
                    file_hash = (
                        (detail or {}).get("sha256")
                        or ((detail or {}).get("civitai") or {}).get("hashes", {}).get("SHA256")
                    )
                    rec["hash"] = file_hash
                    if not file_hash:
                        rec["error"] = "no_hash"
                        return rec

                    remote = await asyncio.wait_for(
                        asyncio.to_thread(cft_civitai.query_by_hash, file_hash),
                        timeout=_BATCH_TIMEOUT,
                    )
                    if remote:
                        await asyncio.to_thread(cft_civitai.save_civitai_info, abs_path, remote)
                        rec["found"] = True
                    return rec
                except asyncio.TimeoutError:
                    rec["error"] = "timeout"
                    return rec
                except Exception as exc:  # 单条异常不中断整批
                    rec["error"] = f"{type(exc).__name__}: {exc}"
                    return rec

        try:
            results = await asyncio.gather(*[_one(n) for n in names])
        finally:
            cft_metadata.invalidate_cache()

        found = sum(1 for r in results if r.get("found"))
        failed = sum(1 for r in results if r.get("error"))
        not_found = len(results) - found - failed

        return _ok(
            {
                "results": results,
                "total": len(results),
                "found": found,
                "not_found": not_found,
                "failed": failed,
                "truncated": truncated,
            }
        )

    # ---------------------------------------------------------- 本地预览图
    @routes.get(PREFIX + "/preview")
    async def cft_preview(request: web.Request) -> web.Response:
        name = unquote(request.query.get("name", ""))
        abs_path = cft_metadata.resolve_lora_path(name)
        if not abs_path:
            return _err("找不到 Lora", 404)

        directory = os.path.dirname(abs_path)
        file_name = os.path.basename(abs_path)
        preview = await asyncio.to_thread(cft_metadata.find_preview, directory, file_name)
        if not preview:
            return _err("没有本地预览图", 404)

        full = os.path.join(directory, preview)
        if not os.path.isfile(full):
            return _err("预览图不存在", 404)

        ctype = mimetypes.guess_type(full)[0] or "image/png"
        # no-cache（而非 no-store）：每次都会带 If-None-Match/If-Modified-Since 回源，
        # 文件没变时 FileResponse 直接回 304，既避免「换了封面浏览器还显示老图」，
        # 又保留 ETag/Last-Modified/Accept-Ranges 条件请求的省流特性。
        return web.FileResponse(full, headers={"Content-Type": ctype, "Cache-Control": "no-cache"})

    # ---------------------------------------------------------- 远程图片代理
    @routes.get(PREFIX + "/image")
    async def cft_image(request: web.Request) -> web.StreamResponse:
        raw_url = unquote(request.query.get("url", ""))
        if not raw_url:
            return _err("缺少 url 参数")

        try:
            parsed = urlparse(raw_url)
        except Exception:
            return _err("url 非法")

        host = (parsed.hostname or "").lower()
        if not any(host == h or host.endswith("." + h) for h in _ALLOWED_IMAGE_HOSTS):
            return _err("仅允许代理 Civitai 图片域名", 403)

        # 透传客户端的 Range / If-Range：非 faststart 的 mp4（moov 在尾部）必须靠
        # 浏览器的尾部 Range 请求才能拿到 moov，否则视频永远放不出来。
        fwd: Dict[str, str] = {}
        for hname in ("Range", "If-Range"):
            val = request.headers.get(hname)
            if val:
                fwd[hname] = val

        def _open() -> Any:
            session = cft_civitai._build_session()
            resp = session.get(
                raw_url,
                headers=fwd or None,
                timeout=(10, 60),
                stream=True,  # 边收边发，不把 7MB+ 视频整块读进内存
            )
            return session, resp

        session = None
        resp = None
        try:
            session, resp = await asyncio.to_thread(_open)
        except Exception as exc:
            return _err(f"图片代理失败：{exc}", 502)

        # 上游出错：按原风格返回，不泄露 Range 相关内部信息，并释放连接。
        if resp.status_code >= 400:
            try:
                resp.close()
            finally:
                session.close()
            return _err(f"上游返回 {resp.status_code}", 502)

        upstream_ct = resp.headers.get("Content-Type", "image/jpeg")
        # 视频封面是用户手指定的、URL 固定，缓存久了会固化错误内容 → 视频不缓存。
        is_video = upstream_ct.lower().startswith("video/")

        status = resp.status_code if resp.status_code in (200, 206) else 200
        stream = web.StreamResponse(status=status)
        stream.headers["Content-Type"] = upstream_ct
        stream.headers["Cache-Control"] = "no-cache" if is_video else "max-age=86400"
        # 声明支持 Range，浏览器才会发起分片/续传请求。
        stream.headers["Accept-Ranges"] = "bytes"
        c_range = resp.headers.get("Content-Range")
        if c_range:
            stream.headers["Content-Range"] = c_range
        c_enc = resp.headers.get("Content-Encoding")
        if c_enc:
            # 原样透出编码头，保证客户端拿到的字节与头部自洽。
            stream.headers["Content-Encoding"] = c_enc
        c_len = resp.headers.get("Content-Length")
        if c_len and c_len.isdigit():
            stream.content_length = int(c_len)

        try:
            await stream.prepare(request)
        except Exception:
            try:
                resp.close()
            finally:
                session.close()
            raise

        # 用底层 raw 流且关闭内容解码：转发的就是上游原始字节，
        # 与上面透出的 Content-Length / Content-Encoding 严格对应（避免解压后长度不符导致客户端挂死）。
        chunks = resp.raw.stream(64 * 1024, decode_content=False)

        def _read_next() -> bytes:
            try:
                return next(chunks) or b""
            except StopIteration:
                return b""

        try:
            while True:
                chunk = await asyncio.to_thread(_read_next)
                if not chunk:
                    break
                await stream.write(chunk)
            await stream.write_eof()
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            try:
                resp.close()
            finally:
                session.close()

        return stream

    # ---------------------------------------------------------- 文件夹
    @routes.get(PREFIX + "/folders")
    async def cft_folders(request: web.Request) -> web.Response:
        items = await asyncio.to_thread(cft_metadata.scan_loras, False, False)
        folders: Dict[str, int] = {}
        for it in items:
            f = it.get("folder") or "(根目录)"
            folders[f] = folders.get(f, 0) + 1
        return _ok([{"name": k, "count": v} for k, v in sorted(folders.items())])

    # ========================================================== 清理与文件操作
    # 安全约定（详见 cft_cleanup 模块文档）：
    #   · 清理永不删 lora 本体
    #   · 清理默认移到 .cft_trash 隔离区，permanent=true 才彻底删除
    #   · 服务端收到请求后自己重扫重判，不信任前端传来的文件清单

    @routes.post(PREFIX + "/cleanup_scan")
    async def cft_cleanup_scan(request: web.Request) -> web.Response:
        """扫描清理候选，按分类返回（不含文件清单以外的可写操作）。"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        want_items = bool(body.get("with_items", True))
        try:
            report = await asyncio.to_thread(cft_cleanup.scan_orphans)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 清理扫描失败")
            return _err(exc, 500)

        if not want_items:
            report = dict(report)
            report["groups"] = [
                {k: v for k, v in g.items() if k != "items"} for g in report["groups"]
            ]
        return _ok(report)

    @routes.post(PREFIX + "/cleanup")
    async def cft_cleanup_run(request: web.Request) -> web.Response:
        """执行清理。body: {categories: [...], permanent: bool, dry_run: bool}"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        categories = body.get("categories")
        if isinstance(categories, str):
            categories = [categories]
        try:
            res = await asyncio.to_thread(
                cft_cleanup.clean,
                [str(c) for c in categories] if categories else None,
                None,
                bool(body.get("permanent")),
                bool(body.get("dry_run")),
            )
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 清理失败")
            return _err(exc, 500)
        if not res.get("dry_run"):
            cft_metadata.invalidate_cache()
        return _ok(res)

    @routes.get(PREFIX + "/cleanup_trash")
    async def cft_cleanup_trash(request: web.Request) -> web.Response:
        try:
            return _ok(await asyncio.to_thread(cft_cleanup.list_trash))
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 读取隔离区失败")
            return _err(exc, 500)

    @routes.post(PREFIX + "/cleanup_restore")
    async def cft_cleanup_restore(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:
            body = {}
        try:
            res = await asyncio.to_thread(cft_cleanup.restore, str(body.get("stamp") or ""))
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 还原失败")
            return _err(exc, 500)
        if not res.get("ok"):
            return _err(res.get("error") or "还原失败", 400, data=res)
        cft_metadata.invalidate_cache()
        return _ok(res)

    @routes.post(PREFIX + "/trash_delete")
    async def cft_trash_delete(request: web.Request) -> web.Response:
        """彻底删除隔离区文件（不可还原）。body: {stamp:"..."} 或 {stamp:"*"} / {all:true}

        只接受批次号，路径由后端在 .cft_trash 内自行拼；安全校验见 cft_cleanup.purge_trash。
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        stamp = body.get("stamp")
        do_all = bool(body.get("all")) or (str(stamp or "").strip() == "*")
        try:
            res = await asyncio.to_thread(cft_cleanup.purge_trash, stamp, do_all)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 彻底删除隔离区失败")
            return _err(exc, 500)
        if not res.get("ok"):
            return _err(res.get("error") or "彻底删除失败", 400, data=res)
        cft_metadata.invalidate_cache()
        return _ok(res)

    @routes.get(PREFIX + "/bundle")
    async def cft_bundle(request: web.Request) -> web.Response:
        """某 lora 的完整文件清单（本体 + 预览图 + 全部侧车）。"""
        name = unquote(request.query.get("name", ""))
        if not name:
            return _err("缺少 name 参数")
        try:
            bundle = await asyncio.to_thread(cft_cleanup.bundle_for, name)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 取文件清单失败")
            return _err(exc, 500)
        if not bundle:
            return _err(f"找不到 Lora：{name}", 404)
        return _ok(bundle)

    @routes.post(PREFIX + "/reveal")
    async def cft_reveal(request: web.Request) -> web.Response:
        """在文件管理器中定位到该 lora。body: {name, mode: "select"|"folder"}"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str(body.get("name") or "")
        if not name:
            return _err("缺少 name 参数")
        mode = str(body.get("mode") or "select")
        fn = cft_cleanup.open_folder if mode == "folder" else cft_cleanup.reveal
        try:
            res = await asyncio.to_thread(fn, name)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 定位文件失败")
            return _err(exc, 500)
        if not res.get("ok"):
            return _err(res.get("error") or "定位失败", 400, data=res)
        return _ok(res)

    @routes.post(PREFIX + "/delete_local")
    async def cft_delete_local(request: web.Request) -> web.Response:
        """删除本地 lora 及其伴生文件。body: {name, include_body, permanent}

        默认走隔离区可还原；permanent=true 才是彻底删除。
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str(body.get("name") or "")
        if not name:
            return _err("缺少 name 参数")
        include_body = body.get("include_body", True)
        try:
            res = await asyncio.to_thread(
                cft_cleanup.delete_lora,
                name,
                bool(include_body),
                bool(body.get("permanent")),
            )
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 删除 lora 失败")
            return _err(exc, 500)
        if not res.get("ok") and not res.get("removed"):
            return _err(res.get("error") or "删除失败", 400, data=res)
        cft_metadata.invalidate_cache()
        return _ok(res)

    # ================================================ 用户自定义数据（标签 / 简介 / 封面）
    # 与 C 站数据严格分离：刷新 C 站只写 .civitai.info，绝不覆盖这里的 .cft-user.json。

    @routes.get(PREFIX + "/user_meta")
    async def cft_user_meta_get(request: web.Request) -> web.Response:
        """读某 lora 的自定义标签 / 简介 / 封面。"""
        name = unquote(request.query.get("name", ""))
        if not name:
            return _err("缺少 name 参数")
        try:
            data = await asyncio.to_thread(cft_userdata.read, name)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 读取用户数据失败")
            return _err(exc, 500)
        return _ok(data)

    @routes.post(PREFIX + "/user_meta")
    async def cft_user_meta_set(request: web.Request) -> web.Response:
        """写自定义标签 / 简介 / 收藏（部分更新）。body: {name, tags, note, favorite}"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str(body.get("name") or "")
        if not name:
            return _err("缺少 name 参数")
        try:
            data = await asyncio.to_thread(
                cft_userdata.write,
                name,
                tags=body.get("tags"),
                note=body.get("note"),
                # favorite 只在调用方给了「布尔值」时才写；缺省 / 非布尔都不动它，
                # 这样「只存标签」的调用永远不会把用户的收藏悄悄清掉。
                favorite=body.get("favorite") if isinstance(body.get("favorite"), bool) else None,
            )
        except ValueError as exc:
            return _err(exc, 400)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 写入用户数据失败")
            return _err(exc, 500)
        cft_metadata.invalidate_cache()
        return _ok(data)

    @routes.get(PREFIX + "/user_tags")
    async def cft_user_tags(request: web.Request) -> web.Response:
        """全部自定义标签（去重 + 排序），供前端做标签筛选。"""
        try:
            tags = await asyncio.to_thread(cft_userdata.list_user_tags)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 读取用户标签失败")
            return _err(exc, 500)
        return _ok(tags)

    @routes.post(PREFIX + "/set_cover")
    async def cft_set_cover(request: web.Request) -> web.Response:
        """设封面。body: {name, url, type, download}

        ``download=true`` 时下载到本地（图片 -> <base>.preview.png，
        视频 -> <base>.preview.mp4）；``type`` 为 ``image`` / ``video``。
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str(body.get("name") or "")
        if not name:
            return _err("缺少 name 参数")
        url = str(body.get("url") or "")
        if not url:
            return _err("缺少 url 参数")
        kind = "downloaded" if body.get("download") else "remote"
        is_video = str(body.get("type") or "").lower() == "video"
        try:
            data = await asyncio.to_thread(cft_userdata.set_cover, name, url, kind, is_video)
        except ValueError as exc:
            return _err(exc, 400)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 设置封面失败")
            return _err(exc, 500)
        cft_metadata.invalidate_cache()
        return _ok(data)

    @routes.post(PREFIX + "/clear_cover")
    async def cft_clear_cover(request: web.Request) -> web.Response:
        """清除自定义封面：还原备份预览图，并删除视频封面。body: {name}"""
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str(body.get("name") or "")
        if not name:
            return _err("缺少 name 参数")
        try:
            data = await asyncio.to_thread(cft_userdata.clear_cover, name)
        except ValueError as exc:
            return _err(exc, 400)
        except Exception as exc:
            logger.exception("[Civitai-LoRA-Rack] 清除封面失败")
            return _err(exc, 500)
        cft_metadata.invalidate_cache()
        return _ok(data)

    logger.info("[Civitai-LoRA-Rack] 接口已注册：%s/*", PREFIX)
    return True
