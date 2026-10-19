/**
 * ComfyUI-Civitai-LoRA-Rack 前端扩展
 *
 * 交互参考主流的 LoRA Stack 节点，数据源是 Civitai：
 *   - 节点上直接管理 LoRA 堆（缩略图 / 权重 / 显隐）
 *   - 「打开 LoRA 堆」弹出完整管理面板（拖动排序、权重、C 站信息、批量查 C 站）
 *   - 右上角「＋」打开全量 Lora 选择器，卡片 / 列表两种视图
 *
 * 数据仍然保存在节点自带的 lora_stack widget 里（JSON 字符串），
 * 与主流 LoRA Stack 节点的数据协议兼容，因此工作流可以互相搬运。
 *
 * 第二批改进（7 项）：
 *   R1 详情页 Lightbox 大图（缩放 / 平移 / 多图导航）
 *   R2 浮动窗口可调整大小 + localStorage 记忆位置尺寸
 *   R3 堆面板列表拖动排序（仅把手可拖，保留 ↑/↓）
 *   R4 删除权重拖动条（仅保留数字输入框）
 *   R5 选择器：刷新 / 卡片列表切换 / 卡片尺寸 / 窗口 resize + 记忆
 *   R6 LoRA 堆窗口单例（StackManager / Picker）
 *   R7 缺 C 站信息的 Lora：单条/批量从 C 站查找
 *
 * 第三批改进（2 项）：
 *   R8 清理功能：扫描/清理与现有 lora 不相关的孤立图片、侧车、下载残留（默认进隔离区可还原）
 *   R9 右键菜单：定位到所在文件夹 / 查看本地文件 / 从堆移除 / 本地删除（连带图片与信息文件）
 *
 * 第四批改进（6 项）：
 *   R10 自绘确认 / 选择 / 信息框（askChoice / askConfirm / showInfoModal）——
 *       彻底替换 window.prompt（Electron 下该 API 不可用，会静默返回 null），
 *       曾经的「点『打开隔离区』没反应」「本地删除点了没动静」就是这个原因。
 *   R11 隔离区管理窗口 TrashModal：逐批次列出 + 一键还原（修「打开隔离区没反应」）。
 *   R12 本地删除改自绘三步：文件清单 → 选隔离 / 永久 → 二次确认（不再用原生 confirm）。
 *   R13 同名 Lora 副本区分：按 C 站 model_id / version_id 归组，标「副本 i/n」并显示文件名词干。
 *   R14 封面：详情窗可「设为封面」（图片下载成本地预览图，视频只记链接），
 *       并可「清除自定义封面」还原原图；主图下方给出一行封面来源说明。
 *   R15 自定义标签 / 说明：详情窗可编辑（存本地 .cft-user.json，刷新 C 站不会覆盖），
 *       选择器支持按自定义标签筛选、并把说明 / 文件名纳入搜索。
 *
 * 两条 Electron / 后端约束（勿踩）：
 *   · window.prompt 在 ComfyUI Desktop（Electron）不可用，本文件禁止再调用它。
 *   · 视频封面只能 download:false 并走 /cft_lora/image 代理播放：
 *     后端 cft_metadata.find_preview 只认图片、/preview 也只服务图片，
 *     落地的 <base>.preview.mp4 没有任何路由能提供播放。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT_NAME = "CFT.LoraStack";
const API_BASE = "/cft_lora";
/**
 * 前端版本标记，显示在堆窗口标题右侧。
 * 用途：一眼确认浏览器跑的是不是最新那一份 JS —— 扩展 JS 被浏览器缓存时，
 * 「代码明明改了却没效果」是最难查的一类问题（记得 Ctrl+Shift+R 强刷）。
 * 每轮改动前端后请同步 +1。
 */
const FRONTEND_VERSION = "2.36";
const NODE_CLASS = "CFTLoraStack";
/** 单条加载器节点（插槽名翻译也要覆盖它） */
const NODE_CLASS_LOADER = "CFTLoraLoader";

/**
 * 双注册防护（v2.25）
 *
 * ComfyUI 会把 `WEB_DIRECTORY` 自动登记进 `EXTENSION_WEB_DIRS`；若插件（旧版）再手动登记
 * 一次，同一个 web 目录会以两个不同 URL 出现，前端把同一份 JS 当两个模块各 import 一次 →
 * 第二次 `app.registerExtension` 直接抛 "Extension named 'CFT.LoraStack' already registered"，
 * 冒泡出去还会中断后续扩展的加载（实测连累别的插件的动态分块）。
 *
 * 服务端已改为只登记一次；这里再加一道前端兜底：同一页面里只有第一份实例才挂监听 / 注册扩展。
 */
const CFT_PRIMARY_INSTANCE = !globalThis.__CFT_LORASTACK_BOOTED__;
if (CFT_PRIMARY_INSTANCE) globalThis.__CFT_LORASTACK_BOOTED__ = true;

/** localStorage key 前缀 */
const LS_PREFIX = "cft.loraStack.";

/** 浮动窗口几何约束 */
const MIN_WIN_W = 360;
const MIN_WIN_H = 240;

/** 选择器卡片尺寸（px） */
const CARD_SIZE_MIN = 120;
const CARD_SIZE_MAX = 320;
const CARD_SIZE_DEFAULT = 168;

/** Lightbox 打开标志：打开期间底层 Modal 的 Esc 监听要让位（只关大图）。 */
let LIGHTBOX_OPEN = false;

/* ------------------------------------------------------------------ 样式 */

(function injectCSS() {
  try {
    if (document.querySelector("link[data-cft-lora-css]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./cft_lora_stack.css", import.meta.url).href;
    link.dataset.cftLoraCss = "1";
    document.head.appendChild(link);
  } catch (err) {
    console.warn(T("[Civitai-LoRA-Rack] CSS 注入失败"), err);
  }
})();

/* ------------------------------------------------------------- 本地存储 */

/**
 * 轻量 localStorage 封装：所有读写都 try/catch。
 * 隐私模式 / 禁用存储时静默降级为「无持久化」，绝不抛错影响主流程。
 */
const LS = {
  getJSON(key, fallback = null) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  setJSON(key, value) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    } catch {
      /* 静默降级 */
    }
  },
  getStr(key, fallback = null) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw === null ? fallback : raw;
    } catch {
      return fallback;
    }
  },
  setStr(key, value) {
    try {
      localStorage.setItem(LS_PREFIX + key, String(value));
    } catch {
      /* 静默降级 */
    }
  },
};

/* ------------------------------------------------------------------ i18n */

/**
 * 国际化（i18n）。
 * - 默认 / 兜底语言为中文：未翻译的文案回落中文原文，绝不崩。
 * - T(zh, ...args)：zh 即中文原文（同时作为查表键）；英文模式下查 I18N.en[zh]，
 *   命中返英文，未命中回落 zh。模板串用 {0} {1} 占位，与 args 顺序对应。
 * - 语言选择持久化到 localStorage（LS），切换时即时重渲染所有已打开的 CFT 浮窗。
 */
let LANG = (LS.getStr("lang", "zh") || "zh") === "en" ? "en" : "zh";

function getLang() {
  return LANG;
}

function setLang(lang) {
  LANG = lang === "en" ? "en" : "zh";
  LS.setStr("lang", LANG);
  // 立即重渲染所有已打开的 CFT 浮窗，让语言切换即时生效
  try {
    if (typeof OPEN_MODALS !== "undefined") {
      for (const m of OPEN_MODALS.values()) {
        try { if (m && typeof m.onOpen === "function") m.onOpen(); } catch (e) { console.warn("[CFT] relang failed", e); }
      }
    }
  } catch (e) {}
  try { window.dispatchEvent(new CustomEvent("cft:langchange")); } catch (e) {}
}

function T(zh, ...args) {
  let s = (LANG === "en" && I18N.en[zh] != null) ? I18N.en[zh] : zh;
  if (args.length) {
    s = s.replace(/\{(\d+)\}/g, (_, i) => (args[Number(i)] != null ? args[Number(i)] : ""));
  }
  return s;
}

const I18N = {
  en: {
  "\n文件：{0}": "\nFile: {0}",
  "\n有自定义标签 / 说明": "\nHas custom tags / notes",
  "C 站信息": "Civitai Info",
  "C 站元数据文件": "Civitai Metadata File",
  "C 站描述": "Civitai Description",
  "C 站未收录该文件（hash: ": "Not listed on Civitai (hash: ",
  "C 站未收录该文件（hash: {0}…）": "Not listed on Civitai (hash: {0}…)",
  "C 站标签": "Civitai Tags",
  "CLR - LoRA 加载器": "Civitai LoRA Rack (CLR)",
  "Key 保存在本机 user/default/Civitai-LoRA-Rack/config.json 的 api_key 字段，不会上传，仅本机生效。": "The API key is stored locally in user/default/Civitai-LoRA-Rack/config.json under the api_key field. It is never uploaded and only applies to this machine.",
  "CLR - LoRA 加载器 · {0}": "Civitai LoRA Rack · {0}",
  "Lora 模型本体（.safetensors/.ckpt/.pt/.bin）永远不会被清理。": "Lora model files (.safetensors/.ckpt/.pt/.bin) are never cleaned up.",
  "Lora 详情": "Lora Details",
  "Lora：{0}": "Lora: {0}",
  "Safetensors 头部": "Safetensors Header",
  "UNet 学习率": "UNet Learning Rate",
  "[Civitai-LoRA-Rack] CSS 注入失败": "[Civitai-LoRA-Rack] CSS injection failed",
  "[Civitai-LoRA-Rack] addDOMWidget 不受支持，降级为按钮模式": "[Civitai-LoRA-Rack] addDOMWidget unsupported; falling back to button mode",
  "[Civitai-LoRA-Rack] 前端扩展已加载": "[Civitai-LoRA-Rack] frontend extension loaded",
  "[Civitai-LoRA-Rack] 右键菜单项执行失败": "[Civitai-LoRA-Rack] context menu item execution failed",
  "[Civitai-LoRA-Rack] 生成右键菜单失败": "[Civitai-LoRA-Rack] failed to build context menu",
  "{0}\n所在目录：{1}\n合计 {2} 个文件 / {3}": "{0}\nLocation: {1}\nTotal {2} files / {3}",
  "{0} {1} 个文件，释放 {2}": "{0} {1} files, freed {2}",
  "{0} 个": "{0} items",
  "{0} 个文件 · {1}": "{0} files · {1}",
  "{0} 生效": "{0} active",
  "{0}×{1}（点击设为主图，再点大图看大图）": "{0}×{1} (click to set as main image, then click to view large)",
  "{0}（{1} 个失败）": "{0} ({1} failed)",
  "… 另有 {0} 个未列出": "… {0} more not listed",
  "…）": "…)",
  "↻ 从 C 站刷新": "↻ Refresh from Civitai",
  "↻ 刷新": "↻ Refresh",
  "↻ 重新扫描": "↻ Rescan",
  "↻ 重试": "↻ Retry",
  "▦ 卡片": "▦ Cards",
  "▶ 视频": "▶ Video",
  "★ 取消收藏": "★ Unfavorite",
  "★ 已收藏": "★ Favorited",
  "★ 收藏中 ({0})": "★ Favoriting ({0})",
  "☰ 列表": "☰ List",
  "⚙ 设置": "⚙ Settings",
  "⚠ 已从本机备份恢复 {0} 条": "⚠ Recovered {0} entries from local backup",
  "⚠️ 删除后无法还原，文件会从磁盘上消失。": "⚠️ Deletion is irreversible; the file will be removed from disk.",
  "⚠️ 彻底删除后无法还原。": "⚠️ Permanent deletion is irreversible.",
  "⚠️ 彻底删除后无法还原，确定继续吗？": "⚠️ Permanent deletion is irreversible. Continue?",
  "✓ 有效 · 账号 ": "✓ Valid · Account ",
  "✗ 验证失败：": "✗ Verification failed: ",
  "⭐ 把此图片设为封面": "⭐ Set this image as cover",
  "⭐ 把此视频设为封面": "⭐ Set this video as cover",
  "⭐ 收藏": "⭐ Favorite",
  "⭐ 收藏 ({0})": "⭐ Favorite ({0})",
  "⭐ 设为封面": "⭐ Set as cover",
  "上一张 (←)": "Previous (←)",
  "上移": "Move up",
  "下一张 (→)": "Next (→)",
  "下移": "Move down",
  "下载量": "Downloads",
  "不勾选时文件会被移到 loras/.cft_trash/，可以随时还原": "If unchecked, files are moved to loras/.cft_trash/ and can be restored anytime",
  "为当前列表里 {0} 条缺作者 / 标签 / 触发词的 Lora 批量在线查询": "Batch online lookup for {0} Loras in the current list missing author / tags / trigger words",
  "为当前列表里缺少 C 站信息的 Lora 批量在线查询（可按搜索/文件夹缩小范围）": "Batch online lookup for Loras in the current list lacking Civitai info (narrow by search / folder)",
  "从 C 站刷新信息": "Refresh info from Civitai",
  "从 C 站查询这条 Lora": "Query this Lora on Civitai",
  "从堆中移除": "Remove from rack",
  "优化器": "Optimizer",
  "作者": "Author",
  "保存": "Save",
  "保存中…": "Saving…",
  "保存失败：": "Save failed: ",
  "全部停用": "Disable all",
  "全部启用": "Enable all",
  "全部文件夹 ({0})": "All folders ({0})",
  "全部标签 ({0})": "All tags ({0})",
  "共 {0} 个 · 已选 {1}": "Total {0} · Selected {1}",
  "共 {0} 个批次": "Total {0} batches",
  "共 {0} 条 · {1} 条生效": "Total {0} · {1} active",
  "共发现 {0} 个无关文件，占用 {1}": "Found {0} unrelated files, occupying {1}",
  "关闭": "Close",
  "关闭 (Esc)": "Close (Esc)",
  "其余自定义标签：\n": "Other custom tags:\n",
  "写点关于这个 Lora 的说明…": "Write some notes about this Lora…",
  "分类：{0}": "Categories: {0}",
  "列表视图": "List view",
  "删除 .safetensors 本体 + 预览图 + 全部侧车；默认移到隔离区可还原": "Delete .safetensors body + preview + all sidecars; moved to quarantine by default (restorable)",
  "删除失败": "Delete failed",
  "删除该标签": "Delete this tag",
  "刷新中…": "Refreshing…",
  "前端 v{0}": "Frontend v{0}",
  "副本 {0}/{1}": "Copy {0}/{1}",
  "匹配 {0} 个 · 已选 {1}": "Matched {0} · Selected {1}",
  "卡片尺寸 {0}~{1}": "Card size {0}~{1}",
  "卡片视图": "Card view",
  "即将{0} {1} 个文件（{2}）。": "About to {0} {1} files ({2}).",
  "即将处理「{0}」的以下 {1} 个本地文件（合计 {2}）": "About to process the following {1} local files of \"{0}\" (total {2})",
  "原位置：{0}": "Original location: {0}",
  "原始尺寸 1:1": "Original size 1:1",
  "发布时间": "Published",
  "取消": "Cancel",
  "取消收藏": "Unfavorite",
  "只从堆里去掉，不动磁盘文件": "Only remove from the rack; do not touch disk files",
  "只清空这个 Lora 的自定义标签（说明不受影响）": "Only clear this Lora's custom tags (notes unaffected)",
  "只清空这个 Lora 的说明（标签不受影响）": "Only clear this Lora's notes (tags unaffected)",
  "只渲染前 {0} 条，点「管理」查看全部": "Only rendering the first {0}; click \"Manage\" to see all",
  "只看收藏的 Lora（再点一次取消）": "Show only favorited Loras (click again to cancel)",
  "右键：定位文件夹 / 本地删除": "Right-click: locate folder / delete locally",
  "启用": "Enable",
  "命中 {0} 条 · 未收录 {1} 条 · 失败 {2} 条": "Hit {0} · Not found {1} · Failed {2}",
  "哈希缓存": "Hash cache",
  "在 C 站打开 ↗": "Open on Civitai ↗",
  "在此粘贴你的 C 站 API Key": "Paste your Civitai API Key here",
  "在系统文件管理器中定位到该文件": "Locate this file in the system file manager",
  "基座模型": "Base model",
  "基本信息": "Basic info",
  "填写 C 站 API Key 后，可拉取 NSFW / 年龄验证内容，以及登录用户专享的模型版本与资源（部分内容需进 C 站站内才看得到）。": "After filling in the Civitai API Key, you can fetch NSFW / age-verified content, plus model versions and resources exclusive to logged-in users (some content is only visible when logged into Civitai).",
  "填写后点「验证」测试 Key 是否有效。": "After filling in, click \"Verify\" to test if the Key is valid.",
  "处理中…": "Processing…",
  "复制": "Copy",
  "复制失败，请手动选择": "Copy failed; please select manually",
  "学习率": "Learning rate",
  "完成": "Done",
  "封面：C 站图片": "Cover: Civitai image",
  "封面：无（占位）": "Cover: none (placeholder)",
  "封面：本地预览图": "Cover: local preview",
  "封面：自定义图片（已下载）": "Cover: custom image (downloaded)",
  "封面：自定义图片（链接）": "Cover: custom image (link)",
  "封面：自定义视频（链接）": "Cover: custom video (link)",
  "展开": "Expand",
  "工作流当时没保存，数据是从本机备份里找回来的": "The workflow wasn't saved at the time; data was recovered from the local backup",
  "已从本机备份恢复 {0} 条 Lora（工作流里存的是空堆）": "Recovered {0} Loras from local backup (the workflow held an empty rack)",
  "已保存": "Saved",
  "已保存 ✓": "Saved ✓",
  "已保存并验证": "Saved and verified",
  "已刷新，共 {0} 个": "Refreshed, total {0}",
  "已取消收藏": "Unfavorited",
  "已启用": "Enabled",
  "已在堆中": "Already in rack",
  "已在堆里（不可重复添加）": "Already in rack (cannot add again)",
  "已在文件管理器中定位": "Located in file manager",
  "已复制触发词": "Trigger words copied",
  "已彻底删除 {0} 个文件，释放 {1}": "Permanently deleted {0} files, freed {1}",
  "已恢复原封面": "Restored original cover",
  "已打开所在文件夹": "Opened containing folder",
  "已扫描 {0} 个目录 / {1} 个文件": "Scanned {0} directories / {1} files",
  "已收藏": "Favorited",
  "已更新 C 站信息": "Civitai info updated",
  "已更新「{0}」的 C 站信息": "Updated Civitai info for \"{0}\"",
  "已添加 {0} 条": "Added {0}",
  "已清空 API Key": "API Key cleared",
  "已清空 API Key。": "API Key cleared.",
  "已禁用": "Disabled",
  "已移到隔离区（可在清理窗口的「打开隔离区」里还原）{0} 个文件，释放 {1}": "Moved to quarantine (restorable via \"Open Quarantine\" in the cleanup window) {0} files, freed {1}",
  "已设为封面（已下载到本地）": "Set as cover (downloaded locally)",
  "已设为视频封面（记录链接）": "Set as video cover (link recorded)",
  "已还原 {0} 个文件": "Restored {0} files",
  "已选 {0} 类 · {1} 个文件 · {2} · {3}": "Selected {0} categories · {1} files · {2} · {3}",
  "已配置（": "Configured (",
  "当前列表里的 Lora 都已有 C 站信息": "All Loras in the current list already have Civitai info",
  "当前列表里的 Lora 都已有作者 / 标签信息": "All Loras in the current list already have author / tag info",
  "当前状态：": "Current status: ",
  "彻底删除": "Permanently delete",
  "彻底删除「{0}」的 {1} 个文件（{2}）。": "Permanently delete {1} files of \"{0}\" ({2}).",
  "彻底删除所选": "Permanently delete selected",
  "彻底删除确认": "Permanent deletion confirm",
  "彻底删除隔离区里的全部批次（不可还原）": "Permanently delete all batches in quarantine (irreversible)",
  "彻底删除隔离文件": "Permanently delete quarantined files",
  "彻底删除（不可还原）": "Permanently delete (irreversible)",
  "彻底删除（不经过隔离区，无法还原）": "Permanently delete (bypasses quarantine, irreversible)",
  "恢复原封面": "Restore original cover",
  "我的标签": "My tags",
  "我的标签 / 说明": "My tags / notes",
  "打开 C 站页面": "Open Civitai page",
  "打开 LoRA 堆": "Open LoRA Stack",
  "打开 LoRA 堆面板": "Open LoRA Stack Panel",
  "打开「{0}」详情": "Open details of \"{0}\"",
  "打开所在目录": "Open containing directory",
  "打开隔离区": "Open quarantine",
  "打标高频词（可作为触发词参考）": "High-frequency tagging words (reference for trigger words)",
  "扫描了 {0} 个目录 / {1} 个文件": "Scanned {0} directories / {1} files",
  "扫描失败：": "Scan failed: ",
  "扫描无结果": "Scan found nothing",
  "找不到该 Lora 的本地文件": "Local file for this Lora not found",
  "把当前堆里所有 Lora 设为停用（保留在列表中，出图时不生效）": "Set all Loras in the current rack to disabled (kept in list, inactive during generation)",
  "把当前大图/视频设为封面": "Set current large image/video as cover",
  "把输入框里的标签加进来（等价于回车）": "Add tags from the input box (same as Enter)",
  "把这个 Lora 收进「⭐ 收藏」（选择器里可一键只看收藏）": "Add this Lora to \"⭐ Favorites\" (one-click to show only favorites in the picker)",
  "把这个图片设为封面（下载到本地预览图）": "Set this image as cover (download to local preview)",
  "把这个批次的文件从磁盘上删掉（不可还原）": "Delete this batch's files from disk (irreversible)",
  "把这个视频设为封面（只记录链接）": "Set this video as cover (link only)",
  "拖动排序": "Drag to reorder",
  "拖动调整大小": "Drag to resize",
  "按文件哈希重新查询并写回 .civitai.info": "Re-query by file hash and write back .civitai.info",
  "按标签筛选（我的标签 / C 站标签）": "Filter by tag (my tags / Civitai tags)",
  "搜索名称 / 作者 / 文件名 / 标签 / 触发词 / 我的标签…": "Search name / author / filename / tags / trigger words / my tags…",
  "收藏": "Favorite",
  "收藏数": "Favorites",
  "收藏（之后可在工具栏「⭐ 收藏」里快速找到）": "Favorite (find quickly later via the \"⭐ Favorite\" toolbar button)",
  "收藏（之后可在选择器「⭐ 收藏」里快速找到）": "Favorite (find quickly later via the \"⭐ Favorite\" picker button)",
  "放大 (+) ": "Zoom in (+) ",
  "放大卡片": "Zoom in cards",
  "数据来源": "Data source",
  "文件会移到 loras/.cft_trash/，之后可在「打开隔离区」里还原。": "Files are moved to loras/.cft_trash/ and can be restored later via \"Open Quarantine\".",
  "文件大小": "File size",
  "文件清单": "File list",
  "无C站信息": "No Civitai info",
  "无效": "Invalid",
  "显示 / 隐藏": "Show / Hide",
  "最后确认": "Final confirmation",
  "最大步数": "Max steps",
  "最小化": "Minimize",
  "有 {0} 个文件处理失败，详见日志": "{0} files failed to process; see log for details",
  "有 {0} 个文件被安全校验拒绝": "{0} files were rejected by safety validation",
  "未发现模型目录": "No model directory found",
  "未知": "Unknown",
  "未配置": "Not configured",
  "本体 + 预览图 + 侧车，共几个文件多大": "Body + preview + sidecars: how many files and total size",
  "本地删除确认": "Local deletion confirm",
  "本地删除（含图片与信息文件）": "Local delete (including images and info files)",
  "本地文件清单": "Local file list",
  "权重（可输入任意实数）": "Weight (any real number allowed)",
  "架构": "Architecture",
  "查": "Search",
  "查看 C 站详情": "View Civitai details",
  "查看「{0}」详情": "View details of \"{0}\"",
  "查看已隔离的批次，并可还原": "View quarantined batches and restore them",
  "查看本地文件清单": "View local file list",
  "查询中…": "Querying…",
  "查询失败": "Query failed",
  "标签": "Tags",
  "根目录": "Root directory",
  "模型本体": "Model body",
  "模型权重": "Model weight",
  "模型标题": "Model title",
  "正在刷新模型库…": "Refreshing model library…",
  "正在加载模型库…": "Loading model library…",
  "正在只看收藏的 Lora（共 {0} 个）—— 再点一次恢复全部": "Showing only favorited Loras ({0} total) — click again to restore all",
  "正在扫描模型目录…": "Scanning model directory…",
  "正在查询 C 站 0/{0}…（单条可能需要几秒）": "Querying Civitai 0/{0}… (each may take a few seconds)",
  "正在清理…": "Cleaning up…",
  "正在读取元数据…": "Reading metadata…",
  "正在读取隔离区…": "Reading quarantine…",
  "正在验证…": "Verifying…",
  "没有匹配的 Lora": "No matching Lora",
  "添加 Lora": "Add Lora",
  "添加所选": "Add selected",
  "添加标签，回车 / 点「＋ 添加」（可用逗号一次加多个）": "Add tags; press Enter or click \"＋ Add\" (use commas to add several at once)",
  "清理与现有 Lora 无关的孤立图片、侧车文件、下载残留": "Clean up orphaned images, sidecar files, and download leftovers unrelated to existing Loras",
  "清理垃圾文件": "Clean up junk files",
  "清理所选": "Clean up selected",
  "清理时未勾选「彻底删除」的文件会进这里": "Files cleaned without \"Permanently delete\" checked go here",
  "清理确认": "Cleanup confirm",
  "清空": "Clear",
  "清空 LoRA 堆": "Clear LoRA Rack",
  "清空标签": "Clear tags",
  "清空自定义标签": "Clear custom tags",
  "清空说明": "Clear notes",
  "清空隔离区": "Empty quarantine",
  "清除自定义封面并还原原来的预览图": "Remove custom cover and restore the original preview",
  "点一下取消收藏": "Click to unfavorite",
  "点击查看 C 站详情": "Click to view Civitai details",
  "点击查看大图": "Click to view large image",
  "点击选中 / 取消选中": "Click to select / deselect",
  "点右上角「＋ 添加 Lora」从模型库里挑选": "Click \"＋ Add Lora\" at top right to pick from the model library",
  "版本": "Version",
  "目录很干净，没有发现垃圾文件": "Directory is clean; no junk files found",
  "直接打开文件夹，不选中文件": "Open folder directly without selecting a file",
  "知道了": "Got it",
  "确定": "Confirm",
  "确定彻底删除批次 {0} 的 {1} 个文件（{2}）吗？": "Permanently delete {1} files of batch {0} ({2})?",
  "确定彻底删除隔离区里全部 {0} 个批次的文件吗？": "Permanently delete all {0} batches in quarantine?",
  "确定清空 LoRA 堆吗？（只清空当前节点上的列表，不动磁盘文件）": "Clear the LoRA Rack? (Only clears the list on the current node; disk files untouched)",
  "确定清空这个 Lora 的全部自定义标签吗？说明不会受影响。": "Clear all custom tags for this Lora? Notes will not be affected.",
  "确定清空这个 Lora 的说明吗？标签不会受影响。": "Clear the notes for this Lora? Tags will not be affected.",
  "确定清除自定义封面，并还原成原来的预览图吗？": "Remove the custom cover and restore the original preview?",
  "确定还原批次 {0}？{1} 个文件（{2}）将回到原位置。": "Restore batch {0}? {1} files ({2}) will return to their original location.",
  "移到隔离区": "Move to quarantine",
  "移到隔离区（可还原）": "Move to quarantine (restorable)",
  "移到隔离区（推荐）": "Move to quarantine (recommended)",
  "移除": "Remove",
  "空 · 点「＋」添加 Lora": "Empty · click \"＋\" to add Lora",
  "管理": "Manage",
  "类型": "Type",
  "缩小 (-)": "Zoom out (-)",
  "缩小卡片": "Zoom out cards",
  "网络 alpha": "Network alpha",
  "网络模块": "Network module",
  "网络维度 dim": "Network dim",
  "自动保存": "Auto-save",
  "视频加载失败，可能是网络/代理不通或上游不支持 Range；可点「在 C 站打开 ↗」看原片": "Video failed to load; network/proxy may be blocked or the source doesn't support Range. Click \"Open on Civitai ↗\" to view the original",
  "视频封面": "Video cover",
  "视频封面 · ": "Video cover · ",
  "视频封面（点击查看 C 站详情）": "Video cover (click to view Civitai details)",
  "视频封面（点击查看详情）": "Video cover (click to view details)",
  "触发词": "Trigger words",
  "训练分辨率": "Training resolution",
  "训练参数（读取自 Safetensors 头部）": "Training params (read from Safetensors header)",
  "训练触发词": "Training trigger words",
  "训练轮数": "Training epochs",
  "设置": "Settings",
  "设置（C 站 API Key 等）": "Settings (Civitai API Key, etc.)",
  "C 站 API Key": "Civitai API Key",
  "清除 API Key": "Clear API Key",
  "清除": "Clear",
  "清除失败：": "Failed to clear: ",
  "确定要清除已保存的 C 站 API Key 吗？清除后，NSFW / 登录限定内容将无法查看。": "Clear the saved Civitai API Key? NSFW / login-only content will no longer be available.",
  "未填写 API Key。已保存的 Key 不会被改动；要清除请点「清除 API Key」。": "No API Key entered. The saved Key is unchanged; use \"Clear API Key\" to remove it.",
  "请先填写 API Key 再保存。": "Enter an API Key before saving.",
  "未填写 API Key，已保存的 Key 未改动": "No API Key entered; the saved Key is unchanged",
  "已保存 Key（留空不会改动；粘贴新 Key 才会覆盖）": "Key saved (leave blank to keep it; paste a new Key to overwrite)",
  "界面语言。切换后立即在所有已打开的窗口生效，并记忆到本机。": "Interface language. Changes apply immediately to all open windows and are remembered on this device.",
  "（同名副本 {0} 个，用文件名区分）": "({0} same-name copies, distinguished by filename)",
  "该 Lora 已在堆里": "This Lora is already in the rack",
  "请先勾选要清理的分类": "Please select categories to clean first",
  "请求失败 ({0})": "Request failed ({0})",
  "请选择": "Please select",
  "读取 C 站信息失败": "Failed to read Civitai info",
  "读取隔离区失败：": "Failed to read quarantine: ",
  "跳转到所在文件夹": "Jump to containing folder",
  "还原": "Restore",
  "还原失败": "Restore failed",
  "还原批次": "Restore batch",
  "还没有加入任何 Lora": "No Lora added yet",
  "还没有自定义标签": "No custom tags yet",
  "还没有选中任何 Lora": "No Lora selected yet",
  "适应": "Fit",
  "适应窗口": "Fit window",
  "选择 Lora": "Select Lora",
  "重新扫描模型目录（新增 / 删除的 Lora）": "Rescan model directory (added / removed Loras)",
  "重新统计垃圾文件": "Recount junk files",
  "重新读取隔离区批次": "Reread quarantine batches",
  "隔离区": "Quarantine",
  "隔离区已经是空的": "Quarantine is already empty",
  "隔离区是空的": "Quarantine is empty",
  "预览图": "Preview",
  "验证": "Verify",
  "（本次仅处理前 200 条，可缩小筛选范围再查）": "(Only the first 200 are processed this time; narrow the filter to query more)",
  "（注意：这些 Lora 可能已有 C 站侧车文件，只是作者等字段没写全；查询可尝试补全）": "(Note: these Loras may already have Civitai sidecar files, but fields like author are incomplete; querying can try to fill them in)",
  "（自动保存 · 仅本地，刷新 C 站不会覆盖）": "(Auto-saved · local only; refreshing Civitai won't overwrite)",
  "＋": "＋",
  "＋ 添加": "＋ Add",
  "＋ 添加 Lora": "＋ Add Lora",
  "－": "－",
  "🎴 打开 LoRA 堆": "🎴 Open LoRA Stack",
  "🔍 批量查 C 站": "🔍 Batch Civitai lookup",
  "🔍 批量查 C 站 ({0})": "🔍 Batch Civitai lookup ({0})",
  "🖼 恢复原封面": "🖼 Restore original cover",
  "🗑 彻底删除": "🗑 Permanently delete",
  "🗑 清空隔离区": "🗑 Empty quarantine",
  "🧹 清理垃圾": "🧹 Clean junk",
  "）": ")",
  "语言": "Language",
  "中文": "中文",
  "English": "English",
  "工作流标签栏": "Workflow tab bar",
  "ComfyUI 前端偶发的问题：标签点了不换图、× 关不掉、凭空多出 Unsaved Workflow 标签。根因是页面级的加载队列被一次没结束的加载堵死。这里的按钮绕过开发者控制台直接修复。": "An intermittent ComfyUI frontend issue: clicking a tab does not load its graph, × does not close it, or a stray Unsaved Workflow tab appears. The root cause is a page-level load queue blocked by one never-finishing load. These buttons fix it without the developer console.",
  "当前 {0} 个标签，其中 {1} 个是临时工作流（Unsaved Workflow）": "{0} tab(s) open, {1} of them are temporary workflows (Unsaved Workflow)",
  "未连接到 ComfyUI 前端，暂时无法读取标签状态。": "Not connected to the ComfyUI frontend; tab state is unavailable.",
  "关闭残留临时标签": "Close leftover temporary tabs",
  "没有残留的临时标签": "No leftover temporary tabs",
  "关闭临时标签": "Close temporary tabs",
  "将关闭 {0} 个临时工作流标签（Unsaved Workflow）。它们没有对应的磁盘文件，关闭后其中未保存的内容无法找回。": "{0} temporary workflow tab(s) (Unsaved Workflow) will be closed. They have no file on disk, so unsaved content in them cannot be recovered.",
  "已关闭 {0} 个临时标签": "Closed {0} temporary tab(s)",
  "关闭失败：": "Close failed: ",
  "只重新加载页面": "Reload page only",
  "正在重新加载…": "Reloading…",
  "清理草稿并重新加载": "Clear drafts and reload",
  "会先临时关掉草稿自动保存，再重新加载页面：标签栏里的残留和卡住的加载队列都会被清掉，刷新后自动把草稿开关打开回来。注意：所有标签里未保存的改动都会丢失，请先保存要保留的工作流。": "Draft autosave is temporarily disabled, then the page reloads: leftover tabs and the blocked load queue are both cleared, and draft autosave is switched back on after the reload. Note: unsaved changes in every tab will be lost — save the workflows you want to keep first.",
  "清理并重新加载": "Clear and reload",
  "标签 × 没生效，已强制关闭「{0}」（未保存的改动已丢弃）": "The tab's × did not work, so \"{0}\" was force-closed (unsaved changes discarded)"
}
};

