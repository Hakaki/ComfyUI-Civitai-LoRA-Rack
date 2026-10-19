"""Civitai LoRA Rack（CLR）核心模块包。

各子模块职责：
- :mod:`cft_config`   —— 插件自有配置（C 站 API Key / 代理 / 域名）
- :mod:`cft_metadata` —— lora 扫描、元数据解析、哈希缓存
- :mod:`cft_civitai`  —— Civitai API 客户端
- :mod:`cft_cleanup`  —— 垃圾文件扫描/隔离/还原、lora 文件组、跳转与删除
- :mod:`cft_nodes`    —— ComfyUI 节点定义
- :mod:`cft_routes`   —— 前端调用的 HTTP 接口
- :mod:`cft_userdata` —— 用户自定义数据（标签 / 简介 / 封面）
"""

from . import (
    cft_cleanup,
    cft_civitai,
    cft_config,
    cft_metadata,
    cft_nodes,
    cft_routes,
    cft_userdata,
)

__all__ = [
    "cft_config",
    "cft_metadata",
    "cft_civitai",
    "cft_cleanup",
    "cft_nodes",
    "cft_routes",
    "cft_userdata",
]
