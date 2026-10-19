"""ComfyUI-Civitai-LoRA-Rack

在 ComfyUI 里直接管理一排 LoRA，并查看它们在 Civitai 上的信息：

- 节点上直接管理 LoRA 列表（增删、排序、权重调节、显隐）
- 一键查看每条 LoRA 的 C 站信息（作者 / 标签 / 训练触发词 / 示例图 / 下载量）
- API Key / 镜像域名 / 代理由用户在插件设置里自行填写，只存本机、不上传
- 优先读取本地 ``.civitai.info`` 与 safetensors 头部，离线也有完整信息
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# ComfyUI 会自动把 WEB_DIRECTORY 登记进 EXTENSION_WEB_DIRS（nodes.py 里
# `if hasattr(module, "WEB_DIRECTORY")` 那一段），**不要**再手动注册一次。
# 旧写法手动塞 EXTENSION_WEB_DIRS["civitai-lora-rack"] 的后果：同一个 web 目录被
# 登记成两个不同的 URL（/extensions/civitai-lora-rack/ 与 /extensions/ComfyUI-Civitai-LoRA-Rack/），
# 前端把同一份 JS 当两个模块 import 两次 → 第二次 registerExtension 抛
# "Extension named 'CFT.LoraStack' already registered"，并可能中断后续扩展加载（v2.25 修）。
from .cft.cft_nodes import CFTLoraLoader, CFTLoraStack
from .cft.cft_routes import register_routes

NODE_CLASS_MAPPINGS = {
    "CFTLoraStack": CFTLoraStack,
    "CFTLoraLoader": CFTLoraLoader,
}

# v2.31 改名：CFT Lora堆 → Civitai LoRA Rack（CLR），CFT Lora加载器 → Civitai LoRA Slot（CLS）。
# v2.34 起中文显示名改走「缩写 + 功能」：CLR - LoRA 加载器 / CLS - 单条 LoRA 加载
#（Rack / Stack 直译都生硬，中文统一叫「LoRA 堆」）；英文仍保留 Civitai LoRA Rack / Slot 全称。
# 品牌前缀从「CFT」（内部项目代号，对外无信息量）换成「Civitai」（真实数据来源）。
# 注意：上面的 NODE_CLASS_MAPPINGS 键（= 工作流里存的 node type）绝对不能动，
# 改名只影响显示名，已有工作流不会红框。
NODE_DISPLAY_NAME_MAPPINGS = {
    "CFTLoraStack": "CLR - LoRA 加载器",
    "CFTLoraLoader": "CLS - 单条 LoRA 加载",
}

WEB_DIRECTORY = "./web"

try:
    register_routes()
except Exception as exc:  # 路由注册失败不应阻断节点加载
    logger.exception("[Civitai-LoRA-Rack] 接口注册失败：%s", exc)

logger.info("[Civitai-LoRA-Rack] 已加载，节点：CFTLoraStack / CFTLoraLoader")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