/* ------------------------------------------------------------------ 网络 */

async function apiGet(path, params) {
  const search = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
    }
  }
  const qs = search.toString();
  const res = await api.fetchApi(`${API_BASE}${path}${qs ? "?" + qs : ""}`, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || T("请求失败 ({0})", res.status));
  }
  return json;
}

async function apiPost(path, body) {
  const res = await api.fetchApi(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || T("请求失败 ({0})", res.status));
  }
  return json;
}

/* ------------------------------------------------------------------ 缓存 */

const Store = {
  _list: null,
  _config: null,

  async list(force = false) {
    if (force || !this._list) {
      const res = await apiGet("/list", force ? { force: 1 } : null);
      // 每条都与 META_CACHE 合并（mergeMeta 只前进不后退）：
      // 「刚刷新查到信息」之后若 /list 重扫返回缺信息的旧条目，也不会把黄标打回原形。
      const items = (res.data || []).map((it) => {
        const merged = mergeMeta(META_CACHE.get(it.lora), it);
        META_CACHE.set(it.lora, merged);
        return merged;
      });
      this._list = {
        items,
        folders: res.folders || [],
        total: res.total || 0,
        loras_dirs: res.loras_dirs || [],
      };
    }
    return this._list;
  },

  async config(force = false) {
    if (force || !this._config) {
      const res = await apiGet("/config");
      this._config = res.data || {};
    }
    return this._config;
  },

  async detail(name, deep = false) {
    const res = await apiGet("/detail", { name, deep: deep ? 1 : 0 });
    return res.data || {};
  },

  async refresh(name) {
    const res = await apiPost("/refresh", { name });
    this._list = null;
    return res.data || {};
  },

  async refreshBatch(names, onlyMissing = false) {
    const res = await apiPost("/refresh_batch", { names: names || [], only_missing: Boolean(onlyMissing) });
    this._list = null;
    return res.data || res || {};
  },

  /* ------------------------------------------------ 清理 / 定位 / 本地删除 */

  /** 扫描清理候选（孤立图片 / 侧车 / 下载残留…）。 */
  async cleanupScan(withItems = true) {
    const res = await apiPost("/cleanup_scan", { with_items: Boolean(withItems) });
    return res.data || {};
  },

  /** 执行清理。默认移到隔离区（可还原），permanent=true 才彻底删除。 */
  async cleanupRun(categories, { permanent = false, dryRun = false } = {}) {
    const res = await apiPost("/cleanup", {
      categories: categories || [],
      permanent: Boolean(permanent),
      dry_run: Boolean(dryRun),
    });
    this._list = null;
    return res.data || {};
  },

  /** 隔离区批次列表。 */
  async cleanupTrash() {
    const res = await apiGet("/cleanup_trash");
    return res.data || [];
  },

  /** 还原某个隔离批次。 */
  async cleanupRestore(stamp) {
    const res = await apiPost("/cleanup_restore", { stamp });
    this._list = null;
    return res.data || {};
  },

  /**
   * 彻底删除隔离区文件（不可还原）。
   * @param {string|null} stamp 批次号；配合 { all:true } 时忽略，删全部批次。
   * @param {{all?: boolean}} [opts]
   */
  async trashDelete(stamp, { all = false } = {}) {
    const res = await apiPost("/trash_delete", { stamp, all: Boolean(all) });
    this._list = null;
    return res.data || {};
  },

  /** 某 lora 的完整本地文件清单（本体 + 预览图 + 侧车）。 */
  async bundle(name) {
    const res = await apiGet("/bundle", { name });
    return res.data || null;
  },

  /** 在文件管理器中定位。mode: "select" 选中文件，"folder" 只开目录。 */
  async reveal(name, mode = "select") {
    const res = await apiPost("/reveal", { name, mode });
    return res.data || {};
  },

  /** 本地删除 lora 及其图片/信息文件。默认进隔离区可还原。 */
  async deleteLocal(name, { includeBody = true, permanent = false } = {}) {
    const res = await apiPost("/delete_local", {
      name,
      include_body: Boolean(includeBody),
      permanent: Boolean(permanent),
    });
    this._list = null;
    return res.data || {};
  },

  invalidate() {
    this._list = null;
  },

  /* ------------------------------------------ 用户自定义数据（标签 / 说明 / 封面） */
  /* 与 C 站数据严格分离，存在 <base>.cft-user.json；刷新 C 站只写 .civitai.info， */
  /* 绝不覆盖这些内容。返回值为完整用户数据，读写的都过 applyUserMetaToCache。 */

  /** 读某 lora 的自定义标签 / 说明 / 封面。 */
  async userMeta(name) {
    const res = await apiGet("/user_meta", { name });
    const data = res.data || {};
    applyUserMetaToCache(name, data);
    return data;
  },

  /**
   * 写自定义标签 / 说明 / 收藏（部分更新）。
   * favorite 传 undefined 时 JSON.stringify 会把它从 body 里省掉，后端按「不改」处理。
   */
  async setUserMeta(name, tags, note, favorite) {
    const res = await apiPost("/user_meta", { name, tags, note, favorite });
    this._list = null;
    const data = res.data || {};
    applyUserMetaToCache(name, data);
    return data;
  },

  /** 全部自定义标签（去重 + 排序）。 */
  async userTags() {
    const res = await apiGet("/user_tags");
    return res.data || [];
  },

  /** 设封面。图片建议 download:true（下载到 <base>.preview.png，缩略图自动跟着换）， */
  /** 视频必须 download:false（只记链接，播放走 /image 代理）。 */
  async setCover(name, url, { type = "image", download = false } = {}) {
    const res = await apiPost("/set_cover", { name, url, type, download: Boolean(download) });
    this._list = null;
    const data = res.data || {};
    applyUserMetaToCache(name, data);
    return data;
  },

  /** 清除自定义封面：还原备份预览图并清 cover。 */
  async clearCover(name) {
    const res = await apiPost("/clear_cover", { name });
    this._list = null;
    const data = res.data || {};
    applyUserMetaToCache(name, data);
    return data;
  },
};

/* ------------------------------------------------------------------ 小工具 */

function h(tag, props, children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (children) {
    for (const c of [].concat(children)) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
  }
  return node;
}

function fmtCount(n) {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
  if (v >= 1000) return (v / 1000).toFixed(1) + "k";
  return String(v);
}

/** 当前视口尺寸（带兜底，供几何夹紧使用）。 */
function viewportSize() {
  const w = window.innerWidth || document.documentElement?.clientWidth || 1024;
  const hgt = window.innerHeight || document.documentElement?.clientHeight || 768;
  return { width: w, height: hgt };
}

/**
 * 图片占位符：C 站图片域名在部分网络环境下不可达（image.civitai.com 走不通），
 * 加载失败时用内联 SVG 兜底，避免出现破图图标。
 */
const PLACEHOLDER_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">' +
      '<rect width="240" height="240" fill="#1d1930"/>' +
      '<text x="120" y="118" font-size="13" fill="#7d759a" text-anchor="middle" ' +
      T('font-family="sans-serif">无预览图</text>') +
      '<text x="120" y="138" font-size="11" fill="#5d5678" text-anchor="middle" ' +
      T('font-family="sans-serif">(C 站图片网络受限)</text>') +
      "</svg>"
  );

/** 给图片挂上失败兜底，只触发一次。 */
function guardImage(img, opts = {}) {
  img.addEventListener("error", () => {
    if (img.dataset.cftFallback) return;
    img.dataset.cftFallback = "1";
    img.classList.add("cft-img-fail");
    if (opts.then) {
      opts.then(img);
      return;
    }
    img.src = PLACEHOLDER_IMG;
  });
  return img;
}

/**
 * 视频加载失败时的可见提示块。
 *
 * 用户报障「视频不能播放」时，原来只会看到一个纯黑的空框，完全不知道是
 * 网络 / 代理不通还是上游不支持 Range。这里给一句可执行的话兜底。
 */
function mediaErrorBlock() {
  return h("div", { class: "cft-media-error" }, [
    h("div", { class: "cft-media-error-icon", text: "⚠" }),
    h("div", {
      class: "cft-media-error-text",
      text: T("视频加载失败，可能是网络/代理不通或上游不支持 Range；可点「在 C 站打开 ↗」看原片"),
    }),
  ]);
}

/**
 * 给 <video> 挂失败兜底，避免留一个黑色空框。
 *
 *  · thumb=true（列表 / 堆 / 节点面板缩略图）：直接退化成占位图 —— 否则整排
 *    卡片都会变成黑框；
 *  · thumb=false（详情窗主舞台 / 画廊）：在元素位置渲染 .cft-media-error 提示块。
 *
 * 注意：空 src 不算失败（QA7 护栏要求不产出空 <video src="">）。
 */
function guardVideo(el, { thumb = false } = {}) {
  el.addEventListener("error", () => {
    if (!el.getAttribute("src")) return;
    if (thumb) {
      const img = h("img", { class: el.className, src: PLACEHOLDER_IMG, loading: "lazy" });
      el.replaceWith(img);
      return;
    }
    const host = el.parentElement;
    if (!host) return;
    if (host.querySelector(".cft-media-error")) return;
    el.style.display = "none";
    host.appendChild(mediaErrorBlock());
  });
  return el;
}

/**
 * 本地预览图优先；没有本地图时才退回 C 站远程图（经后端代理）。
 *
 * 预览图 URL 必须带 `&v=<preview_mtime>` 版本号：后端 /preview 会返回
 * `Cache-Control: max-age=3600`，换了封面后浏览器仍拿缓存里的老图（用户报障「设置
 * 封面后封面没换」）。加版本号 = 换 URL，能立刻穿透已缓存的那份；即使 mtime 缺失 /
 * 为 0 也要带上（`?name=X` 与 `?name=X&v=0` 是两个不同 URL）。
 */
function previewUrl(item) {
  if (!item) return "";
  const key = item.lora || item.name || "";
  const q = encodeURIComponent(key);
  const v = item.preview_mtime || 0;
  if (item.preview) return `${API_BASE}/preview?name=${q}&v=${v}`;
  const remote = (item.remote_images || [])[0]?.url;
  if (remote) return `${API_BASE}/image?url=${encodeURIComponent(remote)}`;
  return `${API_BASE}/preview?name=${q}&v=${v}`;
}

/** C 站远程图 → 后端代理 URL（前端可直接用作 img.src）。 */
function remoteImageUrl(url) {
  return `${API_BASE}/image?url=${encodeURIComponent(url)}`;
}

/**
 * 判断两条 lora 是否「在界面上看起来是同一个」：优先按 C 站 model+version，
 * 没有 C 站信息时退回按 display_name 小写比对。
 *
 * 真实案例：用户本地真有 `Anima/bin主任v2-step00009000.safetensors` 与
 * `Anima/bin仪馆主任 style.safetensors` 两个不同文件，但两者 C 站
 * model_id/version_id 完全相同（2897696/3359372），display_name 又都取 C 站 model 名，
 * 于是用户以为「同一个 lora 出现了两次」。这里给出稳定分组键，让前端能标出副本并
 * 用**文件名词干**把它们区分开。
 *
 * @returns {string|null} 分组键；两边都空时返回 null（不进索引）
 */
function dupKeyOf(item) {
  if (!item) return null;
  const mid = item.model_id || "";
  const vid = item.version_id || "";
  if (mid || vid) return `mv:${mid}/${vid}`;
  const n = String(item.display_name || item.name || "").trim().toLowerCase();
  return n ? `n:${n}` : null;
}

/**
 * 把列表按 dupKeyOf 分组，只保留 length > 1 的组。
 * @returns {Map<string, Array<item>>}
 */
function buildDupIndex(items) {
  const buckets = new Map();
  for (const it of items || []) {
    const key = dupKeyOf(it);
    if (!key) continue;
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }
  const out = new Map();
  for (const [key, arr] of buckets) {
    if (arr.length > 1) out.set(key, arr);
  }
  return out;
}

/**
 * 决定某条 lora 用什么当封面媒体。
 *
 * 视频封面出现的前提：① 用户显式设了视频封面（cover_type === "video"）；或
 * ② 本来读不到封面（!item.preview）而 C 站信息页首图就是视频 ——
 * 这正是用户报的「读取不到封面，C 站信息页只有视频」。
 *
 * @returns {{kind: "video"|"image", src: string}}
 */
function coverMedia(item) {
  const u = encodeURIComponent;
  if (item?.cover_type === "video" && item.cover_url) {
    return { kind: "video", src: `${API_BASE}/image?url=${u(item.cover_url)}` };
  }
  const first = (item?.remote_images || [])[0];
  if (!item?.preview && first?.url && String(first.type || "").toLowerCase() === "video") {
    return { kind: "video", src: `${API_BASE}/image?url=${u(first.url)}` };
  }
  return { kind: "image", src: previewUrl(item) };
}

/**
 * 缩略图工厂：需要视频时返回自动静音循环播放的 <video>，否则返回 guardImage 包好的 <img>。
 *
 * 视频用 preload="metadata" 且**不加 controls** —— 列表里动辄 300+ 张卡片，
 * 只有真正「读不到封面」的那些才会走视频分支。
 * 注意：h() 对 muted/loop 这类布尔属性走 setAttribute(k, "") 分支，
 * 而 video.muted 属性对 HTML 属性不敏感，必须在建好节点后显式 el.muted = true，
 * 否则 autoplay 会被浏览器以「非静音」为由拒绝起播。
 */
function makeThumb(item, className, props = {}) {
  const m = coverMedia(item);
  if (m.kind === "video") {
    const vid = h("video", {
      class: className + " cft-thumb-video",
      src: m.src,
      muted: true,
      loop: true,
      autoplay: true,
      playsinline: true,
      preload: "metadata",
      title: props.title || T("视频封面（点击查看详情）"),
      ...props,
    });
    // 关键：布尔属性在 DOM 上不等于 property，autoplay 静音起播依赖 property
    vid.muted = true;
    vid.defaultMuted = true;
    // 失败退化成占位图：整排卡片缩略图不能变成黑框
    return guardVideo(vid, { thumb: true });
  }
  return guardImage(h("img", { class: className, src: m.src, loading: "lazy", ...props }));
}

/**
 * 解析权重值：不做任何上下限钳制（用户可自由输入 -3~3 以外的值）。
 * 只在「空 / 非法 / NaN」时回退到调用方传入的默认值，
 * 合法的 0、负数、小数、超过 3 的大值都原样保留。
 */
function parseWeight(v, fallback = 1) {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 序列化权重：保持 Number.isFinite 语义，非法值回退到 fallback（默认 0）。 */
function finiteOr(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 视口夹紧：把窗口几何限制在可视范围内。
 * 保证 left>=0 / top>=0，且右 / 下边不越界；尺寸不小于 MIN 且不超过视口 - 16。
 */
function clampGeom(geom, viewport) {
  const vw = Math.max(0, Number(viewport?.width) || 0);
  const vh = Math.max(0, Number(viewport?.height) || 0);

  let width = finiteOr(geom?.width, MIN_WIN_W);
  let height = finiteOr(geom?.height, MIN_WIN_H);
  width = Math.max(MIN_WIN_W, Math.min(width, Math.max(MIN_WIN_W, vw - 16)));
  height = Math.max(MIN_WIN_H, Math.min(height, Math.max(MIN_WIN_H, vh - 16)));

  const maxLeft = Math.max(0, vw - width);
  const maxTop = Math.max(0, vh - height);
  let left = finiteOr(geom?.left, 24);
  let top = finiteOr(geom?.top, 56);
  left = Math.max(0, Math.min(left, maxLeft));
  top = Math.max(0, Math.min(top, maxTop));

  return { left, top, width, height, minimized: Boolean(geom?.minimized) };
}

/** 归一化视图模式：非 "list" 一律当作 "grid"。 */
function parseViewMode(v) {
  return v === "list" ? "list" : "grid";
}

/** 归一化卡片尺寸：夹到 [CARD_SIZE_MIN, CARD_SIZE_MAX]，非法值回退默认。 */
function parseCardSize(v) {
  const n = Math.round(finiteOr(v, CARD_SIZE_DEFAULT));
  return Math.max(CARD_SIZE_MIN, Math.min(CARD_SIZE_MAX, n));
}

/**
 * 是否「有作者/标签/触发词这类细节」——用来判断一次按哈希的在线查询**值不值得做**。
 */
function hasCivitaiDetail(m) {
  return !!m && !!(m.creator || (m.tags && m.tags.length) || (m.trained_words && m.trained_words.length));
}

/**
 * 判定一份元数据是否「缺 C 站信息」（决定要不要挂「无C站信息」黄标）。
 *
 * 注意：不能只看 creator / tags / trained_words 三项。实际数据里存在
 * `.civitai.info` **已存在但字段不全**的 lora（后端 source === "civitai"，
 * 带基座模型 / 下载量 / 预览图，却没有 creator/tags），早先只用那三项判定，
 * 会把「明明已经获取到 C 站信息」的 lora 误标成「无C站信息」，怎么刷新都没用。
 *
 * 以「来源是否为 C 站侧车」为准；不用 has_meta 兜底，因为后端
 * has_meta = bool(civitai or training)，只有 safetensors 头部的 lora 也是 true，
 * 而那种确实**没有** C 站信息，应该继续挂黄标。
 */
function isMissingMeta(m) {
  if (!m) return true;
  if (m.source === "civitai") return false;
  return !hasCivitaiDetail(m);
}

/**
 * 是否「值得发起一次 C 站在线查询」——批量查询的筛选依据。
 * 与黄标判据**有意不同**：侧车存在但缺作者的 lora 不该挂黄标，
 * 但按哈希查一次仍可能补上作者，所以批量名单里保留它。
 */
function needsCivitaiLookup(m) {
  return !hasCivitaiDetail(m);
}

/**
 * 合并两份元数据，**只前进不后退**。
 *
 * 为什么需要：刚「从 C 站刷新」查到信息写进缓存后，紧接着的一次 /list 重扫
 * 可能因为后端扫描缓存 / sidecar 写入时序而返回**缺信息**的旧条目，
 * 若直接覆盖，刚查到的作者又没了 —— 表现就是「点了刷新，黄标还在」。
 * 规则：新数据有信息就用新的；新数据缺信息但缓存里有，就把缓存字段补回去。
 */
function mergeMeta(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  // 判据用「细节是否齐全」而不是 isMissingMeta：has_meta/source 只说明侧车在不在，
  // 不能因此就放弃把 prev 的作者/标签补进 next。
  if (hasCivitaiDetail(next) || !hasCivitaiDetail(prev)) return next;
  const arr = (a, b) => (Array.isArray(a) && a.length ? a : Array.isArray(b) ? b : []);
  return {
    ...prev,
    ...next,
    creator: next.creator || prev.creator || "",
    tags: arr(next.tags, prev.tags),
    trained_words: arr(next.trained_words, prev.trained_words),
    base_model: next.base_model || prev.base_model || "",
    version_name: next.version_name || prev.version_name || "",
    url: next.url || prev.url || "",
    downloads: next.downloads ?? prev.downloads,
    remote_images: arr(next.remote_images, prev.remote_images),
  };
}

/**
 * 把 /user_meta 或 /set_cover / /clear_cover 的返回值写回 META_CACHE，
 * 让界面无需等 /list 重扫就能看到自定义标签 / 说明 / 封面 / 收藏变化。
 *
 * 只覆盖用户自定义那 6 个字段，其余（C 站作者/标签/缩略图…）保持不变。
 * `favorite` 与后端 write() 同口径：响应缺该键视为「未提及」，保留缓存原值。
 */
function applyUserMetaToCache(name, ud) {
  if (!name || !ud) return;
  const prev = META_CACHE.get(name) || { lora: name };
  const cov = ud.cover || {};
  META_CACHE.set(name, {
    ...prev,
    user_tags: ud.tags || [],
    user_note: ud.note || "",
    has_user: Boolean(ud.exists) || Boolean((ud.tags || []).length || ud.note),
    cover_url: cov.url || "",
    cover_type: cov.type || "",
    // favorite 部分更新语义：响应里**缺**这个键（旧后端 / 半新版本）时保持缓存里的
    // 原值，不能把「没返回」误当成「显式取消收藏」把已收藏静默打回 false。
    // 只有显式给了布尔值才覆盖。
    favorite: ud.favorite === undefined ? Boolean(prev.favorite) : Boolean(ud.favorite),
  });
}

/**
 * 把 /refresh 响应里的 C 站原始 JSON 归一化成「列表项同构」的 meta。
 *
 * 用它让黄标消失**不必等 /list 重扫**——查到即写缓存，当场生效。
 * 同时兼容两种形状：Civitai API 的扁平响应（creator/baseModel/trainedWords）
 * 与 C 站 sidecar 格式（嵌套 version）。
 */
function metaFromCivitai(info, base) {
  if (!info || typeof info !== "object") return null;
  const civ = info.civitai && typeof info.civitai === "object" ? info.civitai : info;
  const ver = civ.version && typeof civ.version === "object" ? civ.version : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = civ[k] !== undefined && civ[k] !== null && civ[k] !== "" ? civ[k] : ver[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return "";
  };
  const arrOf = (v) => (Array.isArray(v) ? v : []);
  const words = arrOf(pick("trainedWords", "trained_words"));
  const tags = arrOf(pick("tags"));
  const creator = String(pick("creator", "username"));
  if (!hasCivitaiDetail({ creator, tags, trained_words: words })) return null;

  const modelId = pick("modelId", "model_id", "id");
  const images = arrOf(pick("images"))
    .filter((im) => im && im.url)
    .slice(0, 12);
  return {
    lora: base?.lora || "",
    name: String(pick("name")) || base?.name || "",
    display_name: String(pick("name")) || base?.display_name || "",
    creator,
    tags,
    trained_words: words,
    base_model: String(pick("baseModel", "base_model")),
    version_name: String(pick("versionName", "version_name", "name")),
    url: modelId ? `https://civitai.com/models/${modelId}` : String(pick("url")),
    downloads: civ.stats?.downloadCount ?? base?.downloads,
    remote_images: images,
    nsfw: civ.nsfw ?? base?.nsfw,
    // 标记来源：让 isMissingMeta 认出「这份确实来自 C 站」
    source: "civitai",
    has_meta: true,
  };
}

function normalizeEntry(raw) {
  // v2.13 QA 加固：备份 / 工作流 JSON 里可能夹着 null、空值或非对象项
  // （手改工作流、第三方脚本往 lora_stack 里注入、脏 localStorage 等）。
  // 这里必须先挡掉，否则下一行 raw.lora 直接抛 TypeError —— readStack /
  // readStackBackup / 恢复链路都没有兜底 try，一个脏条目就能把节点初始化
  // 整条打断（节点面板渲染不出来、看起来像插件坏了）。
  if (!raw || typeof raw !== "object") return null;
  const lora = String(raw.lora || raw.path || raw.file || "").replace(/\\/g, "/");
  if (!lora) return null;
  return {
    lora,
    name: raw.name || lora.split("/").pop().replace(/\.(safetensors|ckpt|pt|bin)$/i, ""),
    display_name: raw.display_name || raw.name || lora.split("/").pop(),
    weight: raw.weight === undefined ? 1 : parseWeight(raw.weight, 1),
    text_encoder_weight: raw.text_encoder_weight === undefined
      ? (raw.clip_weight === undefined ? 1 : parseWeight(raw.clip_weight, 1))
      : parseWeight(raw.text_encoder_weight, 1),
    trigger_weight: raw.trigger_weight === undefined ? 0 : parseWeight(raw.trigger_weight, 0),
    hidden: Boolean(raw.hidden),
    // 展示用缓存（不写回 widget）
    _meta: raw._meta || null,
    _preview: raw._preview || "",
  };
}

function serializeEntry(e) {
  return {
    lora: e.lora,
    name: e.name,
    weight: finiteOr(e.weight, 0),
    text_encoder_weight: finiteOr(e.text_encoder_weight, 0),
    trigger_weight: finiteOr(e.trigger_weight, 0),
    hidden: Boolean(e.hidden),
  };
}

/* ------------------------------------------------------------ 节点数据层 */

const NODE_STATE = new WeakMap();

/**
 * 元数据缓存（跨渲染持久，key = lora 名）。
 *
 * 为什么需要它：`readStack()` 每次都从 widget 的 JSON 字符串重新 parse 出**全新对象**，
 * 所以「给 entry._meta 赋值」在下一次 readStack/render 时就丢了——
 * 节点内嵌面板因此一直显示不出作者/基座/缩略图，堆窗口里
 * 「从 C 站查到信息后黄标不消失」也是同一个根因。
 * 统一以 lora 名为 key 存这里，readStack 时再贴回 entry._meta。
 */
const META_CACHE = new Map();

function stackWidget(node) {
  return node?.widgets?.find((w) => w.name === "lora_stack");
}

function readStack(node) {
  const w = stackWidget(node);
  if (!w || typeof w.value !== "string" || !w.value.trim()) return [];
  try {
    const parsed = JSON.parse(w.value);
    const arr = Array.isArray(parsed) ? parsed : parsed?.loras || [];
    const out = [];
    for (const raw of arr) {
      const e = normalizeEntry(raw);
      if (!e) continue;
      const cached = META_CACHE.get(e.lora);
      if (cached) e._meta = cached;
      else if (raw && raw._meta) META_CACHE.set(e.lora, raw._meta);
      out.push(e);
    }
    return out;
  } catch {
    return [];
  }
}

function writeStack(node, entries) {
  const w = stackWidget(node);
  if (!w) return;
  w.value = JSON.stringify(entries.map(serializeEntry));
  node.setDirtyCanvas?.(true, true);
  const state = NODE_STATE.get(node);
  if (state) {
    state.entries = entries;
    // 用户一动手就撤掉「已从备份恢复」横幅（见 renderNodePanel）
    state.restoredN = 0;
  }
  markGraphChanged(node);
  backupStack(node, entries);
}

/**
 * 让 ComfyUI 感知「工作流内容变了」。
 *
 * v2.13：LoRA 堆的数据只存在 lora_stack 这个 widget 的 value 里，而**只改
 * widget 值并不会让 ComfyUI 认为工作流变了** —— 结果就是草稿不刷新，
 * 重启后恢复的是上一次（堆还是空的）快照，看起来像"堆丢了"。
 *
 * ⚠️ 别写成只调 `graph.change()`：前端 1.49 的 `LGraph.change()` 实现是
 * `canvasAction(c => c.setDirty(true,true))` + `on_change?.()`，而全前端
 * bundle 里**从未给 on_change 赋值**，所以它实际只做了一次重绘（QA 在
 * litegraph 的 LGraph.ts sourcemap 里实证）。真正让草稿落盘的是 api 上的
 * `graphChanged` 事件 —— `useWorkflowPersistenceV2.ts` 里
 * `api.addEventListener('graphChanged', debouncedPersist)`，其
 * `persistCurrentWorkflow()` 读的是 `rootGraph.serialize()` 的实时结果。
 */
function markGraphChanged(node) {
  try {
    const g = node?.graph || app?.graph;
    // 1) LiteGraph 侧：对 1.49 等于只重绘，但别的宿主可能挂了 on_change，留着
    if (g && typeof g.change === "function") g.change();
    // 2) 真正有效的那一下：让草稿 / 自动保存立刻跟上
    //
    //    ⚠️ 只对「未保存过的工作流」真的有用：persistCurrentWorkflow() 写完
    //    草稿后紧跟一句 `!isTemporary && !isModified → removeDraft(...)`，
    //    已存盘且未被标脏的工作流会把刚写的草稿同帧删掉（QA 实证）。
    //    那种情况下救回数据的是本机备份，不是草稿——别对前者过度承诺。
    //
    //    payload 单独 try：实参会先求值，serialize() 一抛整个事件就发不出去
    //    （QA 实证）；三个监听方其实都不读 payload，所以降级成 null 也安全。
    const api = app?.api;
    if (api && typeof api.dispatchCustomEvent === "function") {
      let payload = null;
      try {
        if (app?.rootGraph) payload = app.rootGraph.serialize();
      } catch {
        payload = null;
      }
      api.dispatchCustomEvent("graphChanged", payload);
    } else if (api && typeof api.dispatchEvent === "function") {
      api.dispatchEvent(new CustomEvent("graphChanged"));
    }
  } catch {
    /* 静默：拿不到图 / api 就退回只重绘，不影响主流程 */
  }
}

/* ------------------------------------------------ 堆数据本机备份（v2.13） */

const STACK_BAK_PREFIX = "stackbak.";
const STACK_BAK_KEEP = 30;

function stackBakKey(node) {
  return STACK_BAK_PREFIX + String(node?.id ?? 0);
}

/**
 * 把堆数据额外写一份到 localStorage。
 * 目的：堆不再"只能靠保存工作流"才留得住 —— 工作流没保存 / 草稿没刷新
 * 时，重启后还能从这里找回来。
 * 堆被清空 = 删备份，否则清空后一重启又被填回来。
 */
function backupStack(node, entries) {
  const key = stackBakKey(node);
  try {
    if (!entries || !entries.length) {
      localStorage.removeItem(LS_PREFIX + key);
      // 顺手把 key 从索引里摘掉：留着会占 LRU 槽位，
      // 极端情况下把还有用的备份提前挤掉（QA 实测）
      LS.setJSON("stackbak.index", (LS.getJSON("stackbak.index", []) || []).filter((k) => k !== key));
      return;
    }
    LS.setJSON(key, { ts: Date.now(), entries: entries.map(serializeEntry) });
    const idx = (LS.getJSON("stackbak.index", []) || []).filter((k) => k !== key);
    idx.push(key);
    while (idx.length > STACK_BAK_KEEP) {
      localStorage.removeItem(LS_PREFIX + idx.shift());
    }
    LS.setJSON("stackbak.index", idx);
  } catch {
    /* 静默降级：隐私模式 / 存储被禁用时不影响使用 */
  }
}

/** 读本机备份（已归一化，可直接当 entries 用）。 */
function readStackBackup(node) {
  const raw = LS.getJSON(stackBakKey(node), null);
  if (!raw || !Array.isArray(raw.entries)) return [];
  const out = [];
  for (const r of raw.entries) {
    const e = normalizeEntry(r);
    if (!e) continue;
    if (r && r._meta) {
      e._meta = r._meta;
      META_CACHE.set(e.lora, r._meta);
    }
    out.push(e);
  }
  return out;
}

/**
 * 重启 / 重载工作流后：widget 里的堆是空的，本机备份里有 → 回填。
 * 只补「widget 空 + 备份有」这一个缺口，正常情况下绝不覆盖真实数据。
 * @returns {number} 恢复了几条（0 = 没恢复）
 */
function restoreStackFromBackup(node) {
  if (readStack(node).length) return 0;
  const bak = readStackBackup(node);
  if (!bak.length) return 0;
  writeStack(node, bak);
  const state = NODE_STATE.get(node);
  if (state) state.restoredN = bak.length;
  return bak.length;
}

/**
 * 全局 toast（节点级提示用；弹窗内的提示仍走 BaseModal#toast）。
 * 走一个 fixed 容器纵向堆叠 —— 多条同时出现时不会互相盖住，
 * 位置也抬到底部工具栏之上（右下角那条缩放/适配工具栏是 z-1200）。
 */
function globalToast(msg, isError = false) {
  try {
    let host = document.getElementById("cft-toast-host");
    if (!host) {
      host = h("div", { id: "cft-toast-host", class: "cft-toast-host" });
      document.body.appendChild(host);
    }
    const t = h("div", { class: `cft-toast-global${isError ? " cft-toast-err" : ""}`, text: msg });
    host.appendChild(t);
    setTimeout(() => t.classList.add("cft-toast-show"), 10);
    setTimeout(() => {
      t.classList.remove("cft-toast-show");
      setTimeout(() => t.remove(), 300);
    }, 4200);
  } catch {
    /* 静默 */
  }
}

function getState(node) {
  let state = NODE_STATE.get(node);
  if (!state) {
    state = {
      node,
      entries: [],
      panelEl: null,
      domWidget: null,
      dirtyRender: null,
    };
    NODE_STATE.set(node, state);
  }
  return state;
}

/* --------------------------------------------------------- Lightbox 大图 */

/**
 * 全屏看图器（单例，惰性创建）。
 * - 滚轮以光标为锚点缩放，范围 1x ~ 6x
 * - 缩放 > 1x 时可拖拽平移并夹紧边界
 * - 多图时显示 ‹ › 与计数，支持 ←/→
 * - Esc / ✕ / 点图片外背景关闭；打开期间只关大图（不影响底层弹窗）
 */
const Lightbox = {
  _root: null,
  _stage: null,
  _box: null,
  _img: null,
  _counter: null,
  _prevBtn: null,
  _nextBtn: null,
  _images: [],
  _index: 0,
  _scale: 1,
  _tx: 0,
  _ty: 0,
  _baseW: 1,
  _baseH: 1,
  _onKeyBound: null,
  _suppressClick: false,

  isOpen() {
    return Boolean(this._root && this._root.classList.contains("cft-lb-open"));
  },

  _build() {
    if (this._root) return;

    this._counter = h("span", { class: "cft-lb-counter", text: "" });
    this._prevBtn = h("button", { class: "cft-lb-nav cft-lb-prev", title: T("上一张 (←)"), text: "‹", onClick: () => this.step(-1) });
    this._nextBtn = h("button", { class: "cft-lb-nav cft-lb-next", title: T("下一张 (→)"), text: "›", onClick: () => this.step(1) });

    const closeBtn = h("button", { class: "cft-lb-btn cft-lb-close", title: T("关闭 (Esc)"), text: "✕", onClick: () => this.close() });
    const zoomIn = h("button", { class: "cft-lb-btn", title: T("放大 (+) "), text: T("＋"), onClick: () => this.zoomBy(1.25) });
    const zoomOut = h("button", { class: "cft-lb-btn", title: T("缩小 (-)"), text: T("－"), onClick: () => this.zoomBy(1 / 1.25) });
    const oneToOne = h("button", { class: "cft-lb-btn", title: T("原始尺寸 1:1"), text: "1:1", onClick: () => this.actualSize() });
    const fitBtn = h("button", { class: "cft-lb-btn", title: T("适应窗口"), text: T("适应"), onClick: () => this.fit() });

    this._img = h("img", { class: "cft-lb-img", alt: "" });
    this._img.addEventListener("load", () => {
      this._measure();
      this._clampT();
      this._apply();
    });
    this._img.addEventListener("error", () => {
      if (this._img.src !== PLACEHOLDER_IMG) this._img.src = PLACEHOLDER_IMG;
    });
    this._img.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this._toggleFit();
    });

    this._box = h("div", { class: "cft-lb-imgbox" }, [this._img]);
    this._stage = h("div", { class: "cft-lb-stage" }, [this._box]);

    this._stage.addEventListener("pointerdown", (e) => this._onStageDown(e));

    const topbar = h("div", { class: "cft-lb-topbar" }, [
      h("span", { class: "cft-lb-spacer" }),
      this._counter,
      closeBtn,
    ]);

    const toolbar = h("div", { class: "cft-lb-toolbar" }, [zoomOut, oneToOne, fitBtn, zoomIn]);

    this._root = h("div", { class: "cft-lightbox" }, [
      topbar,
      this._prevBtn,
      this._stage,
      this._nextBtn,
      toolbar,
    ]);

    // 点「图片以外的背景」关闭（平移时不触发）
    this._root.addEventListener("click", (e) => {
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      if (e.target === this._root || e.target === this._stage || e.target === this._box) {
        this.close();
      }
    });

    this._root.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });

    document.body.appendChild(this._root);
  },

  open(images, index = 0) {
    this._build();
    this._images = (images || []).filter((im) => im && im.url);
    if (!this._images.length) return;
    this._index = Math.max(0, Math.min(index | 0, this._images.length - 1));
    LIGHTBOX_OPEN = true;
    this._root.classList.add("cft-lb-open");
    this._root.style.display = "flex";
    this._show();
    if (!this._onKeyBound) {
      this._onKeyBound = (e) => this._onKey(e);
      document.addEventListener("keydown", this._onKeyBound, true);
    }
  },

  close() {
    if (!this._root) return;
    this._root.classList.remove("cft-lb-open");
    this._root.style.display = "none";
    LIGHTBOX_OPEN = false;
    this._scale = 1;
    this._tx = 0;
    this._ty = 0;
    if (this._img) this._img.style.transform = "none";
    if (this._onKeyBound) {
      document.removeEventListener("keydown", this._onKeyBound, true);
      this._onKeyBound = null;
    }
  },

  step(delta) {
    if (this._images.length <= 1) return;
    this._index = (this._index + delta + this._images.length) % this._images.length;
    this._show();
  },

  _show() {
    const im = this._images[this._index];
    if (!im || !this._img) return;
    this._img.src = im.url;
    this._img.title = im.title || "";
    const multi = this._images.length > 1;
    this._counter.textContent = multi ? `${this._index + 1} / ${this._images.length}` : "";
    this._counter.style.display = multi ? "" : "none";
    this._prevBtn.style.display = multi ? "" : "none";
    this._nextBtn.style.display = multi ? "" : "none";
    this._scale = 1;
    this._tx = 0;
    this._ty = 0;
    this._apply();
    // 图片尺寸需等布局完成后再测
    setTimeout(() => {
      if (!this.isOpen()) return;
      this._measure();
      this._clampT();
      this._apply();
    }, 0);
  },

  _measure() {
    if (!this._img) return;
    const prev = this._img.style.transform;
    this._img.style.transform = "none";
    this._baseW = this._img.offsetWidth || 1;
    this._baseH = this._img.offsetHeight || 1;
    this._img.style.transform = prev;
  },

  _apply() {
    if (!this._img) return;
    this._img.style.transform = `translate(${this._tx}px, ${this._ty}px) scale(${this._scale})`;
  },

  _clampT() {
    if (!this._stage) return;
    const rect = this._stage.getBoundingClientRect();
    const dispW = (this._baseW || 1) * this._scale;
    const dispH = (this._baseH || 1) * this._scale;
    const maxX = Math.max(0, (dispW - rect.width) / 2);
    const maxY = Math.max(0, (dispH - rect.height) / 2);
    this._tx = Math.max(-maxX, Math.min(maxX, this._tx));
    this._ty = Math.max(-maxY, Math.min(maxY, this._ty));
  },

  fit() {
    this._scale = 1;
    this._tx = 0;
    this._ty = 0;
    this._apply();
  },

  actualSize() {
    const natural = this._img?.naturalWidth || this._baseW || 1;
    let s = natural / (this._baseW || 1);
    s = Math.max(1, Math.min(6, s));
    this._scale = s;
    this._clampT();
    this._apply();
  },

  _toggleFit() {
    if (Math.abs(this._scale - 1) < 0.01) this.actualSize();
    else this.fit();
  },

  zoomBy(factor) {
    const next = Math.max(1, Math.min(6, this._scale * factor));
    if (next === this._scale) return;
    this._scale = next;
    this._clampT();
    this._apply();
  },

  _onWheel(e) {
    e.preventDefault();
    if (!this._stage) return;
    const rect = this._stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ux = e.clientX - cx;
    const uy = e.clientY - cy;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(1, Math.min(6, this._scale * factor));
    if (next === this._scale) return;
    // 以光标位置为锚点缩放
    this._tx = ux - (ux - this._tx) * (next / this._scale);
    this._ty = uy - (uy - this._ty) * (next / this._scale);
    this._scale = next;
    this._clampT();
    this._apply();
  },

  _onStageDown(e) {
    if (this._scale <= 1) return;
    if (e.button !== undefined && e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const t0x = this._tx;
    const t0y = this._ty;
    this._stage.classList.add("cft-lb-grabbing");
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      this._tx = t0x + dx;
      this._ty = t0y + dy;
      this._clampT();
      this._apply();
    };
    const up = () => {
      this._stage.classList.remove("cft-lb-grabbing");
      if (moved) this._suppressClick = true;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    e.preventDefault();
  },

  _onKey(e) {
    if (!this.isOpen()) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowLeft") {
      this.step(-1);
    } else if (e.key === "ArrowRight") {
      this.step(1);
    } else if (e.key === "+" || e.key === "=") {
      this.zoomBy(1.25);
    } else if (e.key === "-") {
      this.zoomBy(1 / 1.25);
    }
  },
};

/* ------------------------------------------------------------- 弹窗基类 */

/** 单例注册表：singletonKey → Modal 实例。 */
const OPEN_MODALS = new Map();

/* ---------------------------------------------------------- 右键菜单 */

/**
 * 轻量右键菜单：全局单例，挂在 body 上。
 *
 * 为什么不用原生 contextmenu 事件 + 自绘：ComfyUI 画布本身也监听 contextmenu，
 * 这里在捕获阶段拦下并 preventDefault，避免画布弹出自己的菜单。
 *
 * 视口边缘会自动翻转（往上/往左开），否则贴着屏幕右边点会跑出可视区。
 */
class ContextMenu {
  static _inst = null;

  /**
   * @param {MouseEvent} ev 右键事件
   * @param {Array<{label:string,icon?:string,onClick?:Function,danger?:boolean,disabled?:boolean,sep?:boolean}>} items
   */
  static open(ev, items) {
    ContextMenu.close();
    const usable = (items || []).filter(Boolean);
    if (!usable.length) return null;

    const menu = h("div", { class: "cft-ctxmenu" });
    for (const it of usable) {
      if (it.sep) {
        menu.appendChild(h("div", { class: "cft-ctxmenu-sep" }));
        continue;
      }
      if (it.title) {
        menu.appendChild(h("div", { class: "cft-ctxmenu-title", text: it.title, title: it.title }));
        continue;
      }
      menu.appendChild(
        h("button", {
          class: `cft-ctxmenu-item${it.danger ? " cft-ctxmenu-danger" : ""}`,
          text: (it.icon ? it.icon + "  " : "") + (it.label || ""),
          title: it.hint || it.label || "",
          disabled: Boolean(it.disabled),
          onClick: () => {
            ContextMenu.close();
            try {
              it.onClick?.();
            } catch (err) {
              console.warn(T("[Civitai-LoRA-Rack] 右键菜单项执行失败"), err);
            }
          },
        })
      );
    }

    document.body.appendChild(menu);

    // 贴边翻转：先量尺寸，再决定往哪个方向摆
    const vp = viewportSize();
    const r = menu.getBoundingClientRect();
    const pad = 6;
    let left = ev.clientX;
    let top = ev.clientY;
    if (left + r.width + pad > vp.width) left = Math.max(pad, ev.clientX - r.width);
    if (top + r.height + pad > vp.height) top = Math.max(pad, ev.clientY - r.height);
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";

    const inst = new ContextMenu(menu);
    ContextMenu._inst = inst;
    return inst;
  }

  static close() {
    if (ContextMenu._inst) {
      ContextMenu._inst.destroy();
      ContextMenu._inst = null;
    }
  }

  static isOpen() {
    return Boolean(ContextMenu._inst);
  }

  constructor(menu) {
    this.menu = menu;
    this._onDown = (e) => {
      if (!this.menu.contains(e.target)) this.destroy();
    };
    this._onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.destroy();
      }
    };
    this._onCtx = (e) => {
      // 右键别处：换掉当前菜单，而不是叠加
      if (!this.menu.contains(e.target)) this.destroy();
    };
    // 用 capture 抢在画布之前；菜单本体已在 DOM 里，靠 contains 判断不误关
    document.addEventListener("pointerdown", this._onDown, true);
    document.addEventListener("contextmenu", this._onCtx, true);
    document.addEventListener("keydown", this._onKey, true);
    this._onScroll = () => this.destroy();
    window.addEventListener("resize", this._onScroll);
    window.addEventListener("wheel", this._onScroll, { passive: true });
  }

  destroy() {
    document.removeEventListener("pointerdown", this._onDown, true);
    document.removeEventListener("contextmenu", this._onCtx, true);
    document.removeEventListener("keydown", this._onKey, true);
    window.removeEventListener("resize", this._onScroll);
    window.removeEventListener("wheel", this._onScroll);
    this.menu.remove();
    if (ContextMenu._inst && ContextMenu._inst.menu === this.menu) ContextMenu._inst = null;
  }
}

/**
 * 给任意元素挂右键菜单。
 * @param {HTMLElement} el
 * @param {() => Array} getItems 每次右键时动态生成菜单项（保证禁用态是实时的）
 * @param {string} hint 鼠标悬停提示里追加的说明
 */
function bindContextMenu(el, getItems, hint) {
  if (!el) return;
  el.classList.add("cft-ctxable");
  if (hint) el.title = el.title ? el.title + "\n" + hint : hint;
  el.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    let items = [];
    try {
      items = getItems() || [];
    } catch (err) {
      console.warn(T("[Civitai-LoRA-Rack] 生成右键菜单失败"), err);
      return;
    }
    if (!items.length) return;
    ContextMenu.open(ev, items);
  });
}

/** 字节数格式化（B → KB → MB → GB）。 */
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

class Modal {
  constructor({
    title,
    width = 760,
    height = 620,
    className = "",
    floating = false,
    offset = 0,
    resizable = null,
    persistKey = "",
    singletonKey = "",
  } = {}) {
    this.width = width;
    this.height = height;
    this.floating = floating;
    this.offset = offset;
    // 浮动窗口默认允许调整大小
    this.resizable = resizable === null ? Boolean(floating) : Boolean(resizable);
    this.persistKey = persistKey || "";
    this.singletonKey = singletonKey || "";
    this.geom = null;

    this.body = h("div", { class: "cft-body" });
    this.footer = h("div", { class: "cft-footer" });
    this.headerExtra = h("div", { class: "cft-header-extra" });

    this.titleEl = h("span", { class: "cft-title", text: title || "" });

    const headerChildren = [this.titleEl, this.headerExtra];
    if (floating) {
      // 浮动模式下提供「最小化 / 展开」，收成一条标题栏，尽量不挡画布
      this.minBtn = h("button", {
        class: "cft-icon-btn cft-min-btn",
        title: T("最小化"),
        text: "—",
        onClick: (e) => {
          e.stopPropagation();
          this.toggleMinimize();
        },
      });
      headerChildren.push(this.minBtn);
    }
    headerChildren.push(
      h("button", { class: "cft-icon-btn cft-close", title: T("关闭"), text: "✕", onClick: () => this.close() })
    );

    this.header = h("div", { class: "cft-header" }, headerChildren);

    this.root = h("div", { class: `cft-modal${floating ? " cft-floating" : ""}${className ? " " + className : ""}` }, [
      this.header,
      this.body,
      this.footer,
    ]);

    this.mask = h("div", { class: `cft-mask${floating ? " cft-float-mask" : ""}` }, [this.root]);
    if (!floating) {
      // 普通（模态）模式下点遮罩空白处关闭；
      // 浮动模式遮罩 pointer-events:none，不接收事件也不拦截画布操作，因此跳过该分支。
      this.mask.addEventListener("mousedown", (e) => {
        if (e.target === this.mask) this.close();
      });
    }

    this._onKey = (e) => {
      if (e.key !== "Escape") return;
      // 大图（Lightbox）打开时，Esc 只由 Lightbox 处理，别把底层弹窗一起关掉
      if (LIGHTBOX_OPEN) return;
      this.close();
    };

    if (this.resizable) this._attachResizeHandles();
  }

  /* ---------------------------------------------------- 几何 / 持久化 */

  _defaultGeom() {
    const vp = viewportSize();
    const width = Math.min(this.width, Math.max(MIN_WIN_W, vp.width - 16));
    const height = Math.min(this.height, Math.max(MIN_WIN_H, vp.height - 80));
    // 默认靠右上角（沿用旧观感），offset 用于多个窗口错开
    const left = Math.max(0, vp.width - 24 - this.offset - width);
    const top = 56 + this.offset;
    return { left, top, width, height, minimized: false };
  }

  _loadGeom() {
    if (!this.persistKey) return null;
    const saved = LS.getJSON("geom:" + this.persistKey, null);
    if (!saved) return null;
    return clampGeom(saved, viewportSize());
  }

  /**
   * 把 left/top 写进 inline style。
   *
   * 只有【浮动】窗口才允许写 —— 它们的 CSS 是
   * `.cft-mask.cft-float-mask .cft-modal.cft-floating { position: fixed }`，
   * left/top 就是真正的绝对坐标。
   *
   * 【非浮动】窗口（askChoice / askConfirm / showInfoModal）的 CSS 是
   * `.cft-modal { position: relative }`，父级 `.cft-mask` 已经用
   * `display:flex; justify-content:center; padding-top:4vh` 做居中。
   * 此时再写 left/top 会被当成「相对偏移」叠加在居中位置之上 ——
   * 视口一宽，_defaultGeom() 算出的 `vp.width - 24 - offset - width`
   * 就把对话框整块推到屏幕右侧之外（1920 宽下 left≈1318px → rect.x≈1989），
   * 用户只看到变模糊的遮罩、点什么都没反应。所以非浮动窗口一律清空，
   * 居中交回 CSS。
   */
  _applyPos(r, geom) {
    if (this.floating) {
      r.left = geom.left + "px";
      r.top = geom.top + "px";
      r.right = "auto";
      r.transform = "none";
    } else {
      r.left = "";
      r.top = "";
      r.right = "";
      r.transform = "";
    }
  }

  _applyGeom(geom) {
    this.geom = geom;
    const r = this.root.style;
    this._applyPos(r, geom);
    r.width = geom.width + "px";
    r.maxHeight = "none";
    r.height = geom.minimized ? "auto" : geom.height + "px";
    this.root.classList.toggle("cft-minimized", Boolean(geom.minimized));
    this._syncMinBtn();
  }

  /** 仅更新尺寸 / 位置（resize 用，不动 minimized）。 */
  _applyGeomSize(geom) {
    this.geom = { ...(this.geom || {}), ...geom };
    const r = this.root.style;
    this._applyPos(r, geom);
    r.width = geom.width + "px";
    r.maxHeight = "none";
    r.height = geom.height + "px";
  }

  _currentGeom() {
    const rect = this.root.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(this.geom?.height || rect.height),
      minimized: this.root.classList.contains("cft-minimized"),
    };
  }

  _persistGeom() {
    if (!this.persistKey || !this.geom) return;
    LS.setJSON("geom:" + this.persistKey, this._currentGeom());
  }

  _syncMinBtn() {
    if (!this.minBtn) return;
    const min = this.root.classList.contains("cft-minimized");
    this.minBtn.textContent = min ? "▢" : "—";
    this.minBtn.setAttribute("title", min ? T("展开") : T("最小化"));
  }

  _attachResizeHandles() {
    const mk = (cls, dir) => {
      const el = h("div", { class: "cft-resize " + cls, title: T("拖动调整大小") });
      this.root.appendChild(el);
      this._bindResize(el, dir);
    };
    mk("cft-resize-se", "se");
    mk("cft-resize-e", "e");
    mk("cft-resize-s", "s");
  }

  _bindResize(el, dir) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = this.root.getBoundingClientRect();
      const start = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      const move = (ev) => {
        let width = start.width;
        let height = start.height;
        if (dir.includes("e")) width = start.width + (ev.clientX - startX);
        if (dir.includes("s")) height = start.height + (ev.clientY - startY);
        const geom = clampGeom({ left: start.left, top: start.top, width, height }, viewportSize());
        this._applyGeomSize(geom);
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        this._persistGeom();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  /* ------------------------------------------------------------ 行为 */

  toggleMinimize() {
    const min = !this.root.classList.contains("cft-minimized");
    this.root.classList.toggle("cft-minimized", min);
    if (this.geom) this.geom.minimized = min;
    this.root.style.height = min ? "auto" : this.geom ? this.geom.height + "px" : "";
    this._syncMinBtn();
    this._persistGeom();
  }

  open() {
    if (this._opened) return this;

    // 单例：同一 key 已有实例则让位（由调用方负责「同 node 则聚焦」的判断）
    if (this.singletonKey) {
      const prev = OPEN_MODALS.get(this.singletonKey);
      if (prev && prev !== this && prev._opened) prev.close();
      OPEN_MODALS.set(this.singletonKey, this);
    }

    const saved = this._loadGeom();
    const geom = saved || clampGeom(this._defaultGeom(), viewportSize());
    this._applyGeom(geom);

    document.body.appendChild(this.mask);
    document.addEventListener("keydown", this._onKey);
    this._opened = true;
    this.makeDraggable();
    this._persistGeom();
    this.onOpen?.();
    return this;
  }

  /** 把窗口重新提到最前并给一个短暂的高亮提示（单例重复打开时用）。 */
  focus() {
    if (!this._opened) {
      this.open();
      return;
    }
    try {
      document.body.appendChild(this.mask);
      this.root.classList.add("cft-flash");
      setTimeout(() => this.root.classList.remove("cft-flash"), 480);
    } catch {
      /* 忽略 */
    }
  }

  makeDraggable() {
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    let dragging = false;
    this.header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const rect = this.root.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      e.preventDefault();
    });
    const move = (e) => {
      if (!dragging) return;
      this.root.style.left = ox + (e.clientX - sx) + "px";
      this.root.style.top = oy + (e.clientY - sy) + "px";
      // 拖动后改用 left 定位，清掉 right，避免 left/right 同时生效造成跳动
      this.root.style.right = "auto";
      this.root.style.transform = "none";
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      this._persistGeom();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    this._cleanupDrag = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }

  close() {
    if (!this._opened) return;
    this.mask.remove();
    document.removeEventListener("keydown", this._onKey);
    this._cleanupDrag?.();
    this._opened = false;
    if (this.singletonKey && OPEN_MODALS.get(this.singletonKey) === this) {
      OPEN_MODALS.delete(this.singletonKey);
    }
    this.onClose?.();
  }

  toast(msg, isError = false) {
    const t = h("div", { class: `cft-toast${isError ? " cft-toast-err" : ""}`, text: msg });
    this.root.appendChild(t);
    setTimeout(() => t.classList.add("cft-toast-show"), 10);
    setTimeout(() => {
      t.classList.remove("cft-toast-show");
      setTimeout(() => t.remove(), 300);
    }, 2600);
  }

  setBusy(busy, text) {
    let b = this.root.querySelector(".cft-busy");
    if (busy) {
      if (!b) {
        b = h("div", { class: "cft-busy" }, [h("div", { class: "cft-spinner" }), h("span", { text: text || T("处理中…") })]);
        this.root.appendChild(b);
      } else {
        b.querySelector("span").textContent = text || T("处理中…");
      }
    } else if (b) {
      b.remove();
    }
  }
}

/* ------------------------------------------------- 弹窗 1：LoRA 堆管理面板 */

class StackManagerModal extends Modal {
  constructor(node) {
    super({
      title: T("CLR - LoRA 加载器"),
      width: 880,
      className: "cft-stack-modal",
      floating: true,
      persistKey: "stack",
      // v2.15：按节点单例 —— 两个节点可以同时开着各自的堆窗口
      singletonKey: "stack:" + (node?.id ?? "0"),
    });
    this.node = node;
    /** lora → 元数据 的展示缓存（不写回 widget，跨 render 保留） */
    this._metaMap = new Map();
    /** 同名副本分组（key = dupKeyOf，value = 该组全部条目），render() 时重算 */
    this.dupIndex = new Map();
  }

  async onOpen() {
    this.headerExtra.innerHTML = "";
    this.headerExtra.appendChild(
      h("button", { class: "cft-btn cft-btn-primary", text: T("＋ 添加 Lora"), onClick: () => openPicker(this.node, (picked) => this._applyPicked(picked)) })
    );
    // v2.21：设置按钮（配置 C 站 API Key 等）—— 放在「＋ 添加 Lora」旁边
    this.headerExtra.appendChild(
      h("button", { class: "cft-btn cft-settings-btn", text: T("⚙ 设置"), title: T("设置（C 站 API Key 等）"), onClick: () => openSettings() })
    );
    // v2.15：「↻ 重扫目录」「🧹 清理垃圾」两个按钮从堆窗口撤掉 ——
    // 这两个是全局维护动作，留一份在「＋ 添加 Lora」选择器里就够了，
    // 堆窗口只管当前这个堆（文件有变动时仍会自动重扫，见 onFilesChanged）。
    this.render();
    this.hydrate();
  }

  /** 清理 / 删除本地文件之后调用：重扫 + 重绘。 */
  async onFilesChanged() {
    try {
      await apiPost("/reload", {});
    } catch {
      /* 重扫失败不阻塞 UI */
    }
    Store.invalidate();
    await this.hydrate();
  }

  /** 用列表接口的元数据回填展示信息（首次打开 / 刷新后调用）。 */
  async hydrate() {
    try {
      const list = await Store.list();
      this._syncMeta(readStack(this.node), list);
      this.render();
    } catch {
      /* 静默 */
    }
  }

  /**
   * 取某条 entry 的元数据。
   * **必须优先用最新扫描结果**（META_CACHE / _metaMap 都由 Store.list() 填充）：
   * entry._meta 可能只是加入堆时的旧快照，若优先返回它，
   * 「从 C 站查到信息后黄标/作者/缩略图都不会更新」（真实 Bug）。
   * 缓存里没有（例如文件已被删）时才回退到 entry._meta。
   */
  _metaOf(entry) {
    return META_CACHE.get(entry.lora) || this._metaMap.get(entry.lora) || entry._meta || {};
  }

  /** 判定某条是否「缺 C 站信息」：creator / tags / trained_words 全空。 */
  _isMissing(entry) {
    return isMissingMeta(this._metaOf(entry));
  }

  /**
   * 把最新扫描结果同步到 META_CACHE / _metaMap **和堆内 entry._meta**。
   * META_CACHE 必须写：节点内嵌面板（renderNodePanel）读的是 readStack() 新建对象上的
   * entry._meta，不写缓存的话下次渲染就丢了。
   */
  _syncMeta(entries, list) {
    for (const it of (list && list.items) || []) {
      this._metaMap.set(it.lora, it);
      META_CACHE.set(it.lora, it);
    }
    for (const e of entries || []) {
      const fresh = META_CACHE.get(e.lora);
      if (fresh) e._meta = fresh;
    }
  }

  // v2.15：原本这里还有个 _rescan(btn) 给「↻ 重扫目录」按钮用，按钮撤掉后
  // 它就只剩死代码。重扫统一走 onFilesChanged()（清理 / 删除之后自动调）+ picker 的「↻ 刷新」。

  /** 单条查询某行 C 站信息（缺信息行上的「查」按钮）。 */
  async _queryRow(entry, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    try {
      const res = await Store.refresh(entry.lora);
      if (res && res.found) {
        this.toast(T("已更新「{0}」的 C 站信息", entry.display_name || entry.name));
      } else {
        this.toast(T("C 站未收录该文件（hash: {0}…）", String(res?.hash || "未知").slice(0, 12)), true);
      }
      Store.invalidate();
      const list = await Store.list(true);
      this._syncMeta(readStack(this.node), list);
      // 查询成功则清掉行内的错误标记
      if (res && res.found) entry._queryError = "";
      this.render();
      refreshNodePanel(this.node);
    } catch (err) {
      this.toast(String(err.message || err), true);
      entry._queryError = String(err.message || err);
      this.render();
    }
  }

  /**
   * 打开详情窗。详情窗里点「↻ 从 C 站刷新」成功后，会回调到这里：
   * 重新扫描 + 同步 _metaMap / entry._meta + 重绘，
   * 否则堆里的「无C站信息」黄标、作者、缩略图都不会更新。
   */
  _openDetail(loraName) {
    // v2.15 走单例入口：同一个 lora 只开一个详情窗
    return openDetailModal(loraName, async () => {
      Store.invalidate();
      try {
        const list = await Store.list(true);
        this._syncMeta(readStack(this.node), list);
      } catch { /* 静默：详情窗自身已刷新 */ }
      this.render();
      refreshNodePanel(this.node);
    });
  }

  _applyPicked(picked) {
    const entries = readStack(this.node);
    const exist = new Set(entries.map((e) => e.lora));
    for (const item of picked) {
      if (exist.has(item.lora)) continue;
      const entry = normalizeEntry({
        lora: item.lora,
        name: item.name,
        display_name: item.display_name,
        weight: 1,
        text_encoder_weight: 1,
        trigger_weight: item.trained_words?.length ? 1 : 0,
      });
      entry._meta = item;
      this._metaMap.set(item.lora, item);
      META_CACHE.set(item.lora, item);
      entries.push(entry);
    }
    writeStack(this.node, entries);
    this.render();
    refreshNodePanel(this.node);
  }

  render() {
    this.body.innerHTML = "";
    const entries = readStack(this.node);
    // 同名副本索引按「整份展示缓存」算，与当前堆内条目无关：
    // 组内只要有一条在堆里，它就该显示「副本 i/n」。
    this.dupIndex = buildDupIndex([...META_CACHE.values()]);

    if (!entries.length) {
      this.body.appendChild(
        h("div", { class: "cft-empty" }, [
          h("div", { class: "cft-empty-icon", text: "🎴" }),
          h("div", { text: T("还没有加入任何 Lora") }),
          h("div", { class: "cft-empty-hint", text: T("点右上角「＋ 添加 Lora」从模型库里挑选") }),
        ])
      );
      this.renderFooter(entries);
      return;
    }

    const list = h("div", { class: "cft-stack-list" });

    entries.forEach((entry, index) => {
      list.appendChild(this.buildRow(entry, index, entries));
    });

    this.body.appendChild(list);
    this.renderFooter(entries);
  }

  buildRow(entry, index, entries) {
    const meta = this._metaOf(entry);
    // 堆行不截断标签：自定义标签排在 C 站标签之前，用颜色区分（见报障 5）
    const tags = meta.tags || [];
    const userTags = meta.user_tags || [];
    const missing = this._isMissing(entry);
    const openDetail = () => this._openDetail(entry.lora);

    // 同名副本：用展示缓存查该条所在分组（缓存里没有该条就跳过标记）。
    const cached = META_CACHE.get(entry.lora) || meta;
    const dupGroup = cached ? this.dupIndex.get(dupKeyOf(cached)) || null : null;
    const dupIdx = dupGroup ? dupGroup.findIndex((x) => x.lora === entry.lora) : -1;
    const dup = dupGroup && dupIdx >= 0 ? { i: dupIdx + 1, n: dupGroup.length } : null;
    const media = coverMedia({ ...(meta || {}), lora: entry.lora });

    // 拖动把手：只有按住它才触发排序，避免干扰行内输入框 / 按钮 / 文字选择
    const drag = h("div", { class: "cft-drag", title: T("拖动排序"), text: "⠿" });
    this._attachDrag(drag, index);

    const img = makeThumb({ ...(meta || {}), lora: entry.lora }, "cft-thumb", {
      title: media.kind === "video" ? T("视频封面（点击查看 C 站详情）") : T("点击查看 C 站详情"),
      onClick: openDetail,
    });

    const subtitleParts = [];
    if (meta.creator) subtitleParts.push("by " + meta.creator);
    if (meta.base_model) subtitleParts.push(meta.base_model);
    if (meta.version_name) subtitleParts.push(meta.version_name);
    if (meta.downloads) subtitleParts.push("⬇ " + fmtCount(meta.downloads));
    // 同名副本时真正能区分两者的是文件名词干，必须显示出来
    if (entry.name) subtitleParts.push("📄 " + entry.name);

    const flagNodes = [];
    if (dup) flagNodes.push(h("span", { class: "cft-chip cft-chip-dup", text: T("副本 {0}/{1}", dup.i, dup.n) }));
    if (media.kind === "video") flagNodes.push(h("span", { class: "cft-chip cft-chip-video", text: T("▶ 视频") }));
    if (missing) {
      flagNodes.push(h("span", { class: "cft-badge cft-badge-warn", text: T("无C站信息") }));
      flagNodes.push(
        h("button", {
          class: "cft-mini-btn cft-query-btn",
          title: T("从 C 站查询这条 Lora"),
          text: T("查"),
          onClick: (e) => {
            e.stopPropagation();
            this._queryRow(entry, e.currentTarget);
          },
        })
      );
    }
    if (entry._queryError) flagNodes.push(h("span", { class: "cft-badge cft-badge-err", text: T("查询失败") }));

    const fileTip = meta.file_name ? T("\n文件：{0}", meta.file_name) : "";
    const titleRow = h("div", { class: "cft-row-title" }, [
      h("span", { class: "cft-name", text: entry.display_name || entry.name, title: T("点击查看 C 站详情") + fileTip, onClick: openDetail }),
      meta.url ? h("a", { class: "cft-ext", href: meta.url, target: "_blank", text: "↗", title: T("打开 C 站页面") }) : null,
      ...flagNodes,
    ]);

    const subtitle = h("div", { class: "cft-row-sub" }, [subtitleParts.join(" · ") || entry.lora]);

    const tagNodes = [
      ...userTags.map((t) => h("span", { class: "cft-tag cft-tag-user", text: t })),
      ...tags.map((t) => h("span", { class: "cft-tag", text: t })),
    ];
    const tagRow = tagNodes.length ? h("div", { class: "cft-tags" }, tagNodes) : null;

    const info = h("div", { class: "cft-row-info" }, [titleRow, subtitle, tagRow]);

    const numInput = h("input", {
      type: "number",
      class: "cft-num cft-num-lg",
      step: 0.05,
      // 不设 min/max —— 允许任意实数（负数、超过 3、多位小数）
      value: entry.weight,
      onChange: (e) => {
        entry.weight = parseWeight(e.target.value, entry.weight);
        e.target.value = entry.weight;
        writeStack(this.node, entries);
        refreshNodePanel(this.node);
      },
    });

    const clipInput = h("input", {
      type: "number",
      class: "cft-num",
      step: 0.05,
      value: entry.text_encoder_weight,
      onChange: (e) => {
        entry.text_encoder_weight = parseWeight(e.target.value, entry.text_encoder_weight);
        e.target.value = entry.text_encoder_weight;
        writeStack(this.node, entries);
      },
    });

    const triggerInput = h("input", {
      type: "number",
      class: "cft-num",
      step: 0.05,
      value: entry.trigger_weight,
      onChange: (e) => {
        entry.trigger_weight = parseWeight(e.target.value, entry.trigger_weight);
        e.target.value = entry.trigger_weight;
        writeStack(this.node, entries);
      },
    });

    const toggle = h("label", { class: "cft-switch", title: entry.hidden ? T("已禁用") : T("已启用") }, [
      h("input", {
        type: "checkbox",
        checked: !entry.hidden,
        onChange: (e) => {
          entry.hidden = !e.target.checked;
          writeStack(this.node, entries);
          this.render();
          refreshNodePanel(this.node);
        },
      }),
      h("span", { class: "cft-switch-track" }),
    ]);

    /* 收藏星标（v2.12）：放在「启用」右边，点一下收藏 / 再点取消。
       数据是同一份 .cft-user.json，所以选择器工具栏「⭐ 收藏」、详情窗、右键菜单
       都能看到这里点的收藏。状态读 _metaOf()（优先 META_CACHE），
       而 setUserMeta() 已经把响应写回 META_CACHE，因此无需手工同步。 */
    const favBtn = h("button", {
      class: "cft-icon-btn cft-fav-toggle",
      onClick: async (e) => {
        e.stopPropagation();
        if (favBtn.disabled) return;
        favBtn.disabled = true;
        try {
          const next = !Boolean(this._metaOf(entry).favorite);
          const data = await Store.setUserMeta(entry.lora, undefined, undefined, next);
          syncFav(); // 读 _metaOf()，此时已被 applyUserMetaToCache 更新
          this.toast(Boolean(data.favorite) ? T("已收藏") : T("已取消收藏"));
        } catch (err) {
          this.toast(String(err.message || err), true);
        } finally {
          favBtn.disabled = false;
        }
      },
    });
    const syncFav = () => {
      const on = Boolean(this._metaOf(entry).favorite);
      favBtn.classList.toggle("cft-faved", on);
      favBtn.textContent = on ? "★" : "☆";
      favBtn.title = on ? T("取消收藏") : T("收藏（之后可在选择器「⭐ 收藏」里快速找到）");
    };
    syncFav();

    const controls = h("div", { class: "cft-row-controls" }, [
      h("div", { class: "cft-field" }, [h("label", { text: T("模型权重") }), h("div", { class: "cft-field-inline" }, [numInput])]),
      h("div", { class: "cft-field cft-field-sm" }, [h("label", { text: "CLIP" }), clipInput]),
      h("div", { class: "cft-field cft-field-sm" }, [h("label", { text: T("触发词") }), triggerInput]),
      h("div", { class: "cft-field cft-field-sm cft-field-toggle" }, [h("label", { text: T("启用") }), toggle]),
      h("div", { class: "cft-field cft-field-sm cft-field-fav" }, [h("label", { text: T("收藏") }), favBtn]),
    ]);

    const actions = h("div", { class: "cft-row-actions" }, [
      h("button", { class: "cft-icon-btn", title: T("上移"), text: "↑", onClick: () => this.move(index, -1) }),
      h("button", { class: "cft-icon-btn", title: T("下移"), text: "↓", onClick: () => this.move(index, 1) }),
      h("button", {
        class: "cft-icon-btn cft-danger",
        title: T("移除"),
        text: "✕",
        onClick: () => {
          entries.splice(index, 1);
          writeStack(this.node, entries);
          this.render();
          refreshNodePanel(this.node);
        },
      }),
    ]);

    const row = h("div", { class: `cft-stack-row${entry.hidden ? " cft-disabled" : ""}${dup ? " cft-dup" : ""}`, dataset: { index: String(index) } }, [
      drag,
      img,
      info,
      controls,
      actions,
    ]);
    this._bindRowMenu(row, entry, index, entries);
    return row;
  }

  /** 某一行的右键菜单项（在 StackManagerModal 上，因为要从这里拿 node / entries）。 */
  rowMenuItems(entry, index, entries) {
    const label = entry.display_name || entry.name;
    const removeFromStack = () => {
      entries.splice(index, 1);
      writeStack(this.node, entries);
      this.render();
      refreshNodePanel(this.node);
    };
    return [
      { label: T("打开「{0}」详情", label), icon: "ⓘ", onClick: () => this._openDetail(entry.lora) },
      { label: T("从 C 站刷新信息"), icon: "↻", onClick: () => this._queryRow(entry, null) },
      { sep: true },
      { label: T("跳转到所在文件夹"), icon: "📂", hint: T("在系统文件管理器中定位到该文件"), onClick: () => revealLora(entry.lora, this.toast.bind(this), "select") },
      { label: T("打开所在目录"), icon: "🗀", hint: T("直接打开文件夹，不选中文件"), onClick: () => revealLora(entry.lora, this.toast.bind(this), "folder") },
      { label: T("查看本地文件清单"), icon: "📋", hint: T("本体 + 预览图 + 侧车，共几个文件多大"), onClick: () => showLocalFiles(entry.lora, this.toast.bind(this)) },
      { sep: true },
      { label: T("从堆中移除"), icon: "✕", hint: T("只从堆里去掉，不动磁盘文件"), onClick: removeFromStack },
      {
        label: T("本地删除（含图片与信息文件）"),
        icon: "🗑",
        danger: true,
        hint: T("删除 .safetensors 本体 + 预览图 + 全部侧车；默认移到隔离区可还原"),
        onClick: () =>
          deleteLoraLocal(entry.lora, this.toast.bind(this), () => {
            const arr = readStack(this.node);
            const at = arr.findIndex((x) => x.lora === entry.lora);
            if (at >= 0) {
              arr.splice(at, 1);
              writeStack(this.node, arr);
            }
            this.onFilesChanged();
            refreshNodePanel(this.node);
          }, true),
      },
    ];
  }

  _bindRowMenu(row, entry, index, entries) {
    bindContextMenu(row, () => this.rowMenuItems(entry, index, entries), T("右键：定位文件夹 / 本地删除"));
  }

  /** 只用 pointer 事件做拖动排序（HTML5 DnD 在 Electron 下与输入控件冲突较多）。 */
  _attachDrag(handle, index) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const list = this.body.querySelector(".cft-stack-list");
      if (!list) return;
      const rows = Array.from(list.querySelectorAll(".cft-stack-row"));
      const startRow = rows[index];
      let moved = false;
      let slot = index; // 插入槽位：0..n，指针越过第 i 行中点则 slot=i+1

      startRow?.classList.add("cft-dragging");

      const clearIndicators = () => {
        for (const r of rows) r.classList.remove("cft-drop-before", "cft-drop-after");
      };

      const move = (ev) => {
        moved = true;
        slot = 0;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i].getBoundingClientRect();
          if (ev.clientY > r.top + r.height / 2) slot = i + 1;
        }
        clearIndicators();
        const indicatorIndex = Math.max(0, Math.min(rows.length - 1, slot >= rows.length ? rows.length - 1 : slot));
        const tr = rows[indicatorIndex];
        if (tr) {
          const rr = tr.getBoundingClientRect();
          tr.classList.add(ev.clientY < rr.top + rr.height / 2 ? "cft-drop-before" : "cft-drop-after");
        }
        startRow?.classList.toggle("cft-dragging", true);
      };

      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        clearIndicators();
        startRow?.classList.remove("cft-dragging");
        if (!moved) return;

        const arr = readStack(this.node);
        const before = arr.map((x) => x.lora).join("|");
        const [item] = arr.splice(index, 1);
        if (!item) return;
        // 槽位是「插入位置」，移除被拖行后若槽位在其后需左移一位
        let insertAt = slot > index ? slot - 1 : slot;
        insertAt = Math.max(0, Math.min(arr.length, insertAt));
        arr.splice(insertAt, 0, item);
        const after = arr.map((x) => x.lora).join("|");
        if (before === after) return;
        writeStack(this.node, arr);
        this.render();
        refreshNodePanel(this.node);
      };

      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  move(index, delta) {
    const entries = readStack(this.node);
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    [entries[index], entries[target]] = [entries[target], entries[index]];
    writeStack(this.node, entries);
    this.render();
    refreshNodePanel(this.node);
  }

  renderFooter(entries) {
    this.footer.innerHTML = "";
    this.footer.appendChild(h("span", { class: "cft-footer-info", text: T("共 {0} 条 · {1} 条生效", entries.length, entries.filter((e) => !e.hidden).length) }));
    // 版本标记：用来确认浏览器跑的是最新 JS（扩展 JS 可能被缓存，
    // 看到旧版本号就 Ctrl+Shift+R 强刷）
    this.footer.appendChild(h("span", { class: "cft-footer-ver", text: T("前端 v{0}", FRONTEND_VERSION) }));

    const spacer = h("div", { class: "cft-spacer" });
    this.footer.appendChild(spacer);

    this.footer.appendChild(
      h("button", {
        class: "cft-btn",
        text: T("全部启用"),
        onClick: () => {
          entries.forEach((e) => (e.hidden = false));
          writeStack(this.node, entries);
          this.render();
          refreshNodePanel(this.node);
        },
      })
    );
    // 「全部停用」：把整堆临时关掉但**保留在列表里**（只改 hidden，不丢条目），
    // 想重新出图时点「全部启用」即可，比重建堆便宜得多。
    this.footer.appendChild(
      h("button", {
        class: "cft-btn",
        text: T("全部停用"),
        title: T("把当前堆里所有 Lora 设为停用（保留在列表中，出图时不生效）"),
        onClick: () => {
          entries.forEach((e) => (e.hidden = true));
          writeStack(this.node, entries);
          this.render();
          refreshNodePanel(this.node);
        },
      })
    );
    this.footer.appendChild(
      h("button", {
        class: "cft-btn cft-btn-danger",
        text: T("清空"),
        onClick: async () => {
          const ok = await askConfirm({
            title: T("清空 LoRA 堆"),
            message: T("确定清空 LoRA 堆吗？（只清空当前节点上的列表，不动磁盘文件）"),
            okLabel: T("清空"),
            danger: true,
            width: 460,
          });
          if (!ok) return;
          writeStack(this.node, []);
          this.render();
          refreshNodePanel(this.node);
        },
      })
    );
    this.footer.appendChild(
      h("button", { class: "cft-btn cft-btn-primary", text: T("完成"), onClick: () => this.close() })
    );
  }
}

/* ------------------------------------------------------- 弹窗 2：Lora 选择器 */

class PickerModal extends Modal {
  constructor(node, onPick) {
    const key = "picker:" + (node?.id ?? "0");
    super({
      title: T("选择 Lora"),
      width: 1040,
      height: 720,
      className: "cft-picker-modal",
      floating: true,
      persistKey: "picker",
      singletonKey: key,
    });
    this.node = node;
    this.onPick = onPick;
    this.selected = new Set();
    this.search = "";
    this.folder = "";
    /** 「只看收藏」开关（picker toolbar 上的独立收藏按钮，与文件夹筛选叠加） */
    this.favOnly = false;
    /** 当前选中的自定义标签（"" = 全部），来自 /user_tags */
    this.tag = "";
    this.userTagList = [];
    /** 同名副本分组（按全量 items 算，保证筛选后标记不消失） */
    this.dupIndex = new Map();
    this.view = parseViewMode(LS.getStr("picker.view", "grid"));
    this.cardSize = parseCardSize(LS.getJSON("picker.cardSize", CARD_SIZE_DEFAULT));
  }

  async onOpen() {
    this.setBusy(true, T("正在加载模型库…"));
    try {
      this.data = await Store.list();
      this.config = await Store.config();
      this.userTagList = await Store.userTags().catch(() => []);
    } catch (err) {
      this.toast(String(err.message || err), true);
      this.data = { items: [], folders: [], loras_dirs: [] };
    } finally {
      this.setBusy(false);
    }
    this.buildToolbar();
    this.render();
  }

  /** 清理 / 删除本地文件之后调用：重扫列表并重绘。 */
  async onFilesChanged() {
    try {
      await apiPost("/reload", {});
    } catch {
      /* 忽略 */
    }
    Store.invalidate();
    try {
      this.data = await Store.list(true);
    } catch {
      /* 忽略 */
    }
    this.userTagList = await Store.userTags().catch(() => []);
    this._fillFolders();
    this._fillTags();
    this.renderGrid();
  }

  /** 打开清理窗口（单例）。 */
  _openCleanup() {
    return openCleanup(this);
  }

  /** 单个条目的右键菜单项。 */
  itemMenuItems(item) {
    return [
      { label: T("查看「{0}」详情", item.display_name || item.name), icon: "ⓘ", onClick: () => this._openDetail(item.lora) },
      {
        label: item.favorite ? T("★ 取消收藏") : T("⭐ 收藏"),
        icon: item.favorite ? "★" : "⭐",
        onClick: async () => {
          const next = !item.favorite;
          try {
            await Store.setUserMeta(item.lora, undefined, undefined, next);
            item.favorite = next;
            this._fillFolders();
            this._fillTags();
            this.renderGrid();
            this.toast(next ? T("已收藏") : T("已取消收藏"));
          } catch (err) {
            this.toast(String(err.message || err), true);
          }
        },
      },
      { sep: true },
      { label: T("跳转到所在文件夹"), icon: "📂", onClick: () => revealLora(item.lora, this.toast.bind(this), "select") },
      { label: T("打开所在目录"), icon: "🗀", onClick: () => revealLora(item.lora, this.toast.bind(this), "folder") },
      { label: T("查看本地文件清单"), icon: "📋", onClick: () => showLocalFiles(item.lora, this.toast.bind(this)) },
      { sep: true },
      {
        label: T("本地删除（含图片与信息文件）"),
        icon: "🗑",
        danger: true,
        hint: T("删除 .safetensors 本体 + 预览图 + 全部侧车；默认移到隔离区可还原"),
        onClick: () => deleteLoraLocal(item.lora, this.toast.bind(this), () => this.onFilesChanged(), false),
      },
    ];
  }

  buildToolbar() {
    this.body.innerHTML = "";
    this.searchInput = h("input", {
      class: "cft-search",
      type: "search",
      placeholder: T("搜索名称 / 作者 / 文件名 / 标签 / 触发词 / 我的标签…"),
      onInput: (e) => {
        this.search = e.target.value.trim().toLowerCase();
        // 搜索叠加后，标签下拉里的条数要跟着重算
        this._fillTags();
        this.renderGrid();
      },
    });

    // ---- 「⭐ 收藏」独立筛选按钮：只看被收藏的 Lora（与文件夹 / 搜索 / 标签叠加）。
    // 用户原意是「一个显眼的收藏入口」，放在工具栏比塞进文件夹下拉更好找。
    this.favBtn = h("button", {
      class: "cft-btn cft-fav-btn",
      text: T("⭐ 收藏"),
      title: T("只看收藏的 Lora（再点一次取消）"),
      onClick: () => {
        this.favOnly = !this.favOnly;
        this._syncFavBtn();
        this._fillTags();
        this.renderGrid();
      },
    });

    this.folderSelect = h("select", {
      class: "cft-select",
      onChange: (e) => {
        this.folder = e.target.value;
        this._fillTags();
        this.renderGrid();
      },
    });
    this._fillFolders();

    // ---- 标签筛选（我的标签 ∪ C 站标签，选项带计数）
    this.tagSelect = h("select", {
      class: "cft-select",
      title: T("按标签筛选（我的标签 / C 站标签）"),
      onChange: (e) => {
        this.tag = e.target.value;
        this.renderGrid();
      },
    });
    this._fillTags();

    // ---- 刷新
    this.refreshBtn = h("button", {
      class: "cft-btn cft-refresh",
      text: T("↻ 刷新"),
      title: T("重新扫描模型目录（新增 / 删除的 Lora）"),
      onClick: () => this.refresh(),
    });

    // ---- 批量查 C 站（查询范围 = 当前筛选出来的列表，按钮上显示待查条数）
    this.batchBtn = h("button", {
      class: "cft-btn cft-batchquery",
      text: T("🔍 批量查 C 站"),
      title: T("为当前列表里缺少 C 站信息的 Lora 批量在线查询（可按搜索/文件夹缩小范围）"),
      onClick: (e) => this.batchQuery(e.currentTarget),
    });

    // ---- 视图切换
    this.viewGridBtn = h("button", { class: "cft-btn cft-viewbtn", title: T("卡片视图"), text: T("▦ 卡片"), onClick: () => this.setView("grid") });
    this.viewListBtn = h("button", { class: "cft-btn cft-viewbtn", title: T("列表视图"), text: T("☰ 列表"), onClick: () => this.setView("list") });

    // ---- 卡片尺寸
    this.sizeLabel = h("span", { class: "cft-cardsize-val", text: String(this.cardSize) });
    const sizeBox = h("div", { class: "cft-cardsize", title: T("卡片尺寸 {0}~{1}", CARD_SIZE_MIN, CARD_SIZE_MAX) }, [
      h("button", { class: "cft-icon-btn", text: "−", title: T("缩小卡片"), onClick: () => this.changeCardSize(-16) }),
      this.sizeLabel,
      h("button", { class: "cft-icon-btn", text: T("＋"), title: T("放大卡片"), onClick: () => this.changeCardSize(16) }),
    ]);

    const dirHint = (this.data.loras_dirs || []).join("  ·  ");

    this.toolbar = h("div", { class: "cft-toolbar" }, [
      this.searchInput,
      this.favBtn,
      this.folderSelect,
      this.tagSelect,
      this.refreshBtn,
      this.batchBtn,
      h("button", {
        class: "cft-btn cft-cleanup-btn",
        text: T("🧹 清理垃圾"),
        title: T("清理与现有 Lora 无关的孤立图片、侧车文件、下载残留"),
        onClick: () => this._openCleanup(),
      }),
      h("button", {
        class: "cft-btn cft-settings-btn",
        text: T("⚙ 设置"),
        title: T("设置（C 站 API Key 等）"),
        onClick: () => openSettings(),
      }),
      this.viewGridBtn,
      this.viewListBtn,
      sizeBox,
      h("div", { class: "cft-spacer" }),
      h("span", { class: "cft-hint", text: T("共 {0} 个 · 已选 {1}", this.data.items.length, this.selected.size), title: dirHint }),
    ]);

    this.grid = h("div", { class: "cft-grid" });
    this.body.appendChild(this.toolbar);
    this.body.appendChild(this.grid);

    this._syncViewButtons();

    this.footer.innerHTML = "";
    this.footer.appendChild(h("span", { class: "cft-footer-info", text: dirHint || T("未发现模型目录") }));
    this.footer.appendChild(h("div", { class: "cft-spacer" }));
    this.footer.appendChild(h("button", { class: "cft-btn", text: T("取消"), onClick: () => this.close() }));
    this.confirmBtn = h("button", {
      class: "cft-btn cft-btn-primary",
      text: T("添加所选"),
      onClick: () => {
        const chosen = this.data.items.filter((i) => this.selected.has(i.lora));
        if (!chosen.length) return this.toast(T("还没有选中任何 Lora"), true);
        this.onPick?.(chosen);
        this.toast(T("已添加 {0} 条", chosen.length));
        this.close();
      },
    });
    this.footer.appendChild(this.confirmBtn);
  }

  _fillFolders() {
    const prev = this.folder;
    this.folderSelect.innerHTML = "";
    this.folderSelect.appendChild(h("option", { value: "", text: T("全部文件夹 ({0})", this.data.items.length) }));
    for (const f of this.data.folders || []) {
      this.folderSelect.appendChild(h("option", { value: f.name, text: `${f.name} (${f.count})` }));
    }
    // 保持当前选择（若仍存在）；「⭐ 收藏」不再是文件夹值（见 toolbar 上的独立按钮）
    const stillThere = (this.data.folders || []).some((f) => f.name === prev);
    this.folderSelect.value = prev && stillThere ? prev : "";
    this.folder = this.folderSelect.value;
    // 收藏按钮上的计数跟着列表数据走（数据刷新后立刻变）
    this._syncFavBtn();
  }

  /** 同步收藏按钮态：激活时金色高亮 + ★ 前缀 + 实时计数。 */
  _syncFavBtn() {
    if (!this.favBtn) return;
    const n = (this.data?.items || []).filter((it) => it.favorite).length;
    this.favBtn.classList.toggle("cft-active", this.favOnly);
    this.favBtn.textContent = this.favOnly ? T("★ 收藏中 ({0})", n) : T("⭐ 收藏 ({0})", n);
    this.favBtn.title = this.favOnly
      ? T("正在只看收藏的 Lora（共 {0} 个）—— 再点一次恢复全部", n)
      : T("只看收藏的 Lora（再点一次取消）");
  }

  /**
   * 填充标签下拉：`全部标签 (N)` + 「我的标签」∪「C 站标签」两组（<optgroup>）。
   *
   *  · C 站标签按 `item.tags` 计数、自定义标签按 `item.user_tags` 计数；
   *  · 同名标签合并成一项 —— 归入「我的标签」组（还能看出是自己加的），
   *    计数取并集（选中后 user_tags 或 tags 任一命中都算，与 filtered() 一致）；
   *  · 每组内按出现次数降序；计数随搜索框 / 文件夹筛选重算（用 _tagBase()，含堆内）。
   */
  _fillTags() {
    if (!this.tagSelect) return;
    const prev = this.tag;
    
    const items = this._tagBase();

    const userCounts = new Map();
    const civCounts = new Map();
    // 命中计数 = user_tags 或 tags 含该标签的条目数（同名合并后的口径）
    const matchCounts = new Map();
    for (const it of items) {
      const ut = it.user_tags || [];
      const ct = it.tags || [];
      for (const t of ut) userCounts.set(t, (userCounts.get(t) || 0) + 1);
      for (const t of ct) civCounts.set(t, (civCounts.get(t) || 0) + 1);
      for (const t of new Set([...ut, ...ct])) matchCounts.set(t, (matchCounts.get(t) || 0) + 1);
    }
    // 合并「接口返回的全部自定义标签」：列表里没出现的也保留（计数 0）
    for (const t of this.userTagList || []) if (!userCounts.has(t)) userCounts.set(t, 0);

    const descBy = (counts) => (a, b) =>
      (counts.get(b) - counts.get(a)) || String(a).localeCompare(String(b), "zh");
    const userNames = [...userCounts.keys()].sort(descBy(userCounts));
    const civNames = [...civCounts.keys()].filter((t) => !userCounts.has(t)).sort(descBy(civCounts));
    const allKinds = new Set([...userCounts.keys(), ...civCounts.keys()]);

    this.tagSelect.innerHTML = "";
    this.tagSelect.appendChild(h("option", { value: "", text: T("全部标签 ({0})", allKinds.size) }));
    const addGroup = (label, names, counts) => {
      if (!names.length) return;
      const og = h("optgroup", { label });
      for (const t of names) {
        og.appendChild(h("option", { value: t, text: `${t} (${matchCounts.get(t) ?? counts.get(t) ?? 0})` }));
      }
      this.tagSelect.appendChild(og);
    };
    addGroup(T("我的标签"), userNames, userCounts);
    addGroup(T("C 站标签"), civNames, civCounts);

    const selectable = new Set([...userNames, ...civNames]);
    this.tagSelect.value = prev && selectable.has(prev) ? prev : "";
    this.tag = this.tagSelect.value;
  }

  _syncViewButtons() {
    if (!this.viewGridBtn) return;
    this.viewGridBtn.classList.toggle("cft-active", this.view === "grid");
    this.viewListBtn.classList.toggle("cft-active", this.view === "list");
  }

  setView(view) {
    this.view = parseViewMode(view);
    LS.setStr("picker.view", this.view);
    this._syncViewButtons();
    this.renderGrid();
  }

  changeCardSize(delta) {
    const next = parseCardSize(this.cardSize + delta);
    if (next === this.cardSize) return;
    this.cardSize = next;
    this.sizeLabel.textContent = String(next);
    this.grid.style.setProperty("--cft-card-size", next + "px");
    LS.setJSON("picker.cardSize", next);
    if (this.view === "grid") this.renderGrid();
  }

  /** 当前筛选结果里「值得在线查一次 C 站」的条目（缺作者/标签/触发词）。 */
  _missingItems() {
    // 批量查 C 站只处理 picker 列表可见的条目（排除堆内），与原 _filterBase 口径一致
    const existing = this._stackSet();
    return this.filtered().filter((it) => !existing.has(it.lora) && needsCivitaiLookup(it));
  }

  /**
   * 打开详情窗。详情窗里点「↻ 从 C 站刷新」成功后重新拉一次列表，
   * 让卡片上的「无C站信息」黄标 / 作者 / 缩略图当场更新。
   */
  _openDetail(loraName) {
    // v2.15 走单例入口：同一个 lora 只开一个详情窗
    return openDetailModal(loraName, async () => {
      Store.invalidate();
      try {
        this.data = await Store.list(true);
        this._fillFolders();
      } catch { /* 静默：详情窗自身已刷新 */ }
      // 详情窗里可能刚改了自定义标签，下拉要跟着更新
      this.userTagList = await Store.userTags().catch(() => []);
      this._fillTags();
      this.renderGrid();
    });
  }

  /** 让批量按钮显示待查条数（0 条时回归纯文案，避免误以为有活可干）。 */
  _updateBatchBtn() {
    if (!this.batchBtn) return;
    const n = this._missingItems().length;
    this.batchBtn.textContent = n ? T("🔍 批量查 C 站 ({0})", n) : T("🔍 批量查 C 站");
    this.batchBtn.title = n
      ? T("为当前列表里 {0} 条缺作者 / 标签 / 触发词的 Lora 批量在线查询", n)
      + T("（注意：这些 Lora 可能已有 C 站侧车文件，只是作者等字段没写全；查询可尝试补全）")
      : T("当前列表里的 Lora 都已有作者 / 标签信息");
    this.batchBtn.classList.toggle("cft-btn-dim", !n);
  }

  /**
   * 批量查 C 站：只查**当前筛选结果**里缺信息的条目
   * （尊重搜索框 / 文件夹筛选，方便缩小范围；已在堆里的不会出现在列表里）。
   */
  async batchQuery(btn) {
    const missing = this._missingItems();
    if (!missing.length) {
      this.toast(T("当前列表里的 Lora 都已有 C 站信息"));
      return;
    }
    const names = missing.map((it) => it.lora);
    if (btn) btn.disabled = true;
    this.setBusy(true, T("正在查询 C 站 0/{0}…（单条可能需要几秒）", names.length));
    try {
      const data = await Store.refreshBatch(names, false);
      const results = data.results || [];
      const found = Number.isFinite(data.found) ? data.found : results.filter((r) => r.found).length;
      const failed = Number.isFinite(data.failed) ? data.failed : results.filter((r) => r.error).length;
      const notFound = Number.isFinite(data.not_found) ? data.not_found : results.length - found - failed;
      let msg = T("命中 {0} 条 · 未收录 {1} 条 · 失败 {2} 条", found, notFound, failed);
      if (data.truncated) msg += T("（本次仅处理前 200 条，可缩小筛选范围再查）");
      this.toast(msg);

      // 重新扫描，让新命中的作者 / 基座 / 缩略图 / 黄标当场更新
      Store.invalidate();
      this.data = await Store.list(true);
      this.config = await Store.config();
      this._fillFolders();
      this.renderGrid();
    } catch (err) {
      this.toast(String(err.message || err), true);
    } finally {
      this.setBusy(false);
      if (btn) btn.disabled = false;
      // 不能还原成 oldText：那会把 renderGrid() 刚算出的新条数盖掉
      this._updateBatchBtn();
    }
  }

  async refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    const btn = this.refreshBtn;
    const oldText = btn ? btn.textContent : T("↻ 刷新");
    if (btn) {
      btn.disabled = true;
      btn.textContent = T("刷新中…");
    }
    this.setBusy(true, T("正在刷新模型库…"));
    try {
      await apiPost("/reload", {});
      Store.invalidate();
      this.data = await Store.list(true);
      this.config = await Store.config();
      this._fillFolders();
      this.renderGrid();
      this.toast(T("已刷新，共 {0} 个", (this.data.items || []).length));
    } catch (err) {
      this.toast(String(err.message || err), true);
    } finally {
      this.setBusy(false);
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
      this._refreshing = false;
    }
  }

  render() {
    this.renderGrid();
  }

  /** 搜索框 / 收藏 / 文件夹匹配（不含「排除堆内」与标签筛选）。 */
  _matchBase(it) {
    // 「只看收藏」（toolbar 独立按钮）与文件夹条件是叠加关系：
    // 激活收藏 + 选某文件夹 = 该文件夹里的收藏
    if (this.favOnly && !it.favorite) return false;
    if (this.folder && (it.folder || "") !== this.folder) return false;
    if (!this.search) return true;
    const hay = [
      it.name, it.display_name, it.creator, it.folder, it.file_name,
      (it.tags || []).join(" "), (it.trained_words || []).join(" "), it.base_model,
      (it.user_tags || []).join(" "), it.user_note,
    ].join(" ").toLowerCase();
    return hay.includes(this.search);
  }

  /** 当前堆里已有的 lora 集合（picker 默认不展示它们，避免重复添加）。 */
  _stackSet() {
    return new Set(readStack(this.node).map((e) => e.lora));
  }

  /**
   * 搜索框 / 文件夹筛选后的条目（**不含标签筛选本身**，且**排除已在堆里的**）。
   * 默认列表用 —— picker 的职责是挑还没进堆的 lora。
   * filtered() 与 _fillTags() 的计数共用它，避免「按标签筛选后下拉计数被自己缩水」。
   */
  _filterBase() {
    const existing = this._stackSet();
    return (this.data?.items || []).filter((it) => this._matchBase(it) && !existing.has(it.lora));
  }

  /**
   * 标签口径：搜索框 / 文件夹筛选后的**全量**条目（**含堆内**）。
   * 自定义标签大多打在堆内 lora 上（用户从堆里开详情加标签），
   * 计数与筛选若排除堆内，「油光丝袜 (0)」这种假 0 就会出现（v2.8 修复的报障 8）。
   */
  _tagBase() {
    return (this.data?.items || []).filter((it) => this._matchBase(it));
  }

  filtered() {
    // 「只看收藏」与标签筛选同口径：基于 _tagBase()（**含堆内**）——
    // 用户从堆窗口给堆里的 lora 点收藏，那些 lora 按定义就在堆里，
    // 若收藏视图沿用「排除堆内」的默认列表口径，收藏视图会恒空
    // （工具栏计数却显示 N，自相矛盾，v2.11 报障）。
    // 命中的堆内条目标「已在堆中」且不可再选（buildCard/buildListRow/_toggleSelect 已实现）。
    if (this.favOnly || this.tag) {
      const base = this._tagBase();
      if (!this.tag) return base;
      return base.filter(
        (it) => (it.user_tags || []).includes(this.tag) || (it.tags || []).includes(this.tag)
      );
    }
    return this._filterBase();
  }

  _updateHint(count) {
    if (this.toolbar) {
      const el = this.toolbar.querySelector(".cft-hint");
      if (el) el.textContent = T("匹配 {0} 个 · 已选 {1}", count, this.selected.size);
    }
  }

  renderGrid() {
    if (!this.grid) return;
    const items = this.filtered();
    // 副本索引必须用**全量 items** 算，而不是 filtered：否则一次筛选后
    // 组内另一条被过滤掉，剩下的那条就丢了「副本 i/n」标记。
    this.dupIndex = buildDupIndex(this.data?.items || []);
    this.grid.innerHTML = "";
    this.grid.className = this.view === "list" ? "cft-list" : "cft-grid";
    this.grid.style.setProperty("--cft-card-size", this.cardSize + "px");

    this._updateHint(items.length);
    this._updateBatchBtn();

    if (!items.length) {
      this.grid.appendChild(h("div", { class: "cft-empty" }, [h("div", { text: T("没有匹配的 Lora") })]));
      return;
    }

    // 一次渲染只算一次堆内集合（每张卡都 readStack(JSON.parse) 太浪费）
    this._curStackSet = this._stackSet();

    const frag = document.createDocumentFragment();
    for (const item of items.slice(0, 400)) {
      frag.appendChild(this.view === "list" ? this.buildListRow(item) : this.buildCard(item));
    }
    this.grid.appendChild(frag);
  }

  _toggleSelect(key) {
    // 双保险：堆内条目不可再选（卡片点击处已拦截）
    if (!this.selected.has(key) && this._stackSet().has(key)) {
      this.toast(T("该 Lora 已在堆里"));
      return;
    }
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
    this.renderGrid();
  }

  /**
   * 卡片 / 列表行脚部的收藏星标（v2.12 新增）：点一下收藏、再点取消。
   *
   * 与右键菜单、详情窗、工具栏「⭐ 收藏」写的是同一份 `.cft-user.json`，
   * 所以四个入口互相看得见彼此的改动。
   *
   * @param item    列表条目（就地改 favorite，避免整表重绘把滚动位置弄丢）
   * @param chipsEl 徽标容器：⭐ 徽标在这里就地增删（不重绘整张卡）
   * @param anchorSel 徽标插入锚点选择器（传 null 表示插到最前）
   */
  _buildFavStar(item, chipsEl, anchorSel) {
    const chip = h("span", { class: "cft-chip cft-chip-fav", text: "⭐" });
    const syncChip = () => {
      if (!chipsEl) return;
      const on = Boolean(item.favorite);
      const has = chip.parentElement === chipsEl;
      if (on && !has) {
        const anchor = anchorSel ? chipsEl.querySelector(anchorSel) : null;
        if (anchor && anchor.nextSibling) chipsEl.insertBefore(chip, anchor.nextSibling);
        else if (anchor) chipsEl.appendChild(chip);
        else chipsEl.insertBefore(chip, chipsEl.firstChild);
      } else if (!on && has) {
        chip.remove();
      }
    };
    const sync = () => {
      const on = Boolean(item.favorite);
      btn.classList.toggle("cft-faved", on);
      btn.textContent = on ? "★" : "☆";
      btn.title = on ? T("取消收藏") : T("收藏（之后可在工具栏「⭐ 收藏」里快速找到）");
      syncChip();
    };
    const btn = h("button", {
      // 不复用 .cft-card-info：那个类是 ⓘ 的标识，混用会让「找 ⓘ」的选择器
      // 先抓到星标（R7c 就是这样被悄悄带偏的）。外观在 CSS 里对齐即可。
      class: "cft-card-fav",
      onClick: async (e) => {
        e.stopPropagation(); // 别顺带把卡片选中态切了
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          const data = await Store.setUserMeta(item.lora, undefined, undefined, !item.favorite);
          item.favorite = Boolean(data.favorite);
          sync();
          this._syncFavBtn(); // 工具栏计数跟着走
          // 正在「只看收藏」时取消收藏 → 当场移出视图，不用手动刷新
          if (this.favOnly) this.renderGrid();
          this.toast(item.favorite ? T("已收藏") : T("已取消收藏"));
        } catch (err) {
          this.toast(String(err.message || err), true);
        } finally {
          btn.disabled = false;
        }
      },
    });
    sync();
    return btn;
  }

  buildCard(item) {
    const key = item.lora;
    const openDetail = () => this._openDetail(item.lora);
    const dupGroup = this.dupIndex.get(dupKeyOf(item)) || null;
    const dupIdx = dupGroup ? dupGroup.findIndex((x) => x.lora === item.lora) : -1;
    const dup = dupGroup && dupIdx >= 0 ? { i: dupIdx + 1, n: dupGroup.length } : null;
    const media = coverMedia(item);
    const fileTip = item.file_name ? T("\n文件：{0}", item.file_name) : "";
    // 标签筛选会把堆内 lora 也带出来（报障 8）：标「已在堆中」且不可再选
    const inStack = (this._curStackSet || this._stackSet()).has(key);

    // 选中用「视觉描边环」，pointer-events:none（见 CSS）——
    // 命中测试交给下面的 .cft-card-body，避免旧实现里绝对定位层吃掉所有点击。
    const card = h("div", { class: `cft-card${this.selected.has(key) ? " cft-selected" : ""}${inStack ? " cft-instack" : ""}` });

    // 缩略图 / 标题 → 打开详情（stopPropagation 以免同时切换选中态）
    const img = makeThumb(item, "cft-card-img", {
      title: (media.kind === "video" ? T("视频封面 · ") : "") + T("点击查看 C 站详情"),
      onClick: (e) => {
        e.stopPropagation();
        openDetail();
      },
    });

    // ⭐ 收藏徽标由 _buildFavStar() 就地增删（点星标当场显隐），这里不预置
    const badges = [];
    if (inStack) badges.push(h("span", { class: "cft-chip cft-chip-instack", text: T("已在堆中") }));
    if (item.base_model) badges.push(h("span", { class: "cft-chip", text: item.base_model }));
    if (item.nsfw) badges.push(h("span", { class: "cft-chip cft-chip-nsfw", text: "NSFW" }));
    if (dup) badges.push(h("span", { class: "cft-chip cft-chip-dup", text: T("副本 {0}/{1}", dup.i, dup.n) }));
    if (media.kind === "video") badges.push(h("span", { class: "cft-chip cft-chip-video", text: T("▶ 视频") }));
    if (isMissingMeta(item)) badges.push(h("span", { class: "cft-chip cft-chip-warn", text: T("无C站信息") }));
    const metaEl = h("div", { class: "cft-card-meta" }, badges);

    // 自定义标签与 C 站标签混排在同一行，用颜色区分（不再单挂「✦ 自定义」徽标）。
    // 用户自己写的排在前面：v2.18 起自定义标签最多显示 5 个、超出折叠成「+N」，
    // C 站标签仍最多 3 个、触发词最多 2 个（卡片高度优先）。
    const MAX_USER_TAGS = 5;
    const utAll = item.user_tags || [];
    const userTags = utAll.slice(0, MAX_USER_TAGS).map((t) => h("span", { class: "cft-tag cft-tag-user", text: t }));
    if (utAll.length > MAX_USER_TAGS) {
      const rest = utAll.slice(MAX_USER_TAGS);
      userTags.push(h("span", {
        class: "cft-tag cft-tag-user cft-tag-more",
        text: "+" + rest.length,
        title: T("其余自定义标签：\n") + rest.join("\n"),
      }));
    }
    const tags = (item.tags || []).slice(0, 3).map((t) => h("span", { class: "cft-tag", text: t }));
    const words = (item.trained_words || []).slice(0, 2).map((t) => h("span", { class: "cft-tag cft-tag-word", text: t }));

    const subParts = [item.creator ? "by " + item.creator : item.folder || T("根目录")];
    if (item.name) subParts.push("📄 " + item.name);

    const body = h("div", {
      class: "cft-card-body",
      title: inStack ? T("已在堆里（不可重复添加）") : T("点击选中 / 取消选中"),
      onClick: () => {
        if (inStack) { this.toast(T("该 Lora 已在堆里")); return; }
        this._toggleSelect(key);
      },
    }, [
      img,
      metaEl,
      // v2.15：标题不再打开详情 —— 只有缩略图和 ⓘ 才开详情，
      // 其余位置（标题 / 标签 / 副标题 / 空白处）一律是「选中 / 取消选中」，
      // 点击会自然冒泡到上面的 .cft-card-body
      h("div", {
        class: "cft-card-title",
        text: item.display_name || item.name,
        title: (inStack ? T("已在堆里（不可重复添加）") : T("点击选中 / 取消选中")) + fileTip + (item.has_user ? T("\n有自定义标签 / 说明") : ""),
      }),
      h("div", { class: "cft-card-sub", text: subParts.join(" · ") }),
      h("div", { class: "cft-card-tags" }, [...userTags, ...tags, ...words]),
      h("div", { class: "cft-card-foot" }, [
        h("span", { text: fmtCount(item.downloads) + " ⬇" }),
        h("span", { class: "cft-card-size", text: (item.size_mb || 0) + " MB" }),
        // 收藏星标：紧跟在 ⓘ 左边，随手就能点（v2.12）
        this._buildFavStar(item, metaEl, ".cft-chip-instack"),
        h("button", {
          class: "cft-card-info",
          title: T("查看 C 站详情"),
          text: "ⓘ",
          onClick: (e) => {
            e.stopPropagation();
            openDetail();
          },
        }),
      ]),
    ]);

    // 右键菜单挂在 wrap 上（整个卡片都是命中区）
    const wrap = h("div", { class: `cft-card-wrap${dup ? " cft-dup" : ""}` }, [card, body]);
    bindContextMenu(wrap, () => this.itemMenuItems(item), T("右键：定位文件夹 / 本地删除"));
    return wrap;
  }

  buildListRow(item) {
    const key = item.lora;
    const openDetail = () => this._openDetail(item.lora);
    const selected = this.selected.has(key);
    // 标签筛选会把堆内 lora 也带出来（报障 8）：标「已在堆中」且不可再选
    const inStack = (this._curStackSet || this._stackSet()).has(key);
    const dupGroup = this.dupIndex.get(dupKeyOf(item)) || null;
    const dupIdx = dupGroup ? dupGroup.findIndex((x) => x.lora === item.lora) : -1;
    const dup = dupGroup && dupIdx >= 0 ? { i: dupIdx + 1, n: dupGroup.length } : null;
    const media = coverMedia(item);
    const fileTip = item.file_name ? T("\n文件：{0}", item.file_name) : "";

    const img = makeThumb(item, "cft-list-thumb", {
      title: (media.kind === "video" ? T("视频封面 · ") : "") + T("点击查看 C 站详情"),
      onClick: (e) => {
        e.stopPropagation();
        openDetail();
      },
    });

    const subParts = [];
    if (item.creator) subParts.push("by " + item.creator);
    if (item.base_model) subParts.push(item.base_model);
    subParts.push((item.size_mb || 0) + " MB");
    if (item.name) subParts.push("📄 " + item.name);

    // ⭐ 收藏徽标由 _buildFavStar() 就地增删（点星标当场显隐），这里不预置
    const tagsEl = h("div", { class: "cft-list-tags" }, [
      ...(inStack ? [h("span", { class: "cft-chip cft-chip-instack", text: T("已在堆中") })] : []),
      // 自定义标签与 C 站标签混排（前 2 自定义 + 3 C 站），用颜色区分
      ...(item.user_tags || []).slice(0, 2).map((t) => h("span", { class: "cft-tag cft-tag-user", text: t })),
      ...(item.tags || []).slice(0, 3).map((t) => h("span", { class: "cft-tag", text: t })),
      ...(dup ? [h("span", { class: "cft-chip cft-chip-dup", text: T("副本 {0}/{1}", dup.i, dup.n) })] : []),
      ...(media.kind === "video" ? [h("span", { class: "cft-chip cft-chip-video", text: T("▶ 视频") })] : []),
      ...(isMissingMeta(item) ? [h("span", { class: "cft-chip cft-chip-warn", text: T("无C站信息") })] : []),
    ]);

    const row = h("div", { class: `cft-list-row${selected ? " cft-selected" : ""}${dup ? " cft-dup" : ""}${inStack ? " cft-instack" : ""}` }, [
      img,
      h("div", { class: "cft-list-main" }, [
        // v2.15：名称不再打开详情（同 buildCard 的标题），点它 = 选中，
        // 点击冒泡到整行的 click 处理器；开详情只认缩略图和 ⓘ
        h("div", {
          class: "cft-list-name",
          text: item.display_name || item.name,
          title: (inStack ? T("已在堆里（不可重复添加）") : T("点击选中 / 取消选中")) + fileTip + (item.has_user ? T("\n有自定义标签 / 说明") : ""),
        }),
        h("div", { class: "cft-list-sub", text: subParts.join(" · ") }),
      ]),
      tagsEl,
      // 收藏星标：与网格视图同位置，紧跟在 ⓘ 左边（v2.12）
      this._buildFavStar(item, tagsEl, null),
      h("button", {
        class: "cft-card-info",
        title: T("查看 C 站详情"),
        text: "ⓘ",
        onClick: (e) => {
          e.stopPropagation();
          openDetail();
        },
      }),
    ]);

    // 选中点击交给整行主体（ⓘ / 缩略图 / 标题已 stopPropagation）；堆内条目不可再选
    row.addEventListener("click", () => {
      if (inStack) { this.toast(T("该 Lora 已在堆里")); return; }
      this._toggleSelect(key);
    });
    bindContextMenu(row, () => this.itemMenuItems(item), T("右键：定位文件夹 / 本地删除"));
    return row;
  }
}

/* --------------------------------------------------------- 弹窗 3：Lora 详情 */

class DetailModal extends Modal {
  constructor(loraName, onChange) {
    // 详情窗口浮动，并相对堆窗口偏移 24px 错开，避免完全重叠
    super({
      title: T("Lora 详情"),
      width: 900,
      height: 720,
      className: "cft-detail-modal",
      floating: true,
      offset: 24,
      persistKey: "detail",
      // v2.15：同一个 lora 只开一个详情窗（再点就聚焦已有的那个，不叠窗口）。
      // 不同 lora 仍可各开各的，方便对照着看。
      singletonKey: "detail:" + loraName,
    });
    this.loraName = loraName;
    /**
     * 父窗口（堆面板 / 选择器 / 节点面板）的「重新同步元数据」回调。
     * 两条路都要触发：
     * ① 「↻ 从 C 站刷新」成功后**立刻**触发——否则卡片上的「无C站信息」黄标
     *    不会消失（回调曾经只挂在关窗时机上，刷新按钮那条路调的 onRefresh
     *    根本没被赋值过，等于空操作）；
     * ② 关窗时兜底再同步一次（幂等）。
     *
     * v2.15：详情窗按 lora 单例后，同一个详情窗可能被**多个**父窗口先后打开
     * （先在选择器里点开，再从堆窗口点开同一个 lora）。每个父窗口都得能刷新自己，
     * 所以回调收进一个 Set 广播，而不是只留最后那个 —— 否则先打开的那个窗口
     * 关窗后不刷新，黄标 / 作者会一直停在旧值。
     */
    this._changeCbs = new Set();
    if (typeof onChange === "function") this._changeCbs.add(onChange);
    // 保持 onChange 是个函数：外部有 `await this.onChange?.()` 的用法
    this.onChange = async () => {
      for (const cb of this._changeCbs) {
        try { await cb(); } catch { /* 单个父窗口异常不拖累其它 */ }
      }
    };
    /** /user_meta 读到的自定义数据（标签 / 说明 / 封面），onOpen 里与详情并行拉取 */
    this.userMeta = null;
    /** v2.19 全自动保存：关窗兜底提交器（_buildUserSection 里赋值） */
    this._flushUserMeta = null;
  }

  onClose() {
    // v2.19：关窗兜底 —— 元素被移除不会触发 blur，没这道 flush 会丢最后一笔改动
    const flush = this._flushUserMeta;
    (async () => {
      try { if (flush) await flush(); } catch (_) { /* 保存失败不阻塞关窗 */ }
      await this.onChange?.();
    })();
  }

  async onOpen() {
    this.setBusy(true, T("正在读取元数据…"));
    try {
      // 详情与用户自定义数据并行拉；用户数据失败不致命（置 null 即可）
      const [detail, um] = await Promise.all([
        Store.detail(this.loraName, true),
        Store.userMeta(this.loraName).catch(() => null),
      ]);
      this.detail = detail;
      this.userMeta = um || null;
    } catch (err) {
      const msg = String(err.message || err);
      this.setBusy(false);
      // 失败必须有「看得见」的提示：不仅 toast，还在窗口内渲染错误块，
      // 避免浮动窗口后用户看不到任何反馈（曾经「点了没反应」的观感来源）。
      this.renderError(msg);
      this.toast(msg, true);
      return;
    }
    this.setBusy(false);
    this.render();
  }

  /** 详情读取失败时在正文里渲染可见的错误状态 + 重试按钮。 */
  renderError(msg) {
    this.body.innerHTML = "";
    this.headerExtra.innerHTML = "";
    this.headerExtra.appendChild(
      h("button", {
        class: "cft-btn",
        text: T("↻ 重试"),
        onClick: () => {
          this.headerExtra.innerHTML = "";
          this.onOpen();
        },
      })
    );
    this.body.appendChild(
      h("div", { class: "cft-error" }, [
        h("div", { class: "cft-error-icon", text: "⚠" }),
        h("div", { class: "cft-error-title", text: T("读取 C 站信息失败") }),
        h("div", { class: "cft-error-msg", text: msg }),
        h("div", { class: "cft-error-hint", text: T("Lora：{0}", this.loraName) }),
      ])
    );
  }

  render() {
    const d = this.detail || {};
    const civ = d.civitai || {};
    const tr = d.training || {};
    this.body.innerHTML = "";

    this.headerExtra.innerHTML = "";
    this.headerExtra.appendChild(
      h("button", {
        class: "cft-btn",
        text: T("↻ 从 C 站刷新"),
        title: T("按文件哈希重新查询并写回 .civitai.info"),
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = T("查询中…");
          try {
            const res = await Store.refresh(this.loraName);
            if (res.found) {
              this.toast(T("已更新 C 站信息"));
              Store.invalidate();
              // 查到即写缓存：黄标不依赖 /list 重扫是否立刻反映（重扫有 20s 扫描
              // 缓存 + sidecar 写入时序，曾导致「点完刷新黄标还在」）。
              const fresh = metaFromCivitai(res.info, META_CACHE.get(this.loraName));
              if (fresh) META_CACHE.set(this.loraName, { lora: this.loraName, ...fresh });
              this.detail = await Store.detail(this.loraName, true);
              this.render();
              // 立刻通知父窗口：堆面板 / 选择器 / 节点面板要重新同步元数据，
              // 否则「无C站信息」黄标和作者/缩略图不会更新。
              try { this.onChange && await this.onChange(); } catch { /* 父窗口自己会兜底 */ }
            } else {
              this.toast(T("C 站未收录该文件（hash: ") + (res.hash || T("未知")).slice(0, 12) + T("…）"), true);
            }
          } catch (err) {
            this.toast(String(err.message || err), true);
          } finally {
            btn.disabled = false;
            btn.textContent = T("↻ 从 C 站刷新");
          }
        },
      })
    );
    if (civ.url) {
      this.headerExtra.appendChild(h("a", { class: "cft-btn", href: civ.url, target: "_blank", text: T("在 C 站打开 ↗") }));
    }
    // 只在确实存在自定义封面时，才提供「清除 / 恢复原封面」入口
    if (this.userMeta?.cover) {
      this.headerExtra.appendChild(
        h("button", {
          class: "cft-btn",
          text: T("🖼 恢复原封面"),
          title: T("清除自定义封面并还原原来的预览图"),
          onClick: async (e) => {
            const btn = e.currentTarget;
            const ok = await askConfirm({
              title: T("恢复原封面"),
              message: T("确定清除自定义封面，并还原成原来的预览图吗？"),
              okLabel: T("恢复原封面"),
              width: 480,
            });
            if (!ok) return;
            btn.disabled = true;
            try {
              const data = await Store.clearCover(this.loraName);
              this.userMeta = data;
              this.toast(T("已恢复原封面"));
              this.detail = await Store.detail(this.loraName, true);
              this.render();
              await this.onChange?.();
            } catch (err) {
              this.toast(String(err.message || err), true);
            } finally {
              btn.disabled = false;
            }
          },
        })
      );
    }

    const left = h("div", { class: "cft-detail-left" });
    const right = h("div", { class: "cft-detail-right" });

    // ---- 左侧：预览图 / 预览视频 + 示例图
    const remoteImages = (civ.images || []).filter((im) => im && im.url);
    // 三级回退里的「远程首图」必须是图片：视频塞进 <img> 只会触发失败兜底
    const remoteFirstImage = remoteImages.find((im) => String(im.type || "").toLowerCase() !== "video")?.url;
    const umCover = this.userMeta?.cover || null;

    // 主舞台该用图片还是视频：用户自定义封面优先于列表快照
    const stageItem = {
      ...d,
      lora: this.loraName,
      cover_type: umCover?.type || d.cover_type || "",
      cover_url: umCover?.url || d.cover_url || "",
      preview: Boolean(d.preview),
      remote_images: remoteImages,
    };
    const stageMedia = coverMedia(stageItem);

    // Lightbox 图片清单：本地预览图（索引 0）+ C 站远程图（索引 1..n）
    // **视频不进大图导航**（Lightbox 只会显示 <img>），视频在主舞台用原生控件播。
    const localPreviewUrl = `${API_BASE}/preview?name=${encodeURIComponent(this.loraName)}`;
    const lightboxImages = [{ url: localPreviewUrl, title: this.loraName }];
    for (const im of remoteImages.slice(0, 12)) {
      if (String(im.type || "").toLowerCase() === "video") continue;
      lightboxImages.push({ url: remoteImageUrl(im.url), title: `${im.width || "?"}×${im.height || "?"}` });
    }
    const openLightboxAt = (url, fallbackIndex) => {
      // url 可能是 img.src（浏览器给绝对化过的 http://host/...），而清单里存的是
      // 相对路径 /cft_lora/image?url=... —— 直接比会永远匹配不上，于是无论当前
      // 舞台停在第几张，点开大图都从第 0 张开始。这里统一取 pathname+search 再比。
      const norm = (u) => {
        if (!u) return "";
        try {
          const x = new URL(u, location.href);
          return x.pathname + x.search;
        } catch {
          return String(u);
        }
      };
      const key = norm(url);
      const idx = lightboxImages.findIndex((im) => norm(im.url) === key);
      Lightbox.open(lightboxImages, idx >= 0 ? idx : fallbackIndex);
    };

    let stage = 0;
    let stageEl = null;
    // 「设为封面」的目标：当前舞台展示的 C 站远程图/视频。
    // 点缩略图时更新；初始为空（舞台还停在默认预览图时没有可设为封面的远程素材）。
    let activeCoverTarget = null;
    const stageHost = h("div", { class: "cft-detail-stage" });

    const renderImageAt = (src, opts) => {
      const img = h("img", {
        class: "cft-detail-img",
        src,
        title: T("点击查看大图"),
        // 传 attribute 上的相对地址（img.src 会被浏览器绝对化成 http://host/...）
        onClick: () => openLightboxAt(img.getAttribute("src") || img.src, 0),
      });
      guardImage(img, opts);
      stageEl = img;
      stageHost.innerHTML = "";
      stageHost.appendChild(img);
      return img;
    };

    const renderVideoStage = (src) => {
      const v = h("video", {
        class: "cft-detail-img cft-thumb-video",
        src,
        controls: true,
        autoplay: true,
        muted: true,
        loop: true,
        playsinline: true,
        preload: "metadata",
        title: T("视频封面"),
      });
      // autoplay 静音起播依赖 property（HTML 属性对 muted 不敏感）
      v.muted = true;
      v.defaultMuted = true;
      // 播放失败要有可见反馈（不留黑色空框）
      guardVideo(v);
      stageEl = v;
      stageHost.innerHTML = "";
      stageHost.appendChild(v);
      return v;
    };

    if (stageMedia.kind === "video") {
      renderVideoStage(stageMedia.src);
    } else {
      // 三级回退：本地预览图 → C 站远程图（经代理）→ 占位图
      renderImageAt(localPreviewUrl, {
        then: (img) => {
          delete img.dataset.cftFallback;
          img.classList.remove("cft-img-fail");
          if (stage === 0 && remoteFirstImage) {
            stage = 1;
            img.src = remoteImageUrl(remoteFirstImage);
          } else {
            img.src = PLACEHOLDER_IMG;
          }
        },
      });
    }
    left.appendChild(stageHost);

    // 「设为封面」按钮：放在大图下侧（不再悬浮在缩略图上）。
    // 初始目标为空 → 置灰提示「点下方缩略图，再设为封面」；点缩略图后锁定目标、可点击。
    const coverBtn = h("button", {
      class: "cft-detail-set-cover",
      text: T("⭐ 设为封面"),
      title: T("把当前大图/视频设为封面"),
      disabled: true,
      onClick: async () => {
        const tgt = activeCoverTarget;
        if (!tgt) return;
        const old = coverBtn.textContent;
        coverBtn.disabled = true;
        coverBtn.textContent = "…";
        try {
          // 注意：set_cover 要的是**原始 C 站 URL**，不是 /cft_lora/image 代理地址
          const data = await Store.setCover(this.loraName, tgt.url, {
            type: tgt.isVideo ? "video" : "image",
            download: !tgt.isVideo,
          });
          this.userMeta = data;
          this.toast(tgt.isVideo ? T("已设为视频封面（记录链接）") : T("已设为封面（已下载到本地）"));
          this.detail = await Store.detail(this.loraName, true);
          this.render();
          await this.onChange?.();
        } catch (err) {
          this.toast(String(err.message || err), true);
          coverBtn.disabled = false;
          coverBtn.textContent = old;
        }
      },
    });
    // 点缩略图切换舞台后，解锁按钮（缩略图 handler 里已同步 activeCoverTarget）
    const unlockCover = () => {
      if (activeCoverTarget) {
        coverBtn.disabled = false;
        const tgt = activeCoverTarget;
        coverBtn.textContent = tgt.isVideo ? T("⭐ 把此视频设为封面") : T("⭐ 把此图片设为封面");
        coverBtn.title = tgt.isVideo
          ? T("把这个视频设为封面（只记录链接）")
          : T("把这个图片设为封面（下载到本地预览图）");
      }
    };
    // 若一开始就是远程首图（stage 直接跳到 1），初始即可设封面
    if (remoteFirstImage) {
      activeCoverTarget = { url: remoteFirstImage, isVideo: false };
      unlockCover();
    }
    left.appendChild(coverBtn);

    // 封面来源一行说明
    left.appendChild(h("div", { class: "cft-detail-cover-hint", text: this._coverHintText() }));

    const gallery = remoteImages.slice(0, 8);
    if (gallery.length) {
      const galBox = h("div", { class: "cft-gallery" });
      gallery.forEach((im, gi) => {
        const isVideo = String(im.type || "").toLowerCase() === "video";
        const mediaEl = isVideo
          ? h("video", {
              class: "cft-gallery-item cft-gallery-video",
              src: remoteImageUrl(im.url),
              muted: true,
              loop: true,
              autoplay: true,
              playsinline: true,
              preload: "metadata",
            })
          : guardImage(h("img", { class: "cft-gallery-item", src: remoteImageUrl(im.url), loading: "lazy" }));
        if (isVideo) {
          mediaEl.muted = true;
          mediaEl.defaultMuted = true;
          // 画廊项只有 62px 高，本质是缩略图：失败就退化成占位图，
          // 塞整段文字提示会把左栏挤成竖条（截图实测）。
          guardVideo(mediaEl, { thumb: true });
        }
        mediaEl.title = T("{0}×{1}（点击设为主图，再点大图看大图）", im.width || "?", im.height || "?");

        // 点击监听绑在 .cft-gal-item 容器上，而不是 mediaEl 上：
        // 视频缩略图加载失败时 guardVideo 会把 <video> 换成 <img>（replaceWith），
        // 若监听绑在旧 video 上，替换后监听器就丢了，点它再也切不了主图/设不了封面。
        const galItem = h("div", { class: `cft-gal-item${isVideo ? " cft-gal-item-video" : ""}` }, [
          mediaEl,
          isVideo ? h("span", { class: "cft-gal-flag", text: "▶" }) : null,
        ]);
        galItem.addEventListener("click", (e) => {
          e.stopPropagation();
          // 缩略图只做一件事：把它设为舞台主图（并同步「设为封面」的目标）。
          // **不在这里弹大图** —— 以前点缩略图会顺手 Lightbox.open()，等于
          // 想看主图却被一层大图挡住，还得先关掉才能设封面（用户报障 2）。
          // 看大图只认舞台那张封面图（renderImageAt 里绑的 onClick）。
          const src = remoteImageUrl(im.url);
          activeCoverTarget = { url: im.url, isVideo };
          unlockCover();
          if (isVideo) {
            renderVideoStage(src);
            return;
          }
          stage = 1;
          if (stageEl && stageEl.tagName === "IMG") {
            delete stageEl.dataset.cftFallback;
            stageEl.classList.remove("cft-img-fail");
            stageEl.src = src;
          } else {
            renderImageAt(src);
          }
        });
        galBox.appendChild(galItem);
      });
      left.appendChild(galBox);
    }

    // ---- 右侧：信息
    right.appendChild(h("div", { class: "cft-detail-title", text: d.display_name || d.name || this.loraName }));
    // v2.19：收藏按钮从「我的标签 / 说明」标题行移到 lora 名称下面这一行（紧跟路径）
    right.appendChild(h("div", { class: "cft-detail-subrow" }, [
      h("span", { class: "cft-detail-path", text: this.loraName }),
      h("div", { class: "cft-spacer" }),
      this._buildFavButton(),
    ]));

    const kv = h("div", { class: "cft-kv" });
    const addKv = (k, v) => {
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return;
      kv.appendChild(h("div", { class: "cft-kv-k", text: k }));
      kv.appendChild(h("div", { class: "cft-kv-v", text: String(v) }));
    };
    addKv(T("作者"), civ.creator);
    addKv(T("类型"), civ.type);
    addKv(T("基座模型"), d.base_model || tr.base_model_version);
    addKv(T("版本"), civ.version_name);
    addKv(T("下载量"), civ.stats?.downloadCount);
    addKv(T("收藏数"), civ.stats?.favoriteCount);
    addKv(T("文件大小"), (d.size_mb || 0) + " MB");
    addKv(T("数据来源"), { civitai: T("C 站元数据文件"), safetensors: T("Safetensors 头部") }[d.source] || d.source);
    addKv("SHA256", d.sha256 ? d.sha256.slice(0, 24) + "…" : "");
    addKv(T("发布时间"), civ.publishedAt ? String(civ.publishedAt).slice(0, 10) : "");
    right.appendChild(kv);

    // ---- 我的标签 / 说明（本地保存，刷新 C 站不会覆盖）
    right.appendChild(this._buildUserSection());

    // 触发词
    const words = civ.trainedWords || [];
    if (words.length) {
      const wordBox = h("div", { class: "cft-section" }, [
        h("div", { class: "cft-section-title" }, [
          h("span", { text: T("训练触发词") }),
          h("button", {
            class: "cft-mini-btn",
            text: T("复制"),
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(words.join(", "));
                this.toast(T("已复制触发词"));
              } catch {
                this.toast(T("复制失败，请手动选择"), true);
              }
            },
          }),
        ]),
        h("div", { class: "cft-word-list" }, words.map((w) => h("span", { class: "cft-tag cft-tag-word", text: w }))),
      ]);
      right.appendChild(wordBox);
    }

    // 标签：自定义标签与 C 站标签**混排在同一行**（自定义在前、用颜色区分），都不截断。
    const civTags = civ.tags || [];
    const myTags = (this.userMeta?.tags) || [];
    if (civTags.length || myTags.length) {
      right.appendChild(
        h("div", { class: "cft-section" }, [
          h("div", { class: "cft-section-title", text: T("标签") }),
          h("div", { class: "cft-word-list" }, [
            ...myTags.map((t) => h("span", { class: "cft-tag cft-tag-user", text: t, title: T("我的标签") })),
            ...civTags.map((t) => h("span", { class: "cft-tag", text: t })),
          ]),
        ])
      );
    }

    // 训练参数
    const tKeys = [
      ["network_dim", T("网络维度 dim")], ["network_alpha", T("网络 alpha")],
      ["learning_rate", T("学习率")], ["unet_lr", T("UNet 学习率")],
      ["epochs", T("训练轮数")], ["max_train_steps", T("最大步数")],
      ["resolution", T("训练分辨率")], ["optimizer", T("优化器")],
      ["clip_skip", "Clip Skip"], ["noise_offset", "Noise Offset"],
      ["min_snr_gamma", "Min SNR Gamma"], ["network_module", T("网络模块")],
      ["title", T("模型标题")], ["architecture", T("架构")],
    ];
    const tRows = tKeys.filter(([k]) => tr[k] !== undefined).map(([k, label]) => [label, tr[k]]);
    if (tRows.length) {
      const table = h("div", { class: "cft-kv cft-kv-dense" });
      for (const [label, val] of tRows) {
        table.appendChild(h("div", { class: "cft-kv-k", text: label }));
        table.appendChild(h("div", { class: "cft-kv-v", text: String(val) }));
      }
      right.appendChild(
        h("div", { class: "cft-section" }, [
          h("div", { class: "cft-section-title", text: T("训练参数（读取自 Safetensors 头部）") }),
          table,
        ])
      );
    }

    // 高频标签（当没有官方触发词时很有用）
    if (!words.length && Array.isArray(tr.top_tags) && tr.top_tags.length) {
      right.appendChild(
        h("div", { class: "cft-section" }, [
          h("div", { class: "cft-section-title", text: T("打标高频词（可作为触发词参考）") }),
          h("div", { class: "cft-word-list" },
            tr.top_tags.slice(0, 20).map(([w, c]) => h("span", { class: "cft-tag cft-tag-word", text: `${w} (${c})` }))
          ),
        ])
      );
    }

    // 描述
    if (civ.description) {
      right.appendChild(
        h("div", { class: "cft-section" }, [
          h("div", { class: "cft-section-title", text: T("C 站描述") }),
          h("div", { class: "cft-desc", text: civ.description }),
        ])
      );
    }

    this.body.appendChild(h("div", { class: "cft-detail-wrap" }, [left, right]));
  }

  /** 主图下方的一行封面来源说明。 */
  _coverHintText() {
    const cov = this.userMeta?.cover;
    if (cov) {
      if (String(cov.type || "").toLowerCase() === "video") return T("封面：自定义视频（链接）");
      if (cov.kind === "downloaded") return T("封面：自定义图片（已下载）");
      return T("封面：自定义图片（链接）");
    }
    const d = this.detail || {};
    if (d.preview) return T("封面：本地预览图");
    const civ = d.civitai || {};
    const hasImg = (civ.images || []).some(
      (im) => im && im.url && String(im.type || "").toLowerCase() !== "video"
    );
    if (hasImg) return T("封面：C 站图片");
    return T("封面：无（占位）");
  }

  /**
   * 收藏按钮（v2.19 从「我的标签 / 说明」标题行搬到 lora 名称下方）。
   * 收藏与标签 / 说明同住 .cft-user.json，走**部分更新**（只改 favorite 一位），
   * 不会把刚打的标签、刚写的说明冲掉。
   */
  _buildFavButton() {
    let favorite = Boolean(this.userMeta?.favorite);
    const btn = h("button", { class: "cft-mini-btn cft-fav-btn" });
    const sync = () => {
      btn.dataset.fav = favorite ? "1" : "";
      btn.textContent = favorite ? T("★ 已收藏") : T("⭐ 收藏");
      btn.title = favorite
        ? T("点一下取消收藏")
        : T("把这个 Lora 收进「⭐ 收藏」（选择器里可一键只看收藏）");
    };
    sync();
    btn.addEventListener("click", async () => {
      const next = !favorite;
      btn.disabled = true;
      try {
        const data = await Store.setUserMeta(this.loraName, undefined, undefined, next);
        // 用服务端归一化后的完整用户数据刷新本地状态（顺便把 tags/note 也同步回来）
        this.userMeta = data;
        favorite = Boolean(data.favorite);
        sync();
        // 与标签保存同一条刷新链：父窗口（堆面板 / 选择器 / 节点面板）当场看到收藏态
        await this.onChange?.();
        this.toast(next ? T("已收藏") : T("已取消收藏"));
      } catch (err) {
        this.toast(String(err.message || err), true);
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  /**
   * 「我的标签 / 说明」一节：可增删标签、编辑说明，均存本地 .cft-user.json。
   *
   * v2.19 起**全自动保存**（撤掉「保存」按钮）：
   *   · 标签：回车 / 「＋ 添加」/ 输入框失焦 → 静默保存
   *   · 说明：停手 700ms / 失焦 → 静默保存
   *   · 关窗兜底：flush() 把还没提交的输入与说明再存一次
   * 保存后**不整窗重渲**（会丢输入焦点与滚动位置），只就地刷新标签 chips；
   * 卡片 / 列表的展示由 onChange 回调触发的父窗口重绘负责。
   */
  _buildUserSection() {
    const tags = [...((this.userMeta?.tags) || [])];
    const note = (this.userMeta?.note) || "";

    const tagListEl = h("div", { class: "cft-word-list cft-user-taglist" });
    let inputEl = null;
    let textareaEl = null;

    const renderTags = () => {
      tagListEl.innerHTML = "";
      if (!tags.length) {
        tagListEl.appendChild(h("span", { class: "cft-user-empty", text: T("还没有自定义标签") }));
        return;
      }
      tags.forEach((t, i) => {
        const x = h("span", { class: "cft-tag-x", text: "✕", title: T("删除该标签") });
        x.addEventListener("click", async (e) => {
          e.stopPropagation();
          tags.splice(i, 1);
          await save(true);
        });
        tagListEl.appendChild(h("span", { class: "cft-tag cft-tag-user" }, [h("span", { text: t }), x]));
      });
    };

    /* v2.19：撤掉「保存」按钮，全自动保存。但静默保存必须自带可见反馈，
       否则用户无法确认改动到底落盘没有 —— 标题行右侧一个会变色的状态字。 */
    const statusEl = h("span", { class: "cft-user-status", text: T("自动保存") });
    let statusTimer = null;
    const flashSaved = () => {
      statusEl.textContent = T("已保存 ✓");
      statusEl.classList.add("cft-user-status-ok");
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(() => {
        statusEl.textContent = T("自动保存");
        statusEl.classList.remove("cft-user-status-ok");
      }, 1600);
    };

    /** 真正发请求的那一步（保存成功后就地刷新 chips，不整窗重渲） */
    const doSave = async (silent) => {
      try {
        const data = await Store.setUserMeta(this.loraName, tags, textareaEl ? textareaEl.value : note);
        this.userMeta = data;
        if (textareaEl) textareaEl.value = data.note || "";
        // 用服务端归一化后的标签刷新本地数组（去重 / 去空）
        tags.length = 0;
        for (const t of data.tags || []) tags.push(t);
        renderTags();
        if (silent) flashSaved();
        else this.toast(T("已保存"));
        await this.onChange?.();
        return true;
      } catch (err) {
        this.toast(String(err.message || err), true);
        return false;
      }
    };

    /**
     * 所有保存串行化（v2.19）：回车 / 失焦 / 说明防抖 / 关窗兜底 四个触发点
     * 可能在极短时间内连续触发，串行执行才能保证「最后一次改动」是最终落盘的版本。
     */
    let saveChain = Promise.resolve(true);
    const save = (silent) => {
      saveChain = saveChain.then(() => doSave(silent), () => doSave(silent));
      return saveChain;
    };

    const readInputTags = () =>
      String(inputEl?.value || "")
        .replace(/\n/g, ",")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    /**
     * 把输入框里**还没回车**的内容收进 tags（去重）并清空输入框。
     *
     * 根因修复：用户的实际用法是「打字 → 直接点保存」，旧实现只在回车时才把输入框
     * 内容 push 进 tags，保存按钮提交的永远是上一次的 tags（常为空），磁盘上就出现了
     * 5 个 `"tags": []`。返回是否真的有新增，供调用方决定要不要重绘。
     */
    const commitPending = () => {
      const add = readInputTags();
      if (!add.length) return false;
      let changed = false;
      for (const t of add) if (!tags.includes(t)) { tags.push(t); changed = true; }
      inputEl.value = "";
      return changed;
    };

    /** 说明是否与已保存的内容不一致（自动保存的判据） */
    const noteDirty = () => String(textareaEl?.value ?? note) !== String(this.userMeta?.note || "");
    let noteTimer = null;
    /** 说明输入防抖：停手 700ms 才发请求，边打字边发会把接口打爆 */
    const scheduleNoteSave = () => {
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        noteTimer = null;
        if (noteDirty()) save(true);
      }, 700);
    };

    inputEl = h("input", {
      class: "cft-input",
      placeholder: T("添加标签，回车 / 点「＋ 添加」（可用逗号一次加多个）"),
      // v2.19：失焦即把待输入内容收进 tags **并落盘** ——
      // 旧实现只渲染 chip 不保存，界面看着加上了、关窗就消失
      onBlur: () => { if (commitPending()) { renderTags(); save(true); } },
      onKeydown: async (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (!commitPending()) return;
        renderTags();
        await save(true);
      },
    });

    // 「＋ 添加」：等价于回车，别让用户只能靠回车
    const addBtn = h("button", {
      class: "cft-mini-btn cft-user-add",
      text: T("＋ 添加"),
      title: T("把输入框里的标签加进来（等价于回车）"),
      onClick: async () => {
        if (!commitPending()) return;
        renderTags();
        await save(true);
      },
    });

    textareaEl = h("textarea", {
      class: "cft-textarea",
      rows: "4",
      placeholder: T("写点关于这个 Lora 的说明…"),
      // v2.19：打字停 700ms 自动保存；失焦立即保存（关窗再有 flush 兜底）
      onInput: () => scheduleNoteSave(),
      onBlur: () => {
        if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
        if (noteDirty()) save(true);
      },
    });
    textareaEl.value = note;

    /* v2.20：清空拆成两份 —— 清空标签只动标签，清空说明只动说明，互不牵连。
       （旧实现一个「清空」把两者一起删了，想只清一样只能手动逐个删） */
    const clearTagsBtn = h("button", {
      class: "cft-mini-btn cft-user-clear-tags",
      text: T("清空标签"),
      title: T("只清空这个 Lora 的自定义标签（说明不受影响）"),
      onClick: async () => {
        const ok = await askConfirm({
          title: T("清空自定义标签"),
          message: T("确定清空这个 Lora 的全部自定义标签吗？说明不会受影响。"),
          okLabel: T("清空标签"),
          danger: true,
          width: 460,
        });
        if (!ok) return;
        tags.length = 0;
        // 输入框里待输入的内容也要一起清掉（否则点完清空又冒出来一个）
        if (inputEl) inputEl.value = "";
        renderTags();
        await save(true);
      },
    });
    const clearNoteBtn = h("button", {
      class: "cft-mini-btn cft-user-clear-note",
      text: T("清空说明"),
      title: T("只清空这个 Lora 的说明（标签不受影响）"),
      onClick: async () => {
        const ok = await askConfirm({
          title: T("清空说明"),
          message: T("确定清空这个 Lora 的说明吗？标签不会受影响。"),
          okLabel: T("清空说明"),
          danger: true,
          width: 460,
        });
        if (!ok) return;
        if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
        if (textareaEl) textareaEl.value = "";
        await save(true);
      },
    });

    /**
     * 关窗兜底（v2.19）：把输入框里还没回车的文字、以及还没防抖到点的说明一起提交。
     * 关窗时元素被移除不会触发 blur，没有这道兜底就会悄悄丢最后一笔改动。
     */
    const flush = async () => {
      if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
      const added = commitPending();
      if (added) renderTags();
      if (added || noteDirty()) await save(true);
    };
    this._flushUserMeta = flush;

    renderTags();

    return h("div", { class: "cft-section cft-user-section" }, [
      h("div", { class: "cft-section-title" }, [
        h("span", { text: T("我的标签 / 说明") }),
        h("span", { class: "cft-user-hint", text: T("（自动保存 · 仅本地，刷新 C 站不会覆盖）") }),
        h("div", { class: "cft-spacer" }),
        statusEl,
        clearTagsBtn,
        clearNoteBtn,
      ]),
      tagListEl,
      h("div", { class: "cft-user-input-row" }, [inputEl, addBtn]),
      textareaEl,
    ]);
  }
}

/* ------------------------------------------------------ 弹窗 4：清理垃圾文件 */

/**
 * 清理窗口：列出与现有 lora 不相关的孤立文件，按分类勾选后清理。
 *
 * 三条硬约束（与后端 cft_cleanup 一致，前端不得放宽）：
 *   · lora 本体永远不会出现在候选里
 *   · 默认「移到隔离区」，可一键还原；彻底删除需要显式勾选 + 二次确认
 *   · 通用 .json 分类默认不勾选（无法确认是不是 lora 侧车）
 */
class CleanupModal extends Modal {
  constructor(parent) {
    super({
      title: T("清理垃圾文件"),
      width: 860,
      height: 660,
      className: "cft-cleanup-modal",
      floating: true,
      offset: 48,
      persistKey: "cleanup",
      singletonKey: "cleanup",
    });
    /** 打开它的窗口（堆面板 / 选择器），清理完要通知它刷新 */
    this.parent = parent || null;
    this.report = null;
    /** categoryId → 是否勾选 */
    this.picked = new Map();
    /** 是否彻底删除（默认否 → 隔离区） */
    this.permanent = false;
  }

  async onOpen() {
    this.headerExtra.innerHTML = "";
    this.headerExtra.appendChild(
      h("button", { class: "cft-btn", text: T("↻ 重新扫描"), title: T("重新统计垃圾文件"), onClick: (e) => this.scan(e.currentTarget) })
    );
    this.renderLoading();
    await this.scan();
  }

  renderLoading() {
    this.body.innerHTML = "";
    this.body.appendChild(h("div", { class: "cft-empty" }, [h("div", { text: T("正在扫描模型目录…") })]));
  }

  async scan(btn) {
    if (btn) btn.disabled = true;
    this.renderLoading();
    try {
      this.report = await Store.cleanupScan(true);
      // 首次拿到分类时按后端给的 default_on 初始化；重扫保留用户已有勾选
      for (const g of this.report.groups || []) {
        if (!this.picked.has(g.id)) this.picked.set(g.id, Boolean(g.default_on));
      }
      this.render();
    } catch (err) {
      this.body.innerHTML = "";
      this.body.appendChild(h("div", { class: "cft-empty" }, [h("div", { text: T("扫描失败：") + String(err.message || err) })]));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** 当前勾选里的分类 id（跳过 0 个文件的分类，免得传空分类给后端）。 */
  pickedCats() {
    const out = [];
    for (const g of this.report?.groups || []) {
      if (this.picked.get(g.id) && g.count > 0) out.push(g.id);
    }
    return out;
  }

  render() {
    this.body.innerHTML = "";
    const rep = this.report;
    if (!rep || !(rep.groups || []).length) {
      this.body.appendChild(h("div", { class: "cft-empty" }, [h("div", { text: T("扫描无结果") })]));
      this.renderFooter();
      return;
    }

    const totalCount = rep.total || 0;
    if (!totalCount) {
      this.body.appendChild(
        h("div", { class: "cft-empty" }, [
          h("div", { class: "cft-empty-icon", text: "✨" }),
          h("div", { text: T("目录很干净，没有发现垃圾文件") }),
          h("div", { class: "cft-empty-hint", text: T("已扫描 {0} 个目录 / {1} 个文件", rep.scanned_dirs || 0, rep.scanned_files || 0) }),
        ])
      );
      this.renderFooter();
      return;
    }

    this.body.appendChild(
      h("div", { class: "cft-cleanup-banner" }, [
        h("span", { text: T("共发现 {0} 个无关文件，占用 {1}", totalCount, fmtBytes(rep.total_size)) }),
        h("span", { class: "cft-cleanup-banner-sub", text: T("扫描了 {0} 个目录 / {1} 个文件", rep.scanned_dirs || 0, rep.scanned_files || 0) }),
      ])
    );

    // ---- 安全提示
    this.body.appendChild(
      h("div", { class: "cft-cleanup-safe" }, [
        h("span", { text: "🛡" }),
        h("span", { text: T("Lora 模型本体（.safetensors/.ckpt/.pt/.bin）永远不会被清理。") }),
      ])
    );

    // ---- 分类复选
    const list = h("div", { class: "cft-cleanup-groups" });
    for (const g of rep.groups) {
      const on = Boolean(this.picked.get(g.id)) && g.count > 0;
      const box = h("input", {
        type: "checkbox",
        checked: on,
        disabled: g.count === 0,
        onChange: (e) => {
          this.picked.set(g.id, e.target.checked);
          this.render();
        },
      });
      const head = h("label", { class: `cft-cleanup-g${g.count === 0 ? " cft-cleanup-g-empty" : ""}` }, [
        h("span", { class: "cft-cleanup-g-check" }, [box]),
        h("span", { class: "cft-cleanup-g-label", text: g.label }),
        h("span", { class: "cft-cleanup-g-count", text: T("{0} 个", g.count) }),
        h("span", { class: "cft-cleanup-g-size", text: fmtBytes(g.size) }),
        h("span", { class: "cft-cleanup-g-hint", text: g.hint || "" }),
      ]);
      // 头部点击（点文字/数量/体积）也能切换，只有点复选框本体不重复触发
      head.addEventListener("click", (e) => {
        if (e.target === box || box.contains(e.target)) return;
        if (g.count === 0) return;
        this.picked.set(g.id, !this.picked.get(g.id));
        this.render();
      });

      const kids = [head];
      if (g.count > 0 && on) {
        const files = h("div", { class: "cft-cleanup-files" });
        for (const it of (g.items || []).slice(0, 200)) {
          files.appendChild(
            h("div", { class: "cft-cleanup-file", title: it.rel }, [
              h("span", { class: "cft-cleanup-file-rel", text: it.rel }),
              h("span", { class: "cft-cleanup-file-size", text: fmtBytes(it.size) }),
            ])
          );
        }
        if (g.count > 200) {
          files.appendChild(h("div", { class: "cft-cleanup-file cft-cleanup-file-more", text: T("… 另有 {0} 个未列出", g.count - 200) }));
        }
        kids.push(files);
      }
      list.appendChild(h("div", { class: "cft-cleanup-g-wrap" }, kids));
    }
    this.body.appendChild(list);

    // ---- 隔离区
    const permBox = h("input", {
      type: "checkbox",
      checked: this.permanent,
      onChange: (e) => {
        this.permanent = e.target.checked;
        this.renderFooter();
      },
    });
    this.permBox = permBox;
    this.body.appendChild(
      h("label", { class: "cft-cleanup-perm" }, [
        h("span", { class: "cft-cleanup-g-check" }, [permBox]),
        h("span", { class: "cft-cleanup-perm-text" }, [
          h("span", { text: T("彻底删除（不经过隔离区，无法还原）") }),
          h("span", { class: "cft-cleanup-perm-hint", text: T("不勾选时文件会被移到 loras/.cft_trash/，可以随时还原") }),
        ]),
      ])
    );

    this.renderFooter();
  }

  renderFooter() {
    this.footer.innerHTML = "";
    const cats = this.pickedCats();
    let count = 0;
    let size = 0;
    for (const g of this.report?.groups || []) {
      if (cats.includes(g.id)) {
        count += g.count;
        size += g.size;
      }
    }
    const mode = this.permanent ? T("彻底删除") : T("移到隔离区（可还原）");
    this.footer.appendChild(
      h("span", { class: "cft-footer-info", text: T("已选 {0} 类 · {1} 个文件 · {2} · {3}", cats.length, count, fmtBytes(size), mode) })
    );
    this.footer.appendChild(h("div", { class: "cft-spacer" }));

    this.footer.appendChild(
      h("button", {
        class: "cft-btn",
        text: T("打开隔离区"),
        title: T("查看已隔离的批次，并可还原"),
        onClick: () => openTrash(this),
      })
    );
    this.footer.appendChild(
      h("button", {
        class: `cft-btn${this.permanent ? " cft-btn-danger" : " cft-btn-primary"}`,
        text: this.permanent ? T("彻底删除所选") : T("清理所选"),
        disabled: count === 0,
        onClick: (e) => this._run(e.currentTarget),
      })
    );
  }

  async _run(btn) {
    const cats = this.pickedCats();
    if (!cats.length) {
      this.toast(T("请先勾选要清理的分类"), true);
      return;
    }
    let count = 0;
    let size = 0;
    for (const g of this.report.groups) {
      if (cats.includes(g.id)) {
        count += g.count;
        size += g.size;
      }
    }
    const verb = this.permanent ? T("彻底删除") : T("移到隔离区");
    const ok = await askConfirm({
      title: this.permanent ? T("彻底删除确认") : T("清理确认"),
      message: T("即将{0} {1} 个文件（{2}）。", verb, count, fmtBytes(size)),
      detailLines: [
        T("分类：{0}", this.report.groups.filter((g) => cats.includes(g.id)).map((g) => g.label).join("、")),
        this.permanent ? T("⚠️ 彻底删除后无法还原，确定继续吗？") : T("文件会移到 loras/.cft_trash/，之后可在「打开隔离区」里还原。"),
      ],
      okLabel: verb,
      danger: this.permanent,
      width: 560,
    });
    if (!ok) return;

    if (btn) btn.disabled = true;
    this.setBusy(true, T("正在清理…"));
    try {
      const res = await Store.cleanupRun(cats, { permanent: this.permanent });
      // 计数兜底：正式路径后端返 deleted / quarantined；
      // 若哪天回落到 dry_run 形状（只有 candidate_count），也不该把 "undefined" 印给用户。
      const n = (this.permanent ? res.deleted : res.quarantined) ?? res.moved ?? res.candidate_count ?? 0;
      const mb = fmtBytes(res.total_size || 0);
      this.toast(T("{0} {1} 个文件，释放 {2}", this.permanent ? "已彻底删除" : "已移到隔离区", n, mb));
      if (res.failed) this.toast(T("有 {0} 个文件处理失败，详见日志", res.failed), true);
      if (res.rejected_count) this.toast(T("有 {0} 个文件被安全校验拒绝", res.rejected_count), true);
      // 让来源窗口刷新（列表里可能有 lora 被删）
      this.parent?.onFilesChanged?.();
      await this.scan();
    } catch (err) {
      this.toast(String(err.message || err), true);
    } finally {
      this.setBusy(false);
      if (btn) btn.disabled = false;
    }
  }

  // 隔离区不再走「输入批次序号 + confirm」那套（依赖 window.prompt，Electron 下不可用，
  // 曾经的「点『打开隔离区』没反应」根因）。改为下方独立的 TrashModal 窗口。
}

/* ------------------------------------------------------- 弹窗 5：隔离区管理 */

/**
 * 隔离区窗口：逐批次列出已隔离的文件，一键还原。
 *
 * 为什么单开一个窗口：后端 /cleanup_trash 只返回「批次」粒度
 * （{stamp, count, size, original_root}），没有文件明细，
 * 所以这里只展示批次信息；还原后通知父窗口（清理窗口）刷新扫描结果。
 */
class TrashModal extends Modal {
  constructor(parent) {
    super({
      title: T("隔离区"),
      width: 720,
      height: 540,
      className: "cft-trash-modal",
      floating: true,
      offset: 72,
      persistKey: "trash",
      singletonKey: "trash",
    });
    /** 打开它的窗口（清理窗口），还原后要它刷新 */
    this.parent = parent || null;
    this.batches = [];
  }

  async onOpen() {
    this.headerExtra.innerHTML = "";
    this.headerExtra.appendChild(
      h("button", { class: "cft-btn", text: T("↻ 刷新"), title: T("重新读取隔离区批次"), onClick: (e) => this.load(e.currentTarget) })
    );
    await this.load();
  }

  async load(btn) {
    if (btn) btn.disabled = true;
    this.setBusy(true, T("正在读取隔离区…"));
    try {
      this.batches = (await Store.cleanupTrash()) || [];
      this.render();
    } catch (err) {
      this.batches = [];
      this.body.innerHTML = "";
      this.body.appendChild(
        h("div", { class: "cft-empty" }, [h("div", { text: T("读取隔离区失败：") + String(err.message || err) })])
      );
    } finally {
      this.setBusy(false);
      if (btn) btn.disabled = false;
    }
  }

  /** 批次号形如 YYYYMMDD-HHMMSS-xxxx，能解析就格式化成 `2026-10-16 18:23`，否则原样显示。 */
  _fmtStamp(stamp) {
    const m = String(stamp || "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (!m) return String(stamp || "");
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  }

  render() {
    this.body.innerHTML = "";
    const list = this.batches || [];
    if (!list.length) {
      this.body.appendChild(
        h("div", { class: "cft-empty" }, [
          h("div", { class: "cft-empty-icon", text: "🗑" }),
          h("div", { text: T("隔离区是空的") }),
          h("div", { class: "cft-empty-hint", text: T("清理时未勾选「彻底删除」的文件会进这里") }),
        ])
      );
      this.renderFooter();
      return;
    }

    const wrap = h("div", { class: "cft-trash-list" });
    for (const b of list) {
      wrap.appendChild(
        h("div", { class: "cft-trash-row", dataset: { stamp: String(b.stamp || "") } }, [
          h("div", { class: "cft-trash-info" }, [
            h("div", { class: "cft-trash-stamp", text: this._fmtStamp(b.stamp), title: String(b.stamp || "") }),
            h("div", { class: "cft-trash-meta", text: T("{0} 个文件 · {1}", b.count, fmtBytes(b.size)) }),
            h("div", { class: "cft-trash-root", text: T("原位置：{0}", b.original_root || b.root || "—") }),
          ]),
          h("div", { class: "cft-trash-actions" }, [
            h("button", { class: "cft-btn cft-btn-primary", text: T("还原"), onClick: () => this._restore(b) }),
            h("button", {
              class: "cft-mini-btn cft-btn-danger cft-trash-del",
              text: T("🗑 彻底删除"),
              title: T("把这个批次的文件从磁盘上删掉（不可还原）"),
              onClick: () => this._deleteBatch(b),
            }),
          ]),
        ])
      );
    }
    this.body.appendChild(wrap);
    this.renderFooter();
  }

  renderFooter() {
    this.footer.innerHTML = "";
    const empty = !(this.batches || []).length;
    this.footer.appendChild(h("span", { class: "cft-footer-info", text: T("共 {0} 个批次", (this.batches || []).length) }));
    this.footer.appendChild(h("span", { class: "cft-footer-ver", text: T("前端 v{0}", FRONTEND_VERSION) }));
    this.footer.appendChild(h("div", { class: "cft-spacer" }));
    this.footer.appendChild(
      h("button", {
        class: "cft-btn cft-btn-danger cft-trash-purge",
        text: T("🗑 清空隔离区"),
        title: empty ? T("隔离区已经是空的") : T("彻底删除隔离区里的全部批次（不可还原）"),
        disabled: empty,
        onClick: () => this._purgeAll(),
      })
    );
    this.footer.appendChild(h("button", { class: "cft-btn", text: T("关闭"), onClick: () => this.close() }));
  }

  /** 彻底删除**单个批次**（不可还原）。 */
  async _deleteBatch(b) {
    const ok = await askConfirm({
      title: T("彻底删除隔离文件"),
      message: T("确定彻底删除批次 {0} 的 {1} 个文件（{2}）吗？", b.stamp, b.count, fmtBytes(b.size)),
      detailLines: [T("⚠️ 删除后无法还原，文件会从磁盘上消失。")],
      okLabel: T("彻底删除"),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await Store.trashDelete(b.stamp);
      const n = res?.deleted ?? b.count;
      this.toast(T("已彻底删除 {0} 个文件，释放 {1}", n, fmtBytes(res?.freed ?? b.size)));
      // 来源窗口（清理窗口）刷新扫描结果与列表
      this.parent?.onFilesChanged?.();
      this.parent?.scan?.();
      await this.load();
    } catch (err) {
      this.toast(String(err.message || err), true);
    }
  }

  /** 清空隔离区（删除全部批次，不可还原）。 */
  async _purgeAll() {
    const total = (this.batches || []).length;
    if (!total) return;
    const ok = await askConfirm({
      title: T("清空隔离区"),
      message: T("确定彻底删除隔离区里全部 {0} 个批次的文件吗？", total),
      detailLines: [T("⚠️ 删除后无法还原，文件会从磁盘上消失。")],
      okLabel: T("清空隔离区"),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await Store.trashDelete(null, { all: true });
      const n = res?.deleted ?? 0;
      this.toast(T("已彻底删除 {0} 个文件，释放 {1}", n, fmtBytes(res?.freed ?? 0)));
      this.parent?.onFilesChanged?.();
      this.parent?.scan?.();
      await this.load();
    } catch (err) {
      this.toast(String(err.message || err), true);
    }
  }

  async _restore(b) {
    const ok = await askConfirm({
      title: T("还原批次"),
      message: T("确定还原批次 {0}？{1} 个文件（{2}）将回到原位置。", b.stamp, b.count, fmtBytes(b.size)),
      okLabel: T("还原"),
      width: 520,
    });
    if (!ok) return;
    try {
      const res = await Store.cleanupRestore(b.stamp);
      if (res && res.ok === false) {
        this.toast(res.error || T("还原失败"), true);
        return;
      }
      this.toast(T("已还原 {0} 个文件", res?.restored ?? b.count));
      // 还原后：来源窗口（清理窗口）刷新扫描结果与列表
      this.parent?.onFilesChanged?.();
      this.parent?.scan?.();
      await this.load();
    } catch (err) {
      this.toast(String(err.message || err), true);
    }
  }
}

/* ------------------------------------------------- 共享：自绘对话框工具 */

/**
 * 替代 window.confirm / window.prompt 的自绘对话框。
 *
 * ComfyUI Desktop 是 Electron，window.prompt 不可用（静默返回 null），
 * 曾经的「点『打开隔离区』没反应」「本地删除点了没动静」就是这个原因。
 *
 * @param {{title:string, message?:string, detailLines?:string[], buttons:Array<{label:string,value:string,kind?:'primary'|'danger'|'plain'}>, width?:number, height?:number, listTitle?:string, items?:Array<{name:string,size?:string,kindLabel?:string}>}} opts
 * @returns {Promise<string|null>} 点按钮返回其 value；关闭 / Esc / 遮罩 / 重复打开一律 resolve(null)
 */
function askChoice(opts = {}) {
  const {
    title = T("请选择"),
    message = "",
    detailLines = [],
    buttons = [],
    width = 640,
    height = 0,
    listTitle = "",
    items = null,
  } = opts;

  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const modal = new Modal({
      title,
      width,
      height,          // 0 → open() 里 _applyGeom 会写成 0px，onOpen 再覆盖为 auto
      className: "cft-ask-modal",
      floating: false,
      resizable: false,
      singletonKey: "cft-ask",
    });

    modal.onOpen = () => {
      // Modal.open() 已先跑过 _applyGeom（会把 0 写成 "0px"），这里覆盖成自适应高度。
      modal.root.style.height = "auto";
      modal.root.style.maxHeight = "80vh";

      modal.body.innerHTML = "";
      if (message) {
        modal.body.appendChild(h("div", { class: "cft-ask-message", text: String(message) }));
      }
      if (detailLines.length) {
        modal.body.appendChild(h("div", { class: "cft-ask-lines", text: detailLines.join("\n") }));
      }
      if (items && items.length) {
        const list = h("div", { class: "cft-ask-list" });
        if (listTitle) list.appendChild(h("div", { class: "cft-ask-list-title", text: listTitle }));
        for (const it of items) {
          list.appendChild(
            h("div", { class: "cft-ask-list-row" }, [
              h("span", { class: "cft-ask-list-name", text: String(it.name || ""), title: String(it.name || "") }),
              it.kindLabel ? h("span", { class: "cft-ask-list-kind", text: String(it.kindLabel) }) : null,
              h("span", { class: "cft-ask-list-size", text: String(it.size || "") }),
            ])
          );
        }
        modal.body.appendChild(list);
      }

      modal.footer.innerHTML = "";
      modal.footer.appendChild(h("div", { class: "cft-spacer" }));
      let focusEl = null;
      // 逆序右对齐：buttons 数组第一个是最靠左的主操作
      for (const b of [...buttons].reverse()) {
        const kind = b.kind || "plain";
        const btn = h("button", {
          class: `cft-btn${kind === "primary" ? " cft-btn-primary" : kind === "danger" ? " cft-btn-danger" : ""}`,
          text: b.label || "",
          onClick: () => {
            done(b.value);
            modal.close();
          },
        });
        if (kind === "primary" && !focusEl) focusEl = btn;
        modal.footer.appendChild(btn);
      }
      if (focusEl) {
        // 等一帧再聚焦，避免被 open() 后续逻辑抢走
        setTimeout(() => {
          try { focusEl.focus(); } catch { /* 忽略 */ }
        }, 0);
      }
    };

    // 任何关闭路径（Esc / 遮罩 / 关闭按钮 / 单例顶替）都要 resolve，绝不能挂住 await
    modal.onClose = () => done(null);
    modal.open();
  });
}

/** askChoice 的确认版：返回 Promise<boolean>。 */
function askConfirm({
  title,
  message,
  detailLines = [],
  okLabel = T("确定"),
  cancelLabel = T("取消"),
  danger = false,
  width,
} = {}) {
  return askChoice({
    title,
    message,
    detailLines,
    width,
    buttons: [
      { label: cancelLabel, value: "cancel" },
      { label: okLabel, value: "ok", kind: danger ? "danger" : "primary" },
    ],
  }).then((v) => v === "ok");
}

/** 只读信息窗（替代 alert）：只有一个「关闭」按钮。 */
function showInfoModal({ title, message, detailLines = [], items = null, listTitle = "", width = 640 } = {}) {
  return askChoice({
    title,
    message,
    detailLines,
    items,
    listTitle,
    width,
    buttons: [{ label: T("关闭"), value: "close", kind: "primary" }],
  });
}

/**
 * v2.21：设置弹窗。
 * 目前承载「C 站 API Key 配置 + 实时校验」：
 *   · API Key 输入框（密码态 + 👁 显隐）
 *   · 当前状态行（是否已配置、脱敏展示）
 *   · 「验证」按钮 → POST /config/test（调 C 站 /api/v1/me 鉴权端点）
 *   · 「保存」按钮 → POST /config/set 写回插件自己的 config.json，再刷新状态并自动验证一次
 * Key 只存本机 plugins 配置（user/default/Civitai-LoRA-Rack/config.json），不读取任何外部配置文件。
 */
/**
 * 设置面板里的一张「分组卡片」：标题 + 可选描述 + 内容。
 *
 * v2.23 排版重构：设置项从平铺改成按组卡片，以后加新选项（日志级别、缓存目录、
 * 代理、默认权重……）只要再 append 一张卡片，不用动整体结构与样式：
 *
 *   modal.body.appendChild(settingsSection(T("新分组"), T("说明"), [控件1, 控件2]));
 */
function settingsSection(titleText, descText, children) {
  const inner = [];
  if (descText) inner.push(h("div", { class: "cft-settings-section-desc", text: descText }));
  if (Array.isArray(children)) {
    for (const c of children) if (c) inner.push(c);
  } else if (children) {
    inner.push(children);
  }
  return h("section", { class: "cft-settings-section" }, [
    h("div", { class: "cft-settings-section-title", text: titleText }),
    h("div", { class: "cft-settings-section-body" }, inner),
  ]);
}

/* --------------------------------------- 工作流标签栏修复（v2.27）
 *
 * 背景（已用 CDP 在真实前端 1.55.17/1.55.18 上复现，与本插件无关）：
 *   · 前端把每次「换图」串在一条模块级 promise 链（queueWorkflowLoad）上。
 *     只要有**一次加载永不结算**（fetch 挂住 / 等一个被挡住的弹窗），这条链就永久 pending：
 *       - 之后点任何标签 → 静默排队，不报错、不 toast、画布不动（"点不动"）
 *       - 标签的 × 走 closeWorkflow 里 await 同一个 promise → 连关闭也卡住（"关不掉"）
 *   · 临时工作流（Unsaved Workflow，size === -1，不落盘）被草稿持久化
 *     （Comfy.Workflow.Persist 默认开）在刷新后原样恢复回标签栏。
 *
 * 队列状态是**页面级**的，唯一可靠复位就是重新加载页面。浏览器可以随手开 DevTools
 * 贴脚本，但 ComfyUI Desktop（Electron）经常根本开不出控制台，所以把动作做成按钮。
 */
const CFT_PERSIST_RESTORE_KEY = "cft_restore_persist_after_reload";

function cftWorkflowStore() {
  try {
    return (typeof app !== "undefined" && app && app.extensionManager && app.extensionManager.workflow) || null;
  } catch (e) {
    return null;
  }
}

/** 临时工作流判定：UserFile.isTemporary 等价于 size === -1（从未落盘）。 */
function cftIsTemporaryWorkflow(wf) {
  if (!wf) return false;
  try {
    if (wf.isTemporary === true) return true;
  } catch (e) { /* getter 抛错就退回路径判断 */ }
  const p = String(wf.path || "");
  return !p || /(^|[/\\])Unsaved Workflow( \(\d+\))?\.json$/i.test(p);
}

/** 读取当前标签栏状态（总数 / 临时标签数 / 临时标签列表）。 */
function cftWorkflowTabsInfo() {
  const store = cftWorkflowStore();
  const open = store && Array.isArray(store.openWorkflows) ? store.openWorkflows : [];
  const temps = open.filter(cftIsTemporaryWorkflow);
  return { store, total: open.length, temporary: temps.length, temps };
}

/**
 * 强关临时标签：走 store 版 closeWorkflow —— 同步摘除、不弹「未保存」确认、不走加载队列。
 * 若关掉的正好是画布上那份，顺手把剩下的某个标签画回画布（loadGraphData 绕过队列）。
 */
async function cftCloseTemporaryWorkflows(list) {
  const store = cftWorkflowStore();
  if (!store || !Array.isArray(list) || !list.length) return 0;
  const activeWasStray = list.indexOf(store.activeWorkflow) !== -1;
  let closed = 0;
  for (const wf of list) {
    try {
      await store.closeWorkflow(wf);
      closed++;
    } catch (e) {
      console.warn("[CFT] 关闭临时工作流失败", e);
    }
  }
  if (activeWasStray) {
    try {
      const next = (store.openWorkflows || [])[0];
      if (next) {
        if (!next.isLoaded && !cftIsTemporaryWorkflow(next)) await next.load();
        if (next.activeState) {
          await app.loadGraphData(JSON.parse(JSON.stringify(next.activeState)), true, true, next);
        }
      }
    } catch (e) {
      console.warn("[CFT] 切回其他工作流失败", e);
    }
  }
  return closed;
}

/**
 * 关掉草稿持久化 → 重新加载页面。刷新时草稿不再被恢复，标签栏回到干净状态；
 * 刷新后由 cftRestorePersistSetting() 把开关打开回来（不留下永久副作用）。
 */
async function cftReloadWithoutDrafts(delayMs = 400) {
  try {
    if (typeof app !== "undefined" && app && app.extensionManager && app.extensionManager.setting) {
      await app.extensionManager.setting.set("Comfy.Workflow.Persist", false);
    }
  } catch (e) {
    console.warn("[CFT] 关闭草稿持久化失败", e);
  }
  try { localStorage.setItem(CFT_PERSIST_RESTORE_KEY, "1"); } catch (e) { /* 隐私模式下忽略 */ }
  setTimeout(() => {
    try { location.reload(); } catch (e) { /* 忽略 */ }
  }, delayMs);
}

/** 上一次「清理草稿并重新加载」留下的标记：刷新后把草稿持久化打开回来。 */
function cftRestorePersistSetting() {
  let marked = false;
  try { marked = localStorage.getItem(CFT_PERSIST_RESTORE_KEY) === "1"; } catch (e) { return; }
  if (!marked) return;
  try { localStorage.removeItem(CFT_PERSIST_RESTORE_KEY); } catch (e) { /* 忽略 */ }
  try {
    app.extensionManager.setting.set("Comfy.Workflow.Persist", true);
  } catch (e) {
    console.warn("[CFT] 恢复草稿持久化失败", e);
  }
}

/* ------------------------------------- 标签 × 兜底（v2.28）
 *
 * 用户环境里偶发「点标签上的 × 完全没反应，连确认框都不弹」：前端
 * `useWorkflowService().closeWorkflow` 在弹确认 / 走队列那一步卡住时，这次点击就被静默吞掉。
 * 与其让用户每次去设置里点按钮，不如在点击处兜底：
 *   点完 1s / 2.8s 各查一次 —— 标签还在、且**没有对话框在等用户回答**，就直接用 store 版
 *   closeWorkflow 关掉，并 toast 说明（含"未保存改动已丢弃"）。
 * 有确认框在的时候绝不代答，避免吞掉用户的选择。
 */
const CFT_TAB_GUARD_DELAYS = [1000, 2800];

/** 当前是否有前端原生对话框在等用户回答（插件自己的窗不算）。 */
function cftOverlayBusy() {
  try {
    const nodes = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (const n of nodes) {
      if (n.closest && n.closest(".cft-modal")) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 40 && r.height > 20) return true;
    }
  } catch (e) { /* 忽略 */ }
  return false;
}

/** 按 path 强关某个标签（复用 cftCloseTemporaryWorkflows：active 是它时会顺手换图）。 */
async function cftForceCloseTabPath(path) {
  const store = cftWorkflowStore();
  if (!store || !path) return false;
  const wf = (store.openWorkflows || []).find((w) => w.path === path);
  if (!wf) return false;
  await cftCloseTemporaryWorkflows([wf]);
  return true;
}

/* ------------------------------------------------- 旧扩展兼容垫片（v2.29） */

const CFT_LEGACY_SHIM_FLAG = "__CFT_LEGACY_NODE_API_SHIM__";

/**
 * 部分第三方扩展会在 `node.onResize` 里调用 `this.requestVueRedraw()`。
 * 这里的 `this` 是 node（LGraphNode），而这个方法只存在于扩展自己的
 * canvas 包装类上 —— 于是 `LGraphNode.prototype` 上根本没有该符号，
 * 调用直接抛 `TypeError: this.requestVueRedraw is not a function`。
 * （注意：ComfyUI 前端从未在 LGraphNode 上提供过这个方法，
 *  不是「某版本删掉了」，而是扩展把 this 指错了对象。）
 *
 * 而 `onResize` 会被 `loadGraphData()` 里的 `setSize()` 触发 —— 一旦抛错，
 * 整个 `loadGraphData` 直接 reject，后面的 `afterLoadNewGraph()` 根本不会执行，
 * 于是 `store.openWorkflow()` 也没被调用：
 * **画布换成了新工作流，但导航栏不会多出标签**（工作流也没被登记为“已打开”）。
 * 同一个错误也会让「点标签换图」「× 关闭」看起来像点了没反应。
 *
 * 这里补一个空实现（只把画布标脏重绘），把这类写错的旧扩展重新接回加载链路。
 * 它只是**兜底**：真正的修复是在扩展里把 `this` 改成 `self`。
 * 只在该方法缺失时安装，已存在则完全不动。
 */
function cftInstallLegacyNodeApiShims() {
  try {
    const LGN = globalThis.LGraphNode;
    if (!LGN || !LGN.prototype) return false;
    if (typeof LGN.prototype.requestVueRedraw === "function") return false;
    if (globalThis[CFT_LEGACY_SHIM_FLAG]) return false;
    globalThis[CFT_LEGACY_SHIM_FLAG] = true;
    LGN.prototype.requestVueRedraw = function cftRequestVueRedrawShim() {
      try {
        if (typeof this.setDirtyCanvas === "function") this.setDirtyCanvas(true, true);
      } catch (e) { /* 忽略 */ }
      try {
        const g = this.graph;
        if (g && typeof g.setDirtyCanvas === "function") g.setDirtyCanvas(true, true);
      } catch (e) { /* 忽略 */ }
    };
    console.warn(
      "[CFT] 检测到扩展在 LGraphNode 上调用 requestVueRedraw（前端无此 API，" +
        "通常是扩展把 this 指错了对象），已补兼容空实现" +
        "（否则会让工作流加载中断、标签不出现）"
    );
    return true;
  } catch (e) {
    return false;
  }
}

/** 在 document 上装一次点击兜底（capture 阶段，先于前端自己的处理不被阻断）。 */
function cftInstallTabCloseGuard() {
  if (globalThis.__CFT_TAB_GUARD__) return;
  globalThis.__CFT_TAB_GUARD__ = true;
  document.addEventListener(
    "click",
    (ev) => {
      const el = ev.target;
      const btn = el && el.closest ? el.closest("button.close-button") : null;
      if (!btn) return;
      const tab = btn.closest('[data-testid="workflow-tab"], .workflow-tab');
      const path = tab && tab.dataset ? tab.dataset.workflowPath : "";
      if (!path) return;
      const delays = Array.isArray(globalThis.__CFT_TAB_GUARD_DELAYS__)
        ? globalThis.__CFT_TAB_GUARD_DELAYS__
        : CFT_TAB_GUARD_DELAYS;
      // 只要这一次点击期间弹出过原生对话框（哪怕用户后来点了「取消」），就彻底放手：
      // 用户已经在做选择，兜底绝不能替他决定。
      let sawDialog = false;
      for (const d of delays) {
        setTimeout(async () => {
          try {
            if (sawDialog) return;
            const stillThere = Array.from(document.querySelectorAll(".workflow-tab")).some(
              (n) => n.dataset && n.dataset.workflowPath === path
            );
            if (!stillThere) return;            // 前端自己关掉了，不干预
            if (cftOverlayBusy()) {             // 有确认框在等用户，别抢答
              sawDialog = true;
              return;
            }
            const ok = await cftForceCloseTabPath(path);
            if (!ok) return;
            globalToast(T("标签 × 没生效，已强制关闭「{0}」（未保存的改动已丢弃）", 
              path.replace(/^workflows\//, "").replace(/\.json$/i, "")));
          } catch (e) {
            console.warn("[CFT] 标签兜底关闭失败", e);
          }
        }, d);
      }
    },
    true
  );
}

function openSettings() {
  const modal = new Modal({
    title: T("设置"),
    width: 540,
    height: 0,
    className: "cft-settings-modal",
    floating: false,
    resizable: false,
    singletonKey: "cft-settings",
  });

  modal.onOpen = async () => {
    // Modal.open() 已先跑过 _applyGeom（会把 0 写成 "0px"），这里覆盖成自适应高度
    modal.root.style.height = "auto";
    modal.root.style.maxHeight = "88vh";

    // 标题也跟着语言实时切换（Modal 标题在构造时定死，不重渲染，这里补一刀）
    modal.titleEl.textContent = T("设置");

    modal.body.innerHTML = "";

    // —— v2.23 排版重构：设置项按分组卡片组织 ——
    //
    //   当前两组：① 语言  ② C 站 API Key
    //   以后加选项就往下面继续 appendChild 一张 settingsSection(...)，
    //   不用改面板骨架与 CSS。

    // 分组 ①：语言（中文 / English 即时切换，已打开窗口同步重渲染）
    //   分组标题已经写「语言」，行内不再重复放 label。
    const langRow = h("div", { class: "cft-settings-langrow" }, [
      h("button", {
        class: "cft-btn" + (LANG === "zh" ? " cft-btn-primary" : ""),
        text: T("中文"),
        onClick: () => setLang("zh"),
      }),
      h("button", {
        class: "cft-btn" + (LANG === "en" ? " cft-btn-primary" : ""),
        text: T("English"),
        onClick: () => setLang("en"),
      }),
    ]);
    modal.body.appendChild(
      settingsSection(T("语言"), T("界面语言。切换后立即在所有已打开的窗口生效，并记忆到本机。"), [langRow])
    );

    // 当前配置状态（强制刷新，确保拿到最新）
    let status = {};
    try {
      status = (await Store.config(true)) || {};
    } catch {
      status = {};
    }
    const hasKey = Boolean(status.has_api_key);
    const masked = status.api_key_masked || "";

    const statusLine = h(
      "div",
      { class: "cft-api-status " + (hasKey ? "cft-api-status-ok" : "cft-api-status-idle") },
      [T("当前状态："), hasKey ? T("已配置（") + masked + T("）") : T("未配置")]
    );

    const input = h("input", {
      class: "cft-settings-input",
      type: "password",
      // 已有 Key 时明确提示「留空不改动」，避免用户以为留空=清空（v2.26）
      placeholder: hasKey
        ? T("已保存 Key（留空不会改动；粘贴新 Key 才会覆盖）")
        : T("在此粘贴你的 C 站 API Key"),
      autocomplete: "off",
      spellcheck: "false",
    });
    const revealBtn = h("button", {
      class: "cft-icon-btn cft-settings-reveal",
      text: "👁",
      title: T("显示 / 隐藏"),
      onClick: () => {
        input.type = input.type === "password" ? "text" : "password";
      },
    });

    const resultLine = h("div", {
      class: "cft-api-status cft-api-status-idle",
      text: T("填写后点「验证」测试 Key 是否有效。"),
    });

    // 已有 Key 时才显示「清除 API Key」——删除必须是显式动作（v2.26）
    let hasKeyNow = hasKey;
    const clearBtn = h("button", {
      class: "cft-btn cft-btn-danger cft-settings-clear",
      text: T("清除 API Key"),
      onClick: async () => {
        const ok = await askConfirm({
          title: T("清除 API Key"),
          message: T("确定要清除已保存的 C 站 API Key 吗？清除后，NSFW / 登录限定内容将无法查看。"),
          okLabel: T("清除"),
          danger: true,
          width: 480,
        });
        if (!ok) return;
        try {
          await apiPost("/config/set", { api_key: "" });
          Store._config = null;
          input.value = "";
          await refreshStatus();
          setResult("idle", T("已清空 API Key。"));
          modal.toast(T("已清空 API Key"));
        } catch (e) {
          modal.toast(T("清除失败：") + (e.message || e), true);
        }
      },
    });
    const clearRow = h("div", { class: "cft-settings-dangerrow" }, [clearBtn]);
    clearRow.style.display = hasKeyNow ? "" : "none";

    // 分组 ②：C 站 API Key
    //   「验证 / 保存」两颗按钮属于这张卡片（v2.30 从弹窗 footer 移进来），
    //   所以先把卡片建出来，按钮构造完再 appendChild 进去。
    const apiSection = settingsSection(T("C 站 API Key"), null, [
        h("div", {
          class: "cft-settings-tip",
          text: T(
            "填写 C 站 API Key 后，可拉取 NSFW / 年龄验证内容，以及登录用户专享的模型版本与资源（部分内容需进 C 站站内才看得到）。"
          ),
        }),
        h("div", {
          class: "cft-settings-tip cft-settings-tip-dim",
          text: T("Key 保存在本机 user/default/Civitai-LoRA-Rack/config.json 的 api_key 字段，不会上传，仅本机生效。"),
        }),
        statusLine,
        h("div", { class: "cft-settings-keyrow" }, [input, revealBtn]),
        resultLine,
        clearRow,
      ]);
    modal.body.appendChild(apiSection);

    const setResult = (kind, text) => {
      resultLine.className = "cft-api-status cft-api-status-" + kind;
      resultLine.textContent = text;
    };

    const doTest = async (keyToTest) => {
      setResult("pending", T("正在验证…"));
      try {
        const res = await apiPost("/config/test", { api_key: keyToTest });
        const d = res.data || {};
        if (d.ok) {
          setResult("ok", T("✓ 有效 · 账号 ") + (d.username || "—") + (d.tier ? " · " + d.tier : ""));
        } else {
          setResult("err", "✗ " + (d.message || d.reason || T("无效")));
        }
      } catch (e) {
        setResult("err", T("✗ 验证失败：") + (e.message || e));
      }
    };

    const refreshStatus = async () => {
      let st = {};
      try {
        st = (await Store.config(true)) || {};
      } catch {
        st = {};
      }
      const hk = Boolean(st.has_api_key);
      hasKeyNow = hk;
      statusLine.className = "cft-api-status " + (hk ? "cft-api-status-ok" : "cft-api-status-idle");
      statusLine.textContent = T("当前状态：") + (hk ? T("已配置（") + (st.api_key_masked || "") + T("）") : T("未配置"));
      // 占位提示与「清除」按钮跟着实际状态走
      input.placeholder = hk
        ? T("已保存 Key（留空不会改动；粘贴新 Key 才会覆盖）")
        : T("在此粘贴你的 C 站 API Key");
      clearRow.style.display = hk ? "" : "none";
      return st;
    };

    // v2.30：「验证 / 保存」属于上面那张 API 卡片，直接挂进卡片末尾，
    // 弹窗 footer 因此不再有任何按钮 —— 隐藏掉，避免底部留一条空的白条。
    modal.footer.innerHTML = "";
    modal.footer.style.display = "none";
    const testBtn = h("button", {
      class: "cft-btn",
      text: T("验证"),
      onClick: async () => {
        await doTest(input.value.trim());
      },
    });
    const saveBtn = h("button", {
      class: "cft-btn cft-btn-primary",
      text: T("保存"),
      onClick: async () => {
        const v = input.value.trim();
        // 空白保存**绝不**写入配置（v2.26）：以前这里会把空串写进去 = 静默删掉已存的 Key。
        // 现在只提示，删除必须走「清除 API Key」按钮。
        if (!v) {
          setResult(
            "idle",
            hasKeyNow
              ? T("未填写 API Key。已保存的 Key 不会被改动；要清除请点「清除 API Key」。")
              : T("请先填写 API Key 再保存。")
          );
          modal.toast(T("未填写 API Key，已保存的 Key 未改动"));
          return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = T("保存中…");
        try {
          await apiPost("/config/set", { api_key: v });
          Store._config = null;
          await refreshStatus();
          // 存完清空输入框：下一个动作无论是再填还是点「验证」（空值会验已存的 Key）都符合直觉
          input.value = "";
          await doTest(v);
          modal.toast(T("已保存并验证"));
        } catch (e) {
          modal.toast(T("保存失败：") + (e.message || e), true);
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = T("保存");
        }
      },
    });
    // 「验证」在左、「保存」在右，整体贴卡片右下角
    apiSection.appendChild(
      h("div", { class: "cft-settings-btnrow cft-settings-apibtnrow" }, [testBtn, saveBtn])
    );
  };

  modal.open();
}

/* ------------------------------------------------- 共享操作：定位 / 删除 */

/** 跳转到文件管理器并选中该文件。 */
async function revealLora(loraName, toastFn, mode = "select") {
  try {
    const res = await Store.reveal(loraName, mode);
    toastFn?.(mode === "folder" ? T("已打开所在文件夹") : T("已在文件管理器中定位"));
    return res;
  } catch (err) {
    toastFn?.(String(err.message || err), true);
    return null;
  }
}

/**
 * 本地删除某个 lora 及其伴生图片 / 信息文件。
 *
 * 流程刻意做成三步：先看清单 → 再选隔离/永久 → 最后确认。
 * 这是不可逆操作，不能一个 confirm 就直接删。
 *
 * @param {string} loraName
 * @param {(msg:string, err?:boolean)=>void} toastFn
 * @param {() => void} onDone 删除完成后的回调（刷新列表）
 * @param {boolean} inStack 该 lora 是否在当前堆里（决定是否顺带从堆移除）
 */
async function deleteLoraLocal(loraName, toastFn, onDone, inStack = false) {
  let bundle;
  try {
    bundle = await Store.bundle(loraName);
  } catch (err) {
    toastFn?.(String(err.message || err), true);
    return null;
  }
  if (!bundle) {
    toastFn?.(T("找不到该 Lora 的本地文件"), true);
    return null;
  }

  const pick = await askChoice({
    title: T("本地删除确认"),
    width: 680,
    message: T("即将处理「{0}」的以下 {1} 个本地文件（合计 {2}）", bundle.lora, bundle.files.length, fmtBytes(bundle.size)),
    listTitle: T("文件清单"),
    items: bundle.files.map((f) => ({
      name: f.name,
      size: fmtBytes(f.size),
      kindLabel: f.kind === "lora" ? T("模型本体") : "",
    })),
    buttons: [
      { label: T("移到隔离区（推荐）"), value: "quarantine", kind: "primary" },
      { label: T("彻底删除（不可还原）"), value: "permanent", kind: "danger" },
      { label: T("取消"), value: "cancel" },
    ],
  });
  if (pick === null || pick === "cancel") return null;

  const permanent = pick === "permanent";
  // 隔离可还原，不必二次确认；彻底删除不可逆，必须再确认一次。
  if (permanent) {
    const sure = await askConfirm({
      title: T("最后确认"),
      message: T("彻底删除「{0}」的 {1} 个文件（{2}）。", bundle.lora, bundle.files.length, fmtBytes(bundle.size)),
      detailLines: [T("⚠️ 彻底删除后无法还原。")],
      okLabel: T("彻底删除"),
      danger: true,
      width: 520,
    });
    if (!sure) return null;
  }

  try {
    const res = await Store.deleteLocal(loraName, { includeBody: true, permanent });
    if (!res.ok && !res.removed) {
      toastFn?.(res.error || T("删除失败"), true);
      return null;
    }
    const freed = fmtBytes(res.freed || 0);
    const msg = permanent
      ? T("已彻底删除 {0} 个文件，释放 {1}", res.removed, freed)
      : T("已移到隔离区（可在清理窗口的「打开隔离区」里还原）{0} 个文件，释放 {1}", res.removed, freed);
    if (res.failed) toastFn?.(T("{0}（{1} 个失败）", msg, res.failed), true);
    else toastFn?.(msg);
    onDone?.(res, inStack);
    return res;
  } catch (err) {
    toastFn?.(String(err.message || err), true);
    return null;
  }
}

/** 本地文件清单只读窗口（右键菜单「查看本地文件」用）。 */
async function showLocalFiles(loraName, toastFn) {
  let bundle;
  try {
    bundle = await Store.bundle(loraName);
  } catch (err) {
    toastFn?.(String(err.message || err), true);
    return null;
  }
  if (!bundle) {
    toastFn?.(T("找不到该 Lora 的本地文件"), true);
    return null;
  }
  const kindLabel = {
    lora: T("模型本体"),
    preview: T("预览图"),
    civitai: T("C 站信息"),
    info: T("基本信息"),
    hash: T("哈希缓存"),
  };
  await showInfoModal({
    title: T("本地文件清单"),
    message: T("{0}\n所在目录：{1}\n合计 {2} 个文件 / {3}", bundle.lora, bundle.dir, bundle.files.length, fmtBytes(bundle.size)),
    listTitle: T("文件清单"),
    items: bundle.files.map((f) => ({
      name: f.name,
      size: fmtBytes(f.size),
      kindLabel: kindLabel[f.kind] || f.kind || "",
    })),
    width: 680,
  });
  return bundle;
}

/* -------------------------------------------------------- 单例打开入口 */

/**
 * 打开 LoRA 堆面板（**按节点**单例，v2.15）：
 * 同一个节点再点一次只聚焦已有窗口，不会开第二个；
 * 不同节点各开各的、各自对应自己的节点（以前是全局单例：
 * 开 B 节点的堆会把 A 节点的堆窗口关掉，两个节点没法对照着调）。
 */
function openStackManager(node) {
  const key = "stack:" + (node?.id ?? "0");
  const prev = OPEN_MODALS.get(key);
  if (prev && prev._opened) {
    prev.focus();
    return prev;
  }
  const modal = new StackManagerModal(node);
  modal.open();
  return modal;
}

/** 打开 Lora 详情（**按 lora** 单例，v2.15）：同一个 lora 只开一个窗口。 */
function openDetailModal(loraName, onChange) {
  const key = "detail:" + loraName;
  const prev = OPEN_MODALS.get(key);
  if (prev && prev._opened) {
    // 复用已有窗口时把新的父窗口回调也挂上（详情窗可能先被选择器打开、
    // 再被堆窗口打开，两个窗口都得能在关窗 / 刷新后同步自己的卡片）
    if (typeof onChange === "function") prev._changeCbs?.add(onChange);
    prev.focus();
    return prev;
  }
  return new DetailModal(loraName, onChange).open();
}

/** 打开清理窗口（全局单例）：从堆面板/选择器/节点面板都能进。 */
function openCleanup(parent) {
  const key = "cleanup";
  const prev = OPEN_MODALS.get(key);
  if (prev && prev._opened) {
    if (parent) prev.parent = parent;
    prev.focus();
    return prev;
  }
  const modal = new CleanupModal(parent);
  modal.open();
  return modal;
}

/** 打开隔离区窗口（全局单例）：从清理窗口进。 */
function openTrash(parent) {
  const prev = OPEN_MODALS.get("trash");
  if (prev && prev._opened) {
    prev.focus();
    return prev;
  }
  return new TrashModal(parent).open();
}

/** 打开 Lora 选择器（每个 node 一个单例）。 */
function openPicker(node, onPick) {
  const key = "picker:" + (node?.id ?? "0");
  const prev = OPEN_MODALS.get(key);
  if (prev && prev._opened) {
    prev.focus();
    return prev;
  }
  const modal = new PickerModal(node, onPick);
  modal.open();
  return modal;
}

/* ------------------------------------------------------- 节点内嵌控制面板 */

function ensureNodeWidth(node, minWidth) {
  try {
    if ((node.size?.[0] || 0) < minWidth) {
      node.setSize([minWidth, node.size?.[1] || 120]);
    }
  } catch { /* 忽略 */ }
}

function refreshNodePanel(node) {
  const state = getState(node);
  if (state.panelEl) renderNodePanel(node, state);
}

/**
 * 节点内嵌面板的高度语义（v2.16 修正 v2.14 的错向）。
 *
 * **高度是用户给的输入，不是插件算出来的输出。**
 * 用户把节点拖多高，面板就吃多高，列表里能看到几条由这个高度决定
 * （矮了自动出滚动条），插件**不主动改节点高度**。
 *
 * 为什么必须这么写，看 LiteGraph 的 `LGraphNode._arrangeWidgets()`：
 *
 * ```
 * for (const w of visibleWidgets) {
 *   if (w.computeSize) {            // ← 第一分支：固定高度，直接占坑
 *     w.computedHeight = w.computeSize()[1] + 4
 *   } else if (w.computeLayoutSize) { // ← 第二分支：可伸缩，参与分空间
 *     growableWidgets.push(...)
 *   }
 * }
 * ...
 * const allocations = distributeSpace(freeSpace, spaceRequests)  // maxHeight 未设 = Infinity
 * ```
 *
 * 也就是说：**只要给 DOM widget 赋了 `computeSize`，它就被当成固定高度 widget**，
 * 节点再拖高也不会多分它一个像素；反过来把 `getMinHeight` 设成"我算出来的高度"，
 * 等于强制节点至少这么高 —— 两个方向都会把面板钉死，用户的拖动完全不起作用。
 * v2.14 正是同时踩了这两条（`dw.computeSize = () => [w, panelHeight]` +
 * `getMinHeight: () => panelHeight`），才出现「节点被插件牵着长、拖高又没反应」。
 *
 * 正确姿势（本文件现在的写法）：
 * - **绝不**给 domWidget 设 `computeSize`
 * - `getMinHeight` 返回一个**小常量**（够放 header + 一行）
 * - **不设** `getMaxHeight`（= Infinity = 吃满节点剩余空间）
 * - 面板内部 flex：header 固定、列表 `flex:1; min-height:0; overflow-y:auto`
 */

/** 面板能缩到的最小高度：约 header + 1 行。这是下限，不是"想要的高度"。 */
const NP_MIN_HEIGHT = 96;

/** 新建节点时的默认高度（约 3 行）。之后完全由用户拖动决定，插件不再碰。 */
const NP_DEFAULT_HEIGHT = 200;

/**
 * 面板一次最多渲染多少行 —— 纯粹是防极端堆（几百条）把 DOM 撑爆，
 * **不是**"显示条数上限"：常见的十几二十条全部渲染，靠滚动看全。
 */
const NP_RENDER_MAX = 200;

function renderNodePanel(node, state) {
  const panel = state.panelEl;
  if (!panel) return;
  panel.innerHTML = "";

  const entries = readStack(node);
  state.entries = entries;

  const header = h("div", { class: "cft-np-header" }, [
    h("span", { class: "cft-np-count", text: T("CLR - LoRA 加载器 · {0}", entries.length) }),
    h("span", { class: "cft-np-active", text: entries.length ? T("{0} 生效", entries.filter((e) => !e.hidden).length) : "" }),
    h("div", { class: "cft-spacer" }),
    h("button", { class: "cft-np-btn", text: T("管理"), title: T("打开 LoRA 堆面板"), onClick: () => openStackManager(node) }),
    h("button", {
      class: "cft-np-btn cft-np-add",
      text: T("＋"),
      title: T("添加 Lora"),
      onClick: () => {
        openPicker(node, (picked) => {
          const list = readStack(node);
          const exist = new Set(list.map((e) => e.lora));
          for (const item of picked) {
            if (exist.has(item.lora)) continue;
            const entry = normalizeEntry({
              lora: item.lora, name: item.name, display_name: item.display_name,
              weight: 1, text_encoder_weight: 1,
              trigger_weight: item.trained_words?.length ? 1 : 0,
            });
            entry._meta = item;
            list.push(entry);
          }
          writeStack(node, list);
          renderNodePanel(node, state);
        });
      },
    }),
  ]);
  panel.appendChild(header);

  // 备份恢复横幅：只在「刚从本机备份补回来」时出现，用户一动堆就撤掉（v2.13）
  if (state.restoredN) {
    panel.appendChild(
      h("div", { class: "cft-np-restored", title: T("工作流当时没保存，数据是从本机备份里找回来的") }, [
        h("span", { text: T("⚠ 已从本机备份恢复 {0} 条", state.restoredN) }),
        h("button", { class: "cft-np-btn", text: "✕", title: T("知道了"), onClick: () => { state.restoredN = 0; renderNodePanel(node, state); } }),
      ])
    );
  }

  // 高度不再由这里算 —— 面板吃满 DOM widget 分到的高度（见 NP_MIN_HEIGHT 上方的说明），
  // 列表用 flex 撑开、超出就滚动，所以"能看到几条"天然跟着用户拖出来的节点高度走。

  if (!entries.length) {
    panel.appendChild(h("div", { class: "cft-np-empty", text: T("空 · 点「＋」添加 Lora") }));
  } else {
    const list = h("div", { class: "cft-np-list" });
    // 列表高度交给 CSS：flex:1 + min-height:0 + overflow-y:auto。
    // 这里**不设**内联 max-height —— 一旦写死，列表就不跟节点高度走了。
    // 滚轮要自己吃掉：不然会冒泡到画布上变成「缩放画布」，列表滚不动
    list.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    const shown = entries.slice(0, NP_RENDER_MAX);
    // 同名副本索引（整份展示缓存算一次）：面板窄，命中时只给名字加个 cft-dup 类，不加 chip
    const npDupIndex = buildDupIndex([...META_CACHE.values()]);
    shown.forEach((entry) => {
      const meta = entry._meta || {};
      // v2.15：走单例入口 —— 同一个 lora 重复点只聚焦，不会开出第二个详情窗
      const openDetail = () => openDetailModal(entry.lora, () => onDetailRefreshed(node, state));
      const npMedia = coverMedia({ ...meta, lora: entry.lora });
      const npDupGroup = npDupIndex.get(dupKeyOf({ ...meta, lora: entry.lora })) || null;

      // 权重：只留一个可编辑数字输入框（无 min/max，任意实数）
      const weightInput = h("input", {
        type: "number",
        class: "cft-np-weight",
        step: 0.05,
        value: entry.weight,
        title: T("权重（可输入任意实数）"),
        onChange: (e) => {
          entry.weight = parseWeight(e.target.value, entry.weight);
          e.target.value = entry.weight;
          writeStack(node, entries);
          refreshNodePanel(node);
        },
      });

      // 缩略图也支持点击查看详情（此前缺失，是「点 Lora 没反应」的入口之一）
      const img = makeThumb({ ...meta, lora: entry.lora }, "cft-np-thumb", {
        title: (npMedia.kind === "video" ? T("视频封面 · ") : "") + T("点击查看 C 站详情"),
        onClick: openDetail,
      });

      // 节点面板 / 堆窗口没有「选中」这个概念（条目已经在堆里了），
      // 所以这里的名字仍然可以点开详情；「只有封面/ⓘ 开详情」那条规则
      // 针对的是「＋ 添加 Lora」选择器（那里其余位置是选中）。
      const npRow = h("div", { class: `cft-np-row${entry.hidden ? " cft-disabled" : ""}` }, [
        img,
        h("span", {
          class: `cft-np-name${npDupGroup ? " cft-dup" : ""}`,
          text: entry.display_name || entry.name,
          title: `${entry.lora}\n${meta.creator ? T("作者") + ": " + meta.creator : ""}\n${meta.base_model ? T("基座模型") + ": " + meta.base_model : ""}${npDupGroup ? "\n" + T("（同名副本 {0} 个，用文件名区分）", npDupGroup.length) : ""}`,
          onClick: openDetail,
        }),
        weightInput,
        h("label", { class: "cft-switch cft-switch-mini", title: entry.hidden ? T("已禁用") : T("已启用") }, [
          h("input", {
            type: "checkbox", checked: !entry.hidden,
            onChange: (e) => {
              entry.hidden = !e.target.checked;
              writeStack(node, entries);
              renderNodePanel(node, state);
            },
          }),
          h("span", { class: "cft-switch-track" }),
        ]),
        h("button", {
          class: "cft-np-del", title: T("移除"), text: "✕",
          onClick: () => {
            const idx = entries.indexOf(entry);
            if (idx >= 0) entries.splice(idx, 1);
            writeStack(node, entries);
            renderNodePanel(node, state);
          },
        }),
      ]);
      // 节点面板里也支持右键菜单（定位 / 本地删除）
      const nodeToast = (msg, err) => {
        try {
          app.extensionManager?.toast?.(String(msg));
        } catch { /* 忽略 */ }
        if (err) console.warn("[Civitai-LoRA-Rack]", msg);
      };
      bindContextMenu(
        npRow,
        () => [
          { label: T("查看 C 站详情"), icon: "ⓘ", onClick: openDetail },
          { sep: true },
          { label: T("跳转到所在文件夹"), icon: "📂", onClick: () => revealLora(entry.lora, nodeToast, "select") },
          { label: T("查看本地文件清单"), icon: "📋", onClick: () => showLocalFiles(entry.lora, nodeToast) },
          { sep: true },
          {
            label: T("本地删除（含图片与信息文件）"),
            icon: "🗑",
            danger: true,
            onClick: () =>
              deleteLoraLocal(entry.lora, nodeToast, () => {
                const arr = readStack(node);
                const at = arr.findIndex((x) => x.lora === entry.lora);
                if (at >= 0) {
                  arr.splice(at, 1);
                  writeStack(node, arr);
                }
                Store.invalidate();
                renderNodePanel(node, state);
              }, true),
          },
        ],
        T("右键：定位文件夹 / 本地删除")
      );
      list.appendChild(npRow);
    });
    if (entries.length > shown.length) {
      list.appendChild(h("div", { class: "cft-np-more", text: T("只渲染前 {0} 条，点「管理」查看全部", shown.length) }));
    }
    panel.appendChild(list);
  }

  // 收尾只要求重绘（面板内容变了），**不改节点尺寸** ——
  // 节点高度是用户的领地，插件只负责在给定高度里把内容排好。
  try {
    node.setDirtyCanvas?.(true, true);
  } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------ 节点初始化 */

function isCFTNode(node) {
  const cls = node?.comfyClass || node?.constructor?.comfyClass || node?.type;
  return cls === NODE_CLASS;
}

function setupNode(node) {
  if (!isCFTNode(node)) return;
  if (NODE_STATE.has(node)) return;

  const state = getState(node);

  // 1) 藏掉原始的 lora_stack 文本框（数据仍由它保存）
  //
  //    注意：只做视觉隐藏，绝不能设置 widget.hidden = true 或从 widgets
  //    数组里摘掉它 —— 否则工作流序列化时这个 widget 的值会丢失，
  //    用户的 LoRA 堆配置就白配了。
  const w = stackWidget(node);
  if (w) {
    const hide = (el) => {
      if (el && el.style) {
        el.style.display = "none";
        el.style.height = "0";
        el.style.minHeight = "0";
      }
    };
    // classic 画布：藏掉 legacy DOM 即可
    hide(w.element);
    hide(w.inputEl);
    w.computeSize = () => [0, -4];
    w.draw = () => {};

    // Vue 节点（nodes 2.0）：Vue **不看** legacy element，它按 widget 自身决定渲不渲染这一行，
    // 于是 legacy 那份藏了、Vue 那份还在，节点内容比逻辑高度高出 70 多 px ——
    // 底部「节点来源」徽章被挤出节点框（v2.35 修）。
    // 只改 options.hidden（不碰 widget.hidden、不动 widgets 数组），序列化照旧走 widgets_values。
    if (w.options && typeof w.options === "object") w.options.hidden = true;

    w.serializeValue = async () => w.value;
  }

  // 2) 节点内嵌面板
  const panelEl = h("div", { class: "cft-node-panel" });
  state.panelEl = panelEl;

  try {
    const dw = node.addDOMWidget("cft_panel", "div", panelEl, {
      serialize: false,
      hideOnZoom: false,
      // 只报一个**小常量下限**（够放 header + 一行），让布局把它当可伸缩 widget：
      // getMinHeight 若返回"算出来的高度"，就等于替用户把节点高度钉死（v2.14 的错）。
      getMinHeight: () => NP_MIN_HEIGHT,
      // 故意不设 getMaxHeight：undefined → distributeSpace 里按 Infinity 处理，
      // 节点拖多高，面板就吃多高。
    });
    state.domWidget = dw;
    // ⚠️ 绝对不要给 dw 赋 computeSize：LGraphNode._arrangeWidgets() 会先看它，
    // 有就按**固定高度**处理，节点再拖高也不会分给它更多空间。
  } catch (err) {
    console.warn(T("[Civitai-LoRA-Rack] addDOMWidget 不受支持，降级为按钮模式"), err);
    const fbBtn = node.addWidget("button", T("打开 LoRA 堆"), "", () => openStackManager(node));
    if (fbBtn) {
      fbBtn._cftI18nKey = "打开 LoRA 堆";
      fbBtn.label = T("打开 LoRA 堆");
    }
  }

  // 3) 打开管理面板按钮（名字按语言重刷，见 applySocketLabels）
  const openBtn = node.addWidget("button", T("🎴 打开 LoRA 堆"), "", () => openStackManager(node));
  if (openBtn) {
    openBtn._cftI18nKey = "🎴 打开 LoRA 堆";
    openBtn.label = T("🎴 打开 LoRA 堆");
  }

  ensureNodeWidth(node, 340);

  // 3.5) 新建节点的默认高度（约 3 行）。只在"比默认还矮"时抬一次 ——
  //      这是**初始尺寸**，不是按条目数算出来的；加载工作流时 configure
  //      随后会用保存的尺寸覆盖，用户调好的高度不会被吃掉。
  try {
    if (!node.size || (node.size[1] || 0) < NP_DEFAULT_HEIGHT) {
      node.setSize([node.size?.[0] || 340, NP_DEFAULT_HEIGHT]);
    }
  } catch { /* 忽略 */ }

  // 4) 首次渲染 + 载入元数据
  //
  //    这里**故意不做**备份恢复：nodeCreated 对「用户新建节点」和
  //    「加载工作流」一视同仁地触发，而备份 key 是按 node id 存的，
  //    新工作流的节点 id 常从 1 开始 → 一视同仁地恢复会把另一份工作流
  //    的堆凭空填进新节点（QA 实测撞号）。恢复只放在 loadedGraphNode /
  //    onConfigure 这两条「确实是从工作流里加载出来的」路径上（v2.13）。
  renderNodePanel(node, state);
  hydrateMeta(node, state);

  // 6) 工作流加载后同步（configure 会用保存值覆盖 widget，之后再补一次备份）
  const origConfigure = node.onConfigure;
  node.onConfigure = function (info) {
    origConfigure?.apply(this, arguments);
    setTimeout(() => {
      const n = restoreStackFromBackup(node);
      if (n > 0) globalToast(T("已从本机备份恢复 {0} 条 Lora（工作流里存的是空堆）", n));
      renderNodePanel(node, state);
      hydrateMeta(node, state);
    }, 60);
  };
}

/**
 * 详情窗「↻ 从 C 站刷新」成功后的节点面板回调：
 * 重新扫描并把新元数据写回 entry._meta，再重绘节点面板。
 * 不这样做的话，节点面板上的作者/缩略图会一直用旧快照。
 */
async function onDetailRefreshed(node, state) {
  Store.invalidate();
  try {
    const list = await Store.list(true);
    const map = new Map((list.items || []).map((i) => [i.lora, i]));
    for (const e of readStack(node)) {
      const fresh = map.get(e.lora);
      if (fresh && isMissingMeta(e._meta)) { e._meta = fresh; META_CACHE.set(e.lora, fresh); }
    }
  } catch { /* 静默：详情窗自身已刷新 */ }
  renderNodePanel(node, state);
}

/** 异步补齐当前堆里每条 lora 的元数据（用于展示作者/基座/缩略图）。 */
async function hydrateMeta(node, state) {
  const entries = readStack(node);
  if (!entries.length) return;

  // 先尝试用已缓存的列表信息填充
  let listData = null;
  try {
    listData = await Store.list();
  } catch { /* 静默 */ }

  if (listData) {
    const map = new Map(listData.items.map((i) => [i.lora, i]));
    let changed = false;
    for (const e of entries) {
      const fresh = map.get(e.lora);
      if (!fresh) continue;
      // 没有元数据 → 补；有但「缺 C 站信息」而新扫描结果有 → 也补（修旧快照卡住的问题）
      if (!e._meta || (isMissingMeta(e._meta) && !isMissingMeta(fresh))) {
        e._meta = fresh;
        META_CACHE.set(e.lora, fresh);
        changed = true;
      }
    }
    if (changed) renderNodePanel(node, state);
  }

  // 仍未命中的，走单条详情接口
  const missing = entries.filter((e) => isMissingMeta(e._meta));
  for (const e of missing.slice(0, 40)) {
    try {
      const d = await Store.detail(e.lora, false);
      if (d && d.lora) {
        e._meta = {
          ...d,
          display_name: d.display_name || d.name,
          base_model: d.base_model || "",
          creator: d.creator || "",
          tags: d.tags || [],
          trained_words: d.trained_words || [],
          downloads: d.downloads,
          url: d.url || "",
          version_name: (d.civitai || {}).version_name || "",
        };
        META_CACHE.set(e.lora, e._meta);
        renderNodePanel(node, state);
      }
    } catch { /* 单条失败不影响整体 */ }
  }
}

/* ------------------------------------------------------------ 节点插槽名显示翻译（v2.23）
 *
 * 截图反馈：节点上的插槽名中英混合（输入 model/clip 是英文，输出 CLIP/模型/触发词
 * 混着来）。这里按当前语言给插槽 / 参数行 / 节点标题套一层**纯显示**的 label：
 *
 *   - 绝不动 input.name / widget.name / RETURN_NAMES —— 后端 kwargs、工作流序列化、
 *     连线全靠它们；前端只设 `label`（litegraph 画插槽时取 slot.label ?? slot.name，
 *     ComfyUI 1.55 前端画参数行取 widget.label ?? widget.name，均已实证）。
 *   - label 只做显示覆盖，不进序列化协议 → **不用重启 ComfyUI，刷新页面即生效**；
 *     后端 RETURN_NAMES 是什么（含旧版「模型」）都不影响，名称按 key 匹配。
 *   - 标题只在「是已知默认名之一」时覆盖，用户自己改过的节点名绝不碰。
 */

/** 插槽名 → 各语言显示名。key 一律用后端真实名（含旧版 RETURN_NAMES 兜底）。 */
const SOCKET_LABELS = {
  input: {
    model: { zh: "模型", en: "model" },
    clip: { zh: "CLIP", en: "clip" },
    reset_cache: { zh: "重置缓存", en: "reset_cache" },
    lora_name: { zh: "Lora 名称", en: "lora_name" },
    strength_model: { zh: "模型强度", en: "strength_model" },
    strength_clip: { zh: "CLIP 强度", en: "strength_clip" },
  },
  output: {
    CLIP: { zh: "CLIP", en: "CLIP" },
    MODEL: { zh: "模型", en: "MODEL" },
    "触发词": { zh: "触发词", en: "Trigger Words" },
    "模型": { zh: "模型", en: "MODEL" }, // 旧版后端 RETURN_NAMES 兜底
    "Trigger Words": { zh: "触发词", en: "Trigger Words" },
  },
};

/** 节点标题（仅当当前标题是这里的默认名之一才覆盖，别动用户改过的名字）。 */
const NODE_TITLES = {
  [NODE_CLASS]: { zh: "CLR - LoRA 加载器", en: "Civitai LoRA Rack (CLR)" },
  [NODE_CLASS_LOADER]: { zh: "CLS - 单条 LoRA 加载", en: "Civitai LoRA Slot (CLS)" },
};

/**
 * v2.31 之前的默认标题。旧工作流里这些名字可能已被序列化进 `node.title`，
 * 若不当成「默认名」白名单，打开旧图会一直显示老名字（以为改名没生效）。
 * 只放历史默认名 —— 用户自己起的名字依然不会被覆盖。
 */
const LEGACY_NODE_TITLES = {
  [NODE_CLASS]: ["CFT Lora堆", "CFT Lora Stack"],
  [NODE_CLASS_LOADER]: ["CFT Lora加载器", "CFT Lora Loader"],
};

/** applySocketLabels 打过的标记：换语言重复调用时只覆盖自己设过的 label。 */
function _cftApplySlotLabel(slot, map, isOutput) {
  const m = map && map[slot.name];
  if (!m) return false;
  const want = m[getLang()];
  if (slot._cftLabeled && slot.label === want) return false;
  slot.label = want;
  slot._cftLabeled = true;
  return true;
}

/**
 * 给一个 CFT 节点套上当前语言的插槽 / 参数 / 标题显示名。
 * @returns {boolean} 是否有改动（调用方据此决定要不要重绘）
 */
function applySocketLabels(node) {
  const cls = node?.comfyClass || node?.constructor?.comfyClass || node?.type;
  if (cls !== NODE_CLASS && cls !== NODE_CLASS_LOADER) return false;
  let changed = false;
  for (const inp of node.inputs || []) {
    changed = _cftApplySlotLabel(inp, SOCKET_LABELS.input, false) || changed;
  }
  for (const out of node.outputs || []) {
    changed = _cftApplySlotLabel(out, SOCKET_LABELS.output, true) || changed;
  }
  for (const w of node.widgets || []) {
    changed = _cftApplySlotLabel(w, SOCKET_LABELS.input, false) || changed;
    // 客户端 addWidget 出来的按钮（「🎴 打开 LoRA 堆」）：名字是创建时定死的，
    // 这里按 _cftI18nKey 跟着语言重刷。按钮 widget 无值、不进序列化，改名安全。
    if (w && w._cftI18nKey) {
      const want = T(w._cftI18nKey);
      if (w.name !== want) { w.name = want; changed = true; }
      if (w.label !== want) { w.label = want; changed = true; }
    }
  }
  const t = NODE_TITLES[cls];
  if (t) {
    const defaults = new Set([cls, t.zh, t.en, ...(LEGACY_NODE_TITLES[cls] || [])]);
    if (!node.title || defaults.has(node.title)) {
      const want = t[getLang()];
      if (node.title !== want) {
        node.title = want;
        changed = true;
      }
    }
  }
  return changed;
}

/** 语言切换时：把图里所有 CFT 节点的插槽显示名刷一遍。（只由主实例监听，避免重复执行） */
if (CFT_PRIMARY_INSTANCE) window.addEventListener("cft:langchange", () => {
  try {
    const g = app.graph;
    const nodes = (g && (g._nodes || g.nodes)) || [];
    let changed = false;
    for (const n of nodes) {
      try {
        changed = applySocketLabels(n) || changed;
        // 节点内嵌面板里的文案（「管理」按钮等）也要跟着换语言
        if (isCFTNode(n) && NODE_STATE.has(n)) refreshNodePanel(n);
      } catch { /* 单节点失败不影响其余 */ }
    }
    if (changed) {
      try { app.canvas?.setDirty?.(true, true); } catch { }
      try { g.setDirtyCanvas?.(true, true); } catch { }
    }
  } catch { /* 图还没建好就忽略 */ }
});

/* ------------------------------------------------------------ 节点来源徽章 */

/**
 * ComfyUI 1.5x 的 Vue 节点标题右侧会画一个「节点来源」小徽章，
 * 文本由 `python_module` 里的**目录名**推导：
 *
 *     custom_nodes.ComfyUI-Civitai-LoRA-Rack  →  去掉 `ComfyUI-`  →  `Civitai-LoRA-Rack`
 *
 * 也就是插件目录名。v2.34 起插件目录已从 `ComfyUI-CFT-LoraStack` 改名为
 * `ComfyUI-Civitai-LoRA-Rack`，推导结果天然是 `Civitai-LoRA-Rack`，不再带内部代号；
 * 这里再把连字符换成空格、把短徽章压成 `Civitai`，只为界面更干净。
 */
// v2.35：徽章是「节点来源」，显示插件全名，不要缩成光秃秃的 `Civitai`
//（容易被误读成「数据来自 Civitai」而不是「这个节点来自哪个插件」）。
const NODE_SOURCE_BADGE = { displayText: "Civitai LoRA Rack", badgeText: "Civitai LoRA Rack" };

/**
 * 只动本插件自己的两个节点；其它节点（含第三方）一律不碰。
 * @returns {boolean} 是否真的改了
 */
function patchNodeSourceBadge(nodeData) {
  if (!nodeData) return false;
  const name = nodeData.name;
  if (name !== NODE_CLASS && name !== NODE_CLASS_LOADER) return false;
  const src = nodeData.nodeSource;
  if (!src || src.type !== "custom_nodes") return false;
  src.displayText = NODE_SOURCE_BADGE.displayText;
  src.badgeText = NODE_SOURCE_BADGE.badgeText;
  return true;
}

/**
 * Vue 节点渲染时读的不是 LiteGraph 的 nodeData，而是 pinia 里 `nodeDef` store
 * 的 `nodeDefsByName`（页面加载时由 `/object_info` 构建的 NodeDef 实例）。
 * 所以真正生效的覆盖必须落在这份数据上。
 */
function cftNodeDefEntry(name) {
  try {
    const pinia = globalThis.app?.extensionManager?._p;
    const map = pinia?.state?.value?.nodeDef?.nodeDefsByName;
    if (!map) return null;
    return map instanceof Map ? map.get(name) : map[name];
  } catch {
    return null;
  }
}

/** @returns {number} 成功覆盖的个数（0 表示 store 还没就绪） */
function patchNodeSourceBadgeStore() {
  let ok = 0;
  for (const t of [NODE_CLASS, NODE_CLASS_LOADER]) {
    const def = cftNodeDefEntry(t);
    if (!def || !def.nodeSource) continue;
    def.nodeSource.displayText = NODE_SOURCE_BADGE.displayText;
    def.nodeSource.badgeText = NODE_SOURCE_BADGE.badgeText;
    ok++;
  }
  return ok;
}

/**
 * store 的构建时机早于 setup 但也可能因缓存/慢网而更晚，分几档重试，改到就停。
 * 纯显示层，失败完全静默（最坏情况只是徽章还是目录名）。
 */
function cftPatchNodeSourceBadgeWithRetry(delays = [0, 300, 1200, 3000]) {
  for (const d of delays) {
    setTimeout(() => {
      try { patchNodeSourceBadgeStore(); } catch { /* 忽略 */ }
    }, d);
  }
}

/** 遍历已注册的节点定义再补一次（classic 画布走 LiteGraph 的 nodeData）。 */
function patchNodeSourceBadgesFromRegistry() {
  let ok = 0;
  try {
    const reg = globalThis.LiteGraph?.registered_node_types;
    if (!reg) return 0;
    for (const t of [NODE_CLASS, NODE_CLASS_LOADER]) {
      if (patchNodeSourceBadge(reg[t]?.nodeData)) ok++;
    }
  } catch { /* 注册表未就绪 */ }
  return ok;
}

/* ------------------------------------------------------------ 扩展注册 */

// v2.29：尽可能早地装垫片（早于本扩展的 setup，也早于其他扩展建节点）
cftInstallLegacyNodeApiShims();

// 只在主实例注册：同名扩展注册两次会抛错并中断后续扩展加载（详见文件头 CFT_PRIMARY_INSTANCE 说明）
if (CFT_PRIMARY_INSTANCE) app.registerExtension({
  name: EXT_NAME,
  async setup() {
    // v2.29：给在 node.onResize 里误调 requestVueRedraw 的旧扩展补兼容空实现，
    // 否则它们抛的 TypeError 会打断整个工作流加载，
    // 表现为「画布换了但标签不出现 / 点标签没反应 / × 关不掉」
    cftInstallLegacyNodeApiShims();
    // v2.27：上一次「清理草稿并重新加载」会临时关掉草稿持久化，这里把它打开回来
    // （放在 setup 里是因为此时 setting 服务才一定可用）
    cftRestorePersistSetting();
    // v2.28：标签 × 点了没反应的兜底
    cftInstallTabCloseGuard();
    // v2.33：节点来源徽章文本（默认取目录名 = Civitai-LoRA-Rack）改成插件全名
    patchNodeSourceBadgesFromRegistry();
    cftPatchNodeSourceBadgeWithRetry();
  },
  /** v2.33：节点注册时就把来源徽章文本换掉（徽章是 Vue 侧读 nodeData.nodeSource 渲染的） */
  async beforeRegisterNodeDef(nodeType, nodeData) {
    patchNodeSourceBadge(nodeData);
  },
  async nodeCreated(node) {
    applySocketLabels(node); // 堆 + 单条加载器都套插槽显示名（v2.23）
    if (!isCFTNode(node)) return;
    setupNode(node);
  },
  async loadedGraphNode(node) {
    applySocketLabels(node);
    if (!isCFTNode(node)) return;
    setTimeout(() => {
      if (!NODE_STATE.has(node)) setupNode(node);
      // 工作流加载完成：节点里的堆是空的就从本机备份补回来（v2.13）
      // 与 onConfigure 里的恢复是双保险，两者都只在这条「确实加载过」的路径上跑
      const n = restoreStackFromBackup(node);
      if (n > 0) globalToast(T("已从本机备份恢复 {0} 条 Lora（工作流里存的是空堆）", n));
      refreshNodePanel(node);
    }, 80);
  },
});

/* ------------------------------------------------------------ 测试钩子 */

/**
 * 供自动化 DOM 沙盒 / 单元测试读取内部纯函数与入口的最小钩子。
 * 对浏览器正常运行无任何副作用（只挂一个全局对象）。
 */
try {
  globalThis.__CFT_TEST__ = {
    // 纯函数
    parseWeight,
    finiteOr,
    normalizeEntry,
    serializeEntry,
    clampGeom,
    parseViewMode,
    parseCardSize,
    isMissingMeta,
    hasCivitaiDetail,
    needsCivitaiLookup,
    mergeMeta,
    metaFromCivitai,
    previewUrl,
    fmtBytes,
    // 第四批：纯函数 / 自绘对话框
    dupKeyOf,
    buildDupIndex,
    coverMedia,
    makeThumb,
    applyUserMetaToCache,
    askChoice,
    askConfirm,
    showInfoModal,
    // 入口
    openStackManager,
    openPicker,
    openCleanup,
    openTrash,
    // v2.15：按 lora 单例的详情窗入口（沙盒据此断言「同一个 lora 只开一个」）
    openDetailModal,
    isCFTNode,
    setupNode,
    refreshNodePanel,
    // 清理 / 右键菜单
    ContextMenu,
    bindContextMenu,
    revealLora,
    deleteLoraLocal,
    showLocalFiles,
    // 实例 / 单例
    Store,
    Modal,
    StackManagerModal,
    PickerModal,
    DetailModal,
    CleanupModal,
    TrashModal,
    Lightbox,
    OPEN_MODALS,
    readStack,
    writeStack,
    // 仅供沙盒断言 toast 的挂载容器（R35）：无业务副作用，运行时不会被调用
    globalToast,
    // v2.13：堆数据本机备份 / 恢复
    backupStack,
    readStackBackup,
    restoreStackFromBackup,
    stackBakKey,
    META_CACHE,
    LS,
    LS_PREFIX,
    FRONTEND_VERSION,
    // v2.22：i18n 钩子（语言切换 / 翻译函数 / 设置弹窗入口）
    T,
    I18N,
    getLang,
    setLang,
    openSettings,
    // v2.23：节点插槽名显示翻译
    applySocketLabels,
    SOCKET_LABELS,
    NODE_TITLES,
    LEGACY_NODE_TITLES,
    // v2.33：节点来源徽章文本覆盖
    NODE_SOURCE_BADGE,
    patchNodeSourceBadge,
    patchNodeSourceBadgesFromRegistry,
    patchNodeSourceBadgeStore,
    cftNodeDefEntry,
    // v2.27：工作流标签栏修复（设置面板里的三颗按钮）
    cftIsTemporaryWorkflow,
    cftWorkflowTabsInfo,
    cftCloseTemporaryWorkflows,
    cftReloadWithoutDrafts,
    cftRestorePersistSetting,
    CFT_PERSIST_RESTORE_KEY,
    // v2.28：标签 × 兜底
    cftInstallTabCloseGuard,
    cftForceCloseTabPath,
    cftOverlayBusy,
    CFT_TAB_GUARD_DELAYS,
    // v2.29：旧扩展兼容垫片（给 LGraphNode 补 requestVueRedraw 空实现）
    cftInstallLegacyNodeApiShims,
    CFT_LEGACY_SHIM_FLAG,
    // 沙盒要能临时给 app 挂 extensionManager 桩，直接拿引用
    app,
  };
} catch {
  /* 忽略：某些沙盒环境可能没有 globalThis 写权限 */
}

console.log(T("[Civitai-LoRA-Rack] 前端扩展已加载"));
