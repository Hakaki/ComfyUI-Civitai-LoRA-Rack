/**
 * Civitai-LoRA-Rack 第二批改进：真实 Chromium DOM 沙盒。
 *
 * 加载磁盘上真实的 web/cft_lora_stack.js（+ .css），stub 掉 ComfyUI 的
 * scripts/app.js 与 scripts/api.js，然后对 7 项新功能逐条做 DOM 级断言。
 *
 * 由 tests/run_sandbox.mjs 拷贝到临时目录并通过本地 HTTP 服务运行。
 */

import "./web/cft_lora_stack.js";

const T = globalThis.__CFT_TEST__;
const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok: !!ok, detail: detail ? String(detail) : "" });
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const resp = (payload, ok = true, status = 200) => ({ ok, status, json: async () => payload });
const findIn = (root, sel, text) => [...root.querySelectorAll(sel)].find((el) => (el.textContent || "").includes(text));
const pathOf = (url) => (url.indexOf("?") >= 0 ? url.slice(0, url.indexOf("?")) : url);
const queryOf = (url) => (url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "");

/**
 * 视频缩略图的属性断言（**同步**、脱离文档）。
 *
 * 为什么不直接断言页面上那个 <video>：沙盒的假视频端点是拿 SVG 冒充 mp4 的，
 * Chromium 解码必然失败 → guardVideo 会把 <video> 换成占位 <img>（这本身是正确
 * 的产品行为，R22 另有断言覆盖）。换图是异步的，断言的快慢就成了掷骰子，
 * 表现为"有时红有时绿"的假故障。makeThumb 是同步设属性的，脱离文档造一个
 * 立刻断言，时序上不可能被 error 事件插队。
 */
function checkVideoThumbShape(tag, item) {
  const el = T.makeThumb(item, "cft-thumb");
  check(`${tag} 造出 <video>` , !!el && el.tagName === "VIDEO", el ? el.tagName : "null");
  check(`${tag} muted === true`, !!el && el.muted === true, el ? String(el.muted) : "none");
  check(`${tag} defaultMuted === true`, !!el && el.defaultMuted === true, el ? String(el.defaultMuted) : "none");
  check(`${tag} 无 controls`, !!el && !el.hasAttribute("controls"));
  check(`${tag} preload=metadata`, !!el && el.getAttribute("preload") === "metadata", el ? String(el.getAttribute("preload")) : "none");
  check(`${tag} 带 cft-thumb-video 类`, !!el && el.classList.contains("cft-thumb-video"), el ? el.className : "none");
  check(`${tag} autoplay + loop + playsinline`, !!el && el.hasAttribute("autoplay") && el.hasAttribute("loop") && el.hasAttribute("playsinline"));
}

/* ----------------------------------------------------------- 假数据 / 假后端 */

const FAKE = { version: 0, resolved: new Set(), apiKey: "" };
/** window.prompt 被调用的次数（R19 护栏：必须始终为 0） */
let PROMPT_CALLS = 0;

/* 用户自定义数据（标签 / 说明 / 封面 / 收藏）：仿后端 <base>.cft-user.json 的单一用户数据。 */
FAKE.user = { tags: [], note: "", cover: null, favorite: false };
/** 最近一次被写入用户数据的 lora —— baseItems() 会把它回填到对应条目上 */
FAKE.userName = "";
/** 最近一次 /set_cover 的请求体，供 R16 断言 */
FAKE.coverCall = null;
/** /user_meta POST 的请求体流水 */
FAKE.calls = [];
/** 是否加载「同名副本 / 只有视频封面 / 带自定义标签」三条样本。
    默认关：它们会改变列表条数，会打乱 R5/R7 等既有计数断言。 */
FAKE.samples = false;
/** 造批次号用的自增序号，保证每次 /cleanup 的 stamp 唯一 */
FAKE.cleanupSeq = 0;
/** 预览图 mtime：给「设置封面后封面没换」的回归用例改这个值，缩略图 URL 必须跟着变。 */
FAKE.previewMtime = 0;
/** /trash_delete 的请求流水，供隔离区「彻底删除」断言。 */
FAKE.trashDeleteCalls = [];

/** 组装 /user_meta 的返回体（与后端 cft_userdata._shape 对齐）。 */
function fullUser() {
  return {
    version: 1,
    tags: FAKE.user.tags || [],
    note: FAKE.user.note || "",
    cover: FAKE.user.cover,
    favorite: !!FAKE.user.favorite,
    updated_at: 1792083355.2,
    exists: true,
  };
}

function baseItems() {
  // source / has_meta 与后端 _slim() 对齐：civitai=有 C 站侧车，safetensors=没有
  const items = [
    { lora: "A/one.safetensors", name: "one", display_name: "One", folder: "A", file_name: "one.safetensors", size_mb: 100, preview: "A/one.preview.png", preview_mtime: FAKE.previewMtime || 0, creator: "alice", tags: ["t1", "t2"], trained_words: ["w1"], base_model: "SD1.5", downloads: 1234, version_name: "v1", url: "https://civitai.com/models/1", source: "civitai", has_meta: true, remote_images: [{ url: "https://image.civitai.com/one.jpeg", width: 512, height: 512 }] },
    { lora: "B/two.safetensors", name: "two", display_name: "Two", folder: "B", file_name: "two.safetensors", size_mb: 200, preview: "", preview_mtime: 0, creator: "", tags: [], trained_words: [], base_model: "", downloads: 0, version_name: "", url: "", source: null, has_meta: false, remote_images: [] },
    { lora: "C/three.safetensors", name: "three", display_name: "Three", folder: "C", file_name: "three.safetensors", size_mb: 300, preview: "", preview_mtime: 0, creator: "", tags: [], trained_words: [], base_model: "", downloads: 0, version_name: "", url: "", source: null, has_meta: false, remote_images: [] },
  ];
  if (FAKE.version >= 1) {
    items.push({ lora: "D/four.safetensors", name: "four", display_name: "Four", folder: "D", file_name: "four.safetensors", size_mb: 400, preview: "", creator: "dan", tags: ["new"], trained_words: [], base_model: "SDXL", downloads: 0, version_name: "v1", url: "", source: "civitai", has_meta: true, remote_images: [] });
  }
  // five / six：仅当 FAKE.extra 为真时才出现在列表里，专门给 R7b「旧快照」回归用例用
  if (FAKE.extra) {
    items.push({ lora: "E/five.safetensors", name: "five", display_name: "Five", folder: "E", file_name: "five.safetensors", size_mb: 500, preview: "", creator: "", tags: [], trained_words: [], base_model: "", downloads: 0, version_name: "", url: "", source: null, has_meta: false, remote_images: [] });
    items.push({ lora: "F/six.safetensors", name: "six", display_name: "Six", folder: "F", file_name: "six.safetensors", size_mb: 600, preview: "", creator: "", tags: [], trained_words: [], base_model: "", downloads: 0, version_name: "", url: "", source: null, has_meta: false, remote_images: [] });
    // seven = 用户真实场景：有 .civitai.info（基座/下载量/预览图齐全）但**没有** creator/tags。
    // 早先的判据只看 creator/tags/触发词，会给它误挂「无C站信息」黄标。
    items.push({ lora: "G/seven.safetensors", name: "seven", display_name: "Anima V2", folder: "G", file_name: "seven.safetensors", size_mb: 87, preview: "", creator: "", tags: [], trained_words: [], base_model: "Anima", downloads: 2178, version_name: "", url: "", source: "civitai", has_meta: true, remote_images: [{ url: "https://image.civitai.com/s.jpeg", width: 512, height: 512 }] });
  }
  // 第四批样本（同名副本 / 只有视频 / 自定义标签）：默认关，按需打开
  if (FAKE.samples) items.push(...sampleItems());

  const um = FAKE.user || { tags: [], note: "", cover: null };
  return items.map((it) => {
    const resolved = FAKE.resolved.has(it.lora)
      ? { ...it, creator: it.creator || "creator-x", tags: it.tags.length ? it.tags : ["resolved"], base_model: it.base_model || "SD1.5", version_name: it.version_name || "v1", url: it.url || "https://civitai.com/models/9", source: "civitai", has_meta: true, remote_images: it.remote_images.length ? it.remote_images : [{ url: "https://image.civitai.com/r.jpeg", width: 512, height: 512 }] }
      : it;
    // 用户自定义字段：默认空；被编辑过的哪一条就回填到哪一条（仿 .cft-user.json 属于该 lora）
    const userPart = { user_tags: [], user_note: "", has_user: false, cover_url: "", cover_type: "", favorite: false };
    if (FAKE.userName && it.lora === FAKE.userName) {
      userPart.user_tags = um.tags || [];
      userPart.user_note = um.note || "";
      userPart.has_user = true;
      userPart.favorite = !!um.favorite;
      if (um.cover) {
        userPart.cover_url = um.cover.url || "";
        userPart.cover_type = um.cover.type || "";
      }
    }
    return { ...userPart, ...resolved };
  });
}

/**
 * 第四批新增样本：
 *  · 两条同名副本：C 站 model_id / version_id 完全相同、display_name 都是 "Bin Director"，
 *    只有文件名不同 —— 复刻用户「同一个 lora 出现两个」的真实场景。
 *  · 一条只有视频封面：读不到本地预览图，C 站信息页首图就是视频。
 *  · 一条带自定义标签 / 说明。
 */
function sampleItems() {
  return [
    {
      lora: "Anima/bin主任v2-step00009000.safetensors", name: "bin主任v2-step00009000", display_name: "Bin Director",
      folder: "Anima", file_name: "bin主任v2-step00009000.safetensors", size_mb: 88, preview: "Anima/bin主任v2-step00009000.preview.png",
      creator: "bin", tags: ["director"], trained_words: [], base_model: "SD1.5", downloads: 10, version_name: "v2",
      model_id: 2897696, version_id: 3359372, url: "https://civitai.com/models/2897696", source: "civitai", has_meta: true,
      remote_images: [{ url: "https://image.civitai.com/bin1.jpeg", width: 512, height: 512, type: "image" }],
    },
    {
      lora: "Anima/bin仪馆主任 style.safetensors", name: "bin仪馆主任 style", display_name: "Bin Director",
      folder: "Anima", file_name: "bin仪馆主任 style.safetensors", size_mb: 92, preview: "Anima/bin仪馆主任 style.preview.png",
      creator: "bin", tags: ["director"], trained_words: [], base_model: "SD1.5", downloads: 10, version_name: "v2",
      model_id: 2897696, version_id: 3359372, url: "https://civitai.com/models/2897696", source: "civitai", has_meta: true,
      remote_images: [{ url: "https://image.civitai.com/bin2.jpeg", width: 512, height: 512, type: "image" }],
    },
    {
      lora: "Vid/onlyvideo.safetensors", name: "onlyvideo", display_name: "Only Video",
      folder: "Vid", file_name: "onlyvideo.safetensors", size_mb: 120, preview: "", preview_mtime: 0,
      // tags 里额外带「风格」：与下面 mytagged 的自定义标签「风格」同名，
      // 用来验证「同名标签合并成一项、优先归入『我的标签』组」（报障 4）
      creator: "vid", tags: ["video", "风格"], trained_words: [], base_model: "SDXL", downloads: 5, version_name: "v1",
      model_id: 777, version_id: 888, url: "https://civitai.com/models/777", source: "civitai", has_meta: true,
      remote_images: [{ url: "https://image.civitai.com/x/vid.mp4", type: "video", width: 512, height: 768 }],
    },
    {
      lora: "Mine/mytagged.safetensors", name: "mytagged", display_name: "My Tagged",
      folder: "Mine", file_name: "mytagged.safetensors", size_mb: 60, preview: "", preview_mtime: 0,
      // 4 个 C 站标签 + 3 个自定义标签：卡片上应只显示 3 C 站 + 2 自定义（报障 5 的数量约束）
      creator: "me", tags: ["t", "style", "portrait", "photo"], trained_words: [], base_model: "SD1.5", downloads: 1, version_name: "v1",
      model_id: 999, version_id: 111, url: "https://civitai.com/models/999", source: "civitai", has_meta: true,
      remote_images: [],
      user_tags: ["我的收藏", "风格", "夜景"], user_note: "自定义说明内容", has_user: true,
    },
  ];
}

/* 清理/删除相关状态：必须放模块级——放在 handler 内部会每次调用重建，
   上一次 /cleanup 的清零结果会被下一次 /cleanup_scan 悄悄丢掉。 */
// 假清理报告：结构与后端 cft_cleanup.scan_orphans() 对齐
const FAKE_JUNK = [
  { id: "orphan_preview", label: "孤立预览图", hint: "同目录已经没有对应 lora 的图片", default_on: true, count: 12, size: 340 * 1024 * 1024, size_mb: 340, items: [
    { rel: "Anima/ghost-1.preview.png", size: 30 * 1024 * 1024, name: "ghost-1.preview.png" },
    { rel: "Krea2/ghost-2.preview.png", size: 310 * 1024 * 1024, name: "ghost-2.preview.png" },
  ] },
  { id: "orphan_meta", label: "孤立信息文件", hint: "主文件已不在", default_on: true, count: 30, size: 5 * 1024 * 1024, size_mb: 5, items: [
    { rel: "Krea2/old.safetensors.extra-info.json", size: 2048, name: "old.safetensors.extra-info.json" },
  ] },
  { id: "partial", label: "下载残留", hint: ".part / .tmp 等没下完的半成品", default_on: true, count: 3, size: 318 * 1024 * 1024, size_mb: 318, items: [
    { rel: "Krea2/Broken_V2 v2.safetensors.part", size: 318 * 1024 * 1024, name: "Broken_V2 v2.safetensors.part" },
  ] },
  { id: "empty_file", label: "0 字节空文件", hint: "体积为 0 的侧车或空图", default_on: true, count: 0, size: 0, size_mb: 0, items: [] },
  { id: "orphan_json", label: "孤立 .json（需谨慎）", hint: "不确定是否为 lora 侧车，默认不清理", default_on: false, count: 7, size: 1024, size_mb: 0, items: [
    { rel: "notes.json", size: 1024, name: "notes.json" },
  ] },
];
FAKE.junk = FAKE_JUNK;
FAKE.deleted = [];
// 预置 2 个隔离批次：让 R13「隔离区窗口」一打开就有东西可点（不然只能看空态）。
// byCat 留空：还原时不动 FAKE_JUNK 的计数，避免影响其它用例的计数断言。
FAKE.trash = [
  { stamp: "20261016-101500-aaaa", root: "/models/loras", path: "/models/loras/.cft_trash/20261016-101500-aaaa",
    count: 5, size: 12 * 1024 * 1024, size_mb: 12, original_root: "/models/loras", byCat: [] },
  { stamp: "20261016-113000-bbbb", root: "/models/loras", path: "/models/loras/.cft_trash/20261016-113000-bbbb",
    count: 9, size: 88 * 1024 * 1024, size_mb: 88, original_root: "/models/Krea2", byCat: [] },
];
globalThis.__CFT_HANDLE__ = async (url, opts) => {
  const path = pathOf(url);
  const q = new URLSearchParams(queryOf(url));
  if (path === "/cft_lora/config") {
    return resp({ ok: true, data: {
      found: true,
      site_domain: "civitai.com",
      has_api_key: Boolean(FAKE.apiKey),
      api_key_masked: FAKE.apiKey.length >= 4 ? "*".repeat(8) + FAKE.apiKey.slice(-4) : "",
    } });
  }
  if (path === "/cft_lora/config/set") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    FAKE.apiKey = (body.api_key || "").trim();
    return resp({ ok: true, data: {
      found: true,
      site_domain: "civitai.com",
      has_api_key: Boolean(FAKE.apiKey),
      api_key_masked: FAKE.apiKey.length >= 4 ? "*".repeat(8) + FAKE.apiKey.slice(-4) : "",
    } });
  }
  if (path === "/cft_lora/config/test") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    const key = (body.api_key || "").trim() || FAKE.apiKey;
    // 沙盒无真网络：以 "valid-" 前缀模拟「有效 Key」，其余一律判无效（复刻 C 站 401）
    if (key.startsWith("valid-")) {
      return resp({ ok: true, data: { ok: true, username: "sandbox_user", tier: "Founder", message: "Token 有效" } });
    }
    return resp({ ok: true, data: { ok: false, reason: "unauthorized", message: "Token 无效或缺失（C 站返回 401）" } });
  }
  if (path === "/cft_lora/list") {
    const items = baseItems();
    return resp({ ok: true, data: items, total: items.length, folders: [{ name: "A", count: 1 }, { name: "B", count: 1 }, { name: "C", count: 1 }], loras_dirs: ["/models/loras"] });
  }
  if (path === "/cft_lora/detail") {
    const name = q.get("name") || "";
    // 视频样本：C 站信息页首图就是视频（读不到本地预览图）——复刻用户报的场景
    if (name === "Vid/onlyvideo.safetensors") {
      return resp({ ok: true, data: {
        lora: name, name: "onlyvideo", display_name: "Only Video · 详情", size_mb: 120, sha256: "feedbeef0123456789abcdef01234567", source: "civitai", base_model: "SDXL",
        civitai: {
          creator: "vid", version_name: "v1", type: "LORA", url: "https://civitai.com/models/777",
          trainedWords: [], tags: ["video"],
          images: [
            { url: "https://image.civitai.com/x/vid.mp4", type: "video", width: 512, height: 768 },
            { url: "https://image.civitai.com/x/still.jpeg", type: "image", width: 512, height: 768 },
          ],
          stats: { downloadCount: 5, favoriteCount: 0 },
        },
        training: {},
      } });
    }
    return resp({ ok: true, data: {
      lora: name, name: "one", display_name: "One · 详情", size_mb: 100, sha256: "abcdef0123456789abcdef0123456789", source: "civitai", base_model: "SD1.5",
      civitai: {
        creator: "alice", version_name: "v1", type: "LORA", url: "https://civitai.com/models/1",
        trainedWords: ["w1", "w2"], tags: ["t1", "t2", "t3"],
        images: [{ url: "https://image.civitai.com/one.jpeg", width: 512, height: 512 }, { url: "https://image.civitai.com/two.jpeg", width: 640, height: 480 }],
        stats: { downloadCount: 1234, favoriteCount: 55 },
      },
      training: { network_dim: 32, learning_rate: 1e-4 },
    } });
  }
  if (path === "/cft_lora/reload") { FAKE.version += 1; return resp({ ok: true, data: { total: baseItems().length } }); }
  if (path === "/cft_lora/refresh") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    FAKE.resolved.add(body.name);
    return resp({ ok: true, data: { found: true, hash: "HASH", info: {}, name: body.name } });
  }
  if (path === "/cft_lora/refresh_batch") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    const names = body.names || [];
    const r = names.map((n) => { FAKE.resolved.add(n); return { name: n, found: true, hash: "HASH_" + n, error: null }; });
    return resp({ ok: true, data: { results: r, total: r.length, found: r.length, not_found: 0, failed: 0, truncated: false } });
  }

  /* ---------------------------------------------- 清理 / 定位 / 删除（R8/R9） */

  if (path === "/cft_lora/cleanup_scan") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    let groups = FAKE_JUNK;
    if (!body.with_items) groups = groups.map(({ items, ...rest }) => rest);
    return resp({ ok: true, data: {
      groups, total: FAKE_JUNK.reduce((a, g) => a + g.count, 0),
      total_size: FAKE_JUNK.reduce((a, g) => a + g.size, 0),
      total_size_mb: 663, roots: ["/models/loras"], scanned_dirs: 3, scanned_files: 2042,
    } });
  }
  if (path === "/cft_lora/cleanup") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    const cats = body.categories || [];
    const picked = FAKE_JUNK.filter((g) => cats.includes(g.id));
    const count = picked.reduce((a, g) => a + g.count, 0);
    const size = picked.reduce((a, g) => a + g.size, 0);
    if (body.dry_run) {
      return resp({ ok: true, data: { dry_run: true, ok: true, candidate_count: count, total_size: size, total_size_mb: Math.round(size / 1048576), rejected: [], rejected_count: 0, permanent: !!body.permanent } });
    }
    // 批次记账必须在清零**之前**取快照，否则 byCat 里记的全是 0，还原时加不回任何文件
    const byCat = picked.map((g) => ({ id: g.id, count: g.count, size: g.size }));
    // 真正清理后把对应分类清空，重新扫描的结果要跟着变
    for (const g of picked) { g.count = 0; g.size = 0; g.items = []; }
    if (body.permanent) {
      FAKE.permanentCleaned = (FAKE.permanentCleaned || 0) + count;
    } else {
      // 批次必须按分类记账：还原时才能精确回到各自分类（真实后端清单就是逐文件的）
      // stamp 每次唯一（自增序号），否则预置批次在场时两次清理会撞出同号批次
      FAKE.trash.push({
        stamp: "20261016-1200" + String(10 + (FAKE.cleanupSeq++ % 49)).padStart(2, "0") + "-cccc",
        root: "/models/loras",
        path: "/models/loras/.cft_trash/x",
        count, size, size_mb: Math.round(size / 1048576), original_root: "/models/loras",
        byCat,
      });
    }
    return resp({ ok: true, data: { ok: true, dry_run: false, permanent: !!body.permanent, stamp: body.permanent ? null : "20261016-120000-ab", quarantined: body.permanent ? 0 : count, deleted: body.permanent ? count : 0, removed: count, failed: 0, failures: [], rejected: [], rejected_count: 0, total_size: size, total_size_mb: Math.round(size / 1048576), trash_dirs: body.permanent ? [] : ["/models/loras/.cft_trash/20261016-120000-ab"] } });
  }
  if (path === "/cft_lora/cleanup_trash") return resp({ ok: true, data: FAKE.trash });
  if (path === "/cft_lora/cleanup_restore") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    const at = FAKE.trash.findIndex((b) => b.stamp === body.stamp);
    if (at < 0) return resp({ ok: false, error: "找不到隔离批次" }, false, 400);
    const b = FAKE.trash.splice(at, 1)[0];
    // 还原：按批次记账逐分类加回
    for (const rec of b.byCat || []) {
      const g = FAKE_JUNK.find((x) => x.id === rec.id);
      if (g) { g.count += rec.count; g.size += rec.size; }
    }
    return resp({ ok: true, data: { ok: true, restored: b.count, failed: 0, failures: [] } });
  }
  if (path === "/cft_lora/trash_delete") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    FAKE.trashDeleteCalls.push({ stamp: body.stamp ?? null, all: !!body.all });
    let deleted = 0;
    let freed = 0;
    if (body.all) {
      deleted = FAKE.trash.reduce((a, b) => a + (b.count || 0), 0);
      freed = FAKE.trash.reduce((a, b) => a + (b.size || 0), 0);
      FAKE.trash.length = 0;
    } else {
      const at = FAKE.trash.findIndex((b) => b.stamp === body.stamp);
      if (at >= 0) { const b = FAKE.trash.splice(at, 1)[0]; deleted = b.count || 0; freed = b.size || 0; }
    }
    return resp({ ok: true, data: {
      deleted, freed, freed_mb: Math.round(freed / 1048576),
      errors: [], removed_dirs: [], stamps: body.all ? [] : [body.stamp],
    } });
  }
  if (path === "/cft_lora/bundle") {
    const name = q.get("name") || "";
    const found = baseItems().some((i) => i.lora === name);
    if (!found) return resp({ ok: false, error: "找不到 Lora：" + name }, false, 404);
    return resp({ ok: true, data: {
      lora: name, abs_path: "/models/loras/" + name, dir: "/models/loras/" + name.replace(/\/[^/]+$/, ""), folder: name.includes("/") ? name.split("/")[0] : ".",
      root: "/models/loras", file_name: name.split("/").pop(), size: 90 * 1024 * 1024, size_mb: 90,
      files: [
        { name: name.split("/").pop(), kind: "lora", size: 87 * 1024 * 1024, required: true },
        { name: "x.preview.png", kind: "preview", size: 3 * 1024 * 1024, required: false },
        { name: "x.civitai.info", kind: "civitai", size: 2048, required: false },
      ],
    } });
  }
  if (path === "/cft_lora/reveal") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    FAKE.revealed = (FAKE.revealed || []).concat([{ name: body.name, mode: body.mode || "select" }]);
    return resp({ ok: true, data: { ok: true, dir: "/models/loras/" + String(body.name || "").replace(/\/[^/]+$/, ""), path: "/models/loras/" + body.name } });
  }
  if (path === "/cft_lora/delete_local") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    const name = body.name;
    if (!baseItems().some((i) => i.lora === name)) return resp({ ok: false, error: "找不到 Lora：" + name }, false, 404);
    FAKE.deleted.push({ name, permanent: !!body.permanent, include_body: body.include_body !== false });
    return resp({ ok: true, data: { ok: true, lora: name, permanent: !!body.permanent, stamp: body.permanent ? null : "20261016-130000-cd", removed: 3, failed: 0, failures: [], skipped: [], freed: 90 * 1024 * 1024, freed_mb: 90, trash_dir: body.permanent ? null : "/models/loras/.cft_trash/20261016-130000-cd", restorable: !body.permanent } });
  }
  /* ------------------------------------------- 用户自定义数据（标签 / 说明 / 封面） */

  if (path === "/cft_lora/user_meta") {
    if ((opts && opts.method) === "POST") {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (body.tags !== undefined) FAKE.user.tags = body.tags || [];
      if (body.note !== undefined) FAKE.user.note = body.note || "";
      // favorite 部分更新语义：undefined = 不改（与后端 cft_userdata.write 对齐）
      if (body.favorite !== undefined) FAKE.user.favorite = !!body.favorite;
      FAKE.userName = body.name || FAKE.userName;
      FAKE.calls.push({ path, body });
      return resp({ ok: true, data: fullUser() });
    }
    return resp({ ok: true, data: fullUser() });
  }
  if (path === "/cft_lora/user_tags") {
    const set = new Set();
    for (const it of baseItems()) for (const t of it.user_tags || []) set.add(t);
    for (const t of FAKE.user.tags || []) set.add(t);
    return resp({ ok: true, data: [...set].sort() });
  }
  if (path === "/cft_lora/set_cover") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    FAKE.coverCall = body;
    FAKE.userName = body.name || FAKE.userName;
    FAKE.user.cover = {
      kind: body.download ? "downloaded" : "remote",
      url: body.url,
      type: String(body.type || "image").toLowerCase() === "video" ? "video" : "image",
      set_at: 1792083355.2,
    };
    return resp({ ok: true, data: fullUser() });
  }
  if (path === "/cft_lora/clear_cover") {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    FAKE.userName = body.name || FAKE.userName;
    FAKE.user.cover = null;
    return resp({ ok: true, data: fullUser() });
  }
  return resp({ ok: false, error: "not found: " + path }, false, 404);
};

/* --------------------------------------------------------------- 假节点 */

function makeNode(id, entries) {
  return {
    id,
    comfyClass: "CFTLoraStack",
    widgets: [{ name: "lora_stack", value: JSON.stringify(entries) }],
    size: [340, 120],
    computeSize: () => [340, 170],
    setSize(s) { this.size = s; this._setSizeCalls = (this._setSizeCalls || 0) + 1; },
    setDirtyCanvas() {},
    // v2.16：把 addDOMWidget 的 options 也留一份（R36 要断言 getMinHeight / 没有 getMaxHeight），
    // 返回值就是测试能拿到手的 domWidget 本体（R36 用它验「没有再被赋 computeSize」）
    addDOMWidget(name, type, el, opts) {
      this._dom = { name, type, el, opts: opts || {} };
      this._dw = { element: el, options: opts || {} };
      return this._dw;
    },
    addWidget() {},
  };
}
const widgetJSON = (node) => JSON.parse(node.widgets.find((w) => w.name === "lora_stack").value);
const trigger = (el, type, init = {}) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
const pointer = (target, type, init = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));

/* --------------------------------------------------------------- 主流程 */

async function main() {
  // R19 护栏：Electron（ComfyUI Desktop）下 window.prompt 不可用（静默返回 null）。
  // 任何残留调用都当场抛错，并由 PROMPT_CALLS 计数在断言里体现 ——
  // 这条能永久防止「又用回 prompt 导致点按钮没反应」的回归。
  window.prompt = () => {
    PROMPT_CALLS++;
    throw new Error("window.prompt 被调用了（Electron 不支持）");
  };

  const ext = globalThis.__CFT_EXT__;
  check("扩展注册成功", !!ext && typeof ext.nodeCreated === "function");

  const nodeA = makeNode(1, [
    { lora: "A/one.safetensors", name: "one", display_name: "One", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
    { lora: "B/two.safetensors", name: "two", display_name: "Two", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
    { lora: "C/three.safetensors", name: "three", display_name: "Three", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
  ]);
  const nodeP = makeNode(2, []);
  const nodeB = makeNode(3, [{ lora: "A/one.safetensors", name: "one", display_name: "One", weight: 1 }]);

  await ext.nodeCreated(nodeA);
  await tick(30);

  /* ============================ R4：删除权重拖动条 ============================ */
  const sm = T.openStackManager(nodeA);
  await tick(30);

  check("R4 文档内无 range 输入框", document.querySelectorAll('input[type="range"]').length === 0, String(document.querySelectorAll('input[type="range"]').length));
  const npEl = nodeA._dom && nodeA._dom.el;
  check("R4 节点面板已创建", !!npEl);
  check("R4 节点面板无 range 输入框", !!npEl && npEl.querySelectorAll('input[type="range"]').length === 0);

  const numInputs = [...sm.body.querySelectorAll(".cft-num-lg")];
  check("R4 堆行有数字权重框（3 个）", numInputs.length === 3, String(numInputs.length));
  if (numInputs.length) {
    numInputs[0].value = "-5";
    trigger(numInputs[0], "change");
    check("R4 输入 -5 原样保留并写入 widget", widgetJSON(nodeA)[0].weight === -5, JSON.stringify(widgetJSON(nodeA)[0]));
    numInputs[0].value = "7.25";
    trigger(numInputs[0], "change");
    check("R4 输入 7.25 原样保留并写入 widget", widgetJSON(nodeA)[0].weight === 7.25, JSON.stringify(widgetJSON(nodeA)[0]));
  }

  /* ============================ R3：拖动排序 ============================ */
  let rows = [...sm.body.querySelectorAll(".cft-stack-row")];
  const beforeOrder = widgetJSON(nodeA).map((e) => e.lora);
  const r0rect = rows[0].getBoundingClientRect();
  const drag = rows[0].querySelector(".cft-drag");
  check("R3 存在拖动把手", !!drag);
  pointer(drag, "pointerdown", { clientX: r0rect.left + 10, clientY: r0rect.top + r0rect.height / 2 });
  const r2rect = rows[2].getBoundingClientRect();
  document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r2rect.left + 10, clientY: r2rect.bottom - 2 }));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  const afterOrder = widgetJSON(nodeA).map((e) => e.lora);
  check("R3 拖动后 lora 顺序确实改变", JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder), `${JSON.stringify(beforeOrder)} -> ${JSON.stringify(afterOrder)}`);
  check("R3 第一行被移到最后", afterOrder[afterOrder.length - 1] === beforeOrder[0], JSON.stringify(afterOrder));

  // 回归护栏：拖拽把手是新加在行首的，最容易带崩行内控件
  rows = [...sm.body.querySelectorAll(".cft-stack-row")];
  const row0 = rows[0];
  const rowDrag = row0.querySelector(".cft-drag");
  const rowNum = row0.querySelector(".cft-num-lg") || row0.querySelector('input[type="number"]');

  // 1) 在把手上 pointerdown 后原地 pointerup（不移动）不应触发排序
  const orderBeforeClick = widgetJSON(nodeA).map((e) => e.lora);
  if (rowDrag) {
    const rr = rowDrag.getBoundingClientRect();
    pointer(rowDrag, "pointerdown", { clientX: rr.left + 8, clientY: rr.top + rr.height / 2 });
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }
  const orderAfterClick = widgetJSON(nodeA).map((e) => e.lora);
  check("R3 原地点把手不误触发排序", JSON.stringify(orderBeforeClick) === JSON.stringify(orderAfterClick), `${orderBeforeClick} -> ${orderAfterClick}`);
  // 2) 行内数字框仍然可用（把手没有吞掉/劫持输入）
  if (rowNum) {
    rowNum.value = "3.5";
    trigger(rowNum, "change");
    const w0 = widgetJSON(nodeA)[0];
    check("R3 行内权重框仍可输入（把手未劫持）", w0.weight === 3.5, JSON.stringify(w0));
  } else {
    check("R3 行内存在数字权重框", false, "未找到 .cft-num-lg / number 输入");
  }
  // 3) 上移/下移按钮兜底仍有效（注意：对第 1 行点上移是空操作，必须取第 2 行）
  const rowForUp = rows[1] || row0;
  const upBtn = rowForUp.querySelector('button[title="上移"]');
  if (upBtn) {
    const beforeUp = widgetJSON(nodeA).map((e) => e.lora);
    upBtn.click();
    const afterUp = widgetJSON(nodeA).map((e) => e.lora);
    check("R3 ↑/↓ 按钮仍可排序", JSON.stringify(beforeUp) !== JSON.stringify(afterUp), `${beforeUp} -> ${afterUp}`);
  } else {
    check("R3 存在上移按钮", false, "未找到 button[title=上移]");
  }

  /* ============================ R7：批量查 C 站（已移到选择器窗口） ============================ */
  // 用户要求：批量查 C 站 不放 lora 堆窗口，放「选择 Lora」窗口
  check("R7 堆窗口已无「批量查 C 站」按钮", !findIn(sm.headerExtra, "button", "批量查"), sm.headerExtra.textContent || "");
  // v2.15：全局维护动作收拢到选择器里，堆窗口只管当前这个堆
  check("R7 堆窗口已移除「重扫目录」", !findIn(sm.headerExtra, "button", "重扫目录"), "");
  check("R7 堆窗口已移除「清理垃圾」", !findIn(sm.headerExtra, "button", "清理垃圾"), "");

  const pickerForBatch = T.openPicker(nodeP, () => {});
  await tick(80);
  const pToolbar = pickerForBatch.toolbar;
  const batchBtn = findIn(pToolbar, "button", "批量查");
  check("R7 选择器窗口存在「批量查 C 站」按钮", !!batchBtn);
  // 按钮上应显示待查条数：nodeP 空堆 → 列表 4 条，其中 two/three 缺信息
  check("R7 按钮显示待查条数 (2)", !!batchBtn && batchBtn.textContent.includes("(2)"), batchBtn ? batchBtn.textContent : "");
  check("R7 按钮带变暗类（有活可干时不变暗）", !!batchBtn && !batchBtn.classList.contains("cft-btn-dim"), "");

  const callsBefore = (globalThis.__CFT_CALLS__ || []).length;
  if (batchBtn) {
    batchBtn.click();
    await tick(80);
  }
  const batchCall = (globalThis.__CFT_CALLS__ || []).slice(callsBefore).find((c) => c.url.endsWith("/cft_lora/refresh_batch"));
  check("R7 发起了 /refresh_batch 请求", !!batchCall);
  if (batchCall) {
    check("R7 请求 only_missing=false", batchCall.body.only_missing === false, JSON.stringify(batchCall.body));
    const names = batchCall.body.names || [];
    check("R7 名单仅含当前列表缺信息项(two/three)", names.length === 2 && names.includes("B/two.safetensors") && names.includes("C/three.safetensors"), JSON.stringify(names));
  }
  await tick(40);
  // 命中后：选择器卡片上的「无C站信息」黄标应消失
  const pickerWarn = pickerForBatch.body.querySelectorAll(".cft-chip-warn").length;
  check("R7 命中后选择器卡片黄标消失", pickerWarn === 0, String(pickerWarn));
  const pickerText = pickerForBatch.body.textContent || "";
  check("R7 选择器已出现作者/基座文本", pickerText.includes("creator-x") && pickerText.includes("SD1.5"), "");
  // 按钮条数应归零
  check("R7 查询后按钮条数归零", !!batchBtn && !batchBtn.textContent.includes("("), batchBtn ? batchBtn.textContent : "");
  pickerForBatch.close();

  /* ============================ R2：窗口 resize + 记忆 ============================ */
  const m = new T.StackManagerModal(nodeA);
  m.open();
  await tick(20);
  const rectBefore = m.root.getBoundingClientRect();
  const handle = m.root.querySelector(".cft-resize");
  check("R2 存在 resize 抓手 .cft-resize", !!handle);
  if (handle) {
    pointer(handle, "pointerdown", { clientX: rectBefore.right - 4, clientY: rectBefore.bottom - 4 });
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rectBefore.right - 4 + 140, clientY: rectBefore.bottom - 4 + 90 }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }
  const rectAfter = m.root.getBoundingClientRect();
  check("R2 拖动抓手后宽度变大", rectAfter.width > rectBefore.width + 60, `${rectBefore.width} -> ${rectAfter.width}`);
  check("R2 拖动抓手后高度变大", rectAfter.height > rectBefore.height + 40, `${rectBefore.height} -> ${rectAfter.height}`);

  const rawGeom = localStorage.getItem("cft.loraStack.geom:stack");
  let geom = null;
  try { geom = JSON.parse(rawGeom); } catch { geom = null; }
  check("R2 几何已写入 localStorage", !!geom, String(rawGeom));
  check("R2 写入宽度与实测一致", !!geom && Math.abs(geom.width - Math.round(rectAfter.width)) <= 2, geom ? `${geom.width} vs ${Math.round(rectAfter.width)}` : "");

  const m2 = new T.StackManagerModal(nodeA);
  m2.open();
  await tick(260);
  const restored = m2.root.getBoundingClientRect();
  const boxSizing = getComputedStyle(m2.root).boxSizing;
  check("R2 .cft-modal 为 border-box（几何记录/还原同基准）", boxSizing === "border-box", boxSizing);
  check("R2 新实例从 localStorage 恢复尺寸", Math.abs(restored.width - rectAfter.width) <= 2 && Math.abs(restored.height - rectAfter.height) <= 2, `${restored.width}x${restored.height} vs ${rectAfter.width}x${rectAfter.height}`);
  check("R2 恢复后实测与持久化值一致", !!geom && Math.abs(restored.width - geom.width) <= 1 && Math.abs(restored.height - geom.height) <= 1, `${restored.width}x${restored.height} vs ${geom.width}x${geom.height}`);
  check("R2 单例：新旧实例不叠加", document.querySelectorAll(".cft-stack-modal").length === 1, String(document.querySelectorAll(".cft-stack-modal").length));

  // 回归护栏：open() 末尾会再 _persistGeom()，若 content-box/border-box 基准不一致，
  // 每重开一次窗口宽高就会各漂移 2px。这里断言「重开后持久化值不变」。
  const reopened = JSON.parse(localStorage.getItem("cft.loraStack.geom:stack") || "null");
  check("R2 重开后几何不漂移（width/height 恒定）",
    !!reopened && !!geom && reopened.width === geom.width && reopened.height === geom.height,
    `${geom?.width}x${geom?.height} -> ${reopened?.width}x${reopened?.height}`);

  localStorage.setItem("cft.loraStack.geom:stack", JSON.stringify({ left: 99999, top: 99999, width: 5000, height: 5000, minimized: false }));
  const m3 = new T.StackManagerModal(nodeA);
  m3.open();
  await tick(260);
  const clamped = m3.root.getBoundingClientRect();
  const clampedStyle = { w: m3.root.style.width, h: m3.root.style.height, l: m3.root.style.left, t: m3.root.style.top };
  check("R2 越界几何被夹回视口", clamped.left >= 0 && clamped.top >= 0 && clamped.right <= window.innerWidth + 2 && clamped.bottom <= window.innerHeight + 2, `${Math.round(clamped.left)},${Math.round(clamped.top)},${Math.round(clamped.right)},${Math.round(clamped.bottom)} vp=${window.innerWidth}x${window.innerHeight} style=${JSON.stringify(clampedStyle)}`);

  /* ================== R6：堆窗口单例（v2.15 起按节点单例） ================== */
  m3.close();
  const a1 = T.openStackManager(nodeA);
  const a2 = T.openStackManager(nodeA);
  const a3 = T.openStackManager(nodeA);
  await tick(10);
  check("R6 同一节点连续打开 3 次仍只有 1 个堆窗口", document.querySelectorAll(".cft-stack-modal").length === 1, String(document.querySelectorAll(".cft-stack-modal").length));
  check("R6 同 node 返回同一实例", a1 === a2 && a2 === a3, "");
  // v2.15：换成全局单例后这里是「关旧开新」，现在改成按节点单例 ——
  // 两个节点各开各的，能并排放着对照调堆
  const b1 = T.openStackManager(nodeB);
  await tick(10);
  check("R6 换 node 后两个堆窗口并存（不再关掉前一个）", document.querySelectorAll(".cft-stack-modal").length === 2, String(document.querySelectorAll(".cft-stack-modal").length));
  check("R6 新窗口绑定到新 node", a1 !== b1 && b1.node === nodeB, "");
  check("R6 旧窗口仍绑定原 node", a1.node === nodeA, String(a1.node?.id));
  check("R6 再开一次 nodeB 仍是那一个，不会变成 3 个", T.openStackManager(nodeB) === b1 && document.querySelectorAll(".cft-stack-modal").length === 2, String(document.querySelectorAll(".cft-stack-modal").length));
  // 回归护栏：最小化后重复打开仍应只有该节点的 1 个窗口（最小化不能绕过单例）
  b1.toggleMinimize();
  const c1 = T.openStackManager(nodeB);
  const c2 = T.openStackManager(nodeB);
  await tick(10);
  check("R6 最小化后重复打开仍只有 2 个窗口（每节点各 1）", document.querySelectorAll(".cft-stack-modal").length === 2, String(document.querySelectorAll(".cft-stack-modal").length));
  check("R6 最小化后返回同一实例", c1 === c2 && c2 === b1, "");
  check("R6 关掉 A 节点的堆窗口不影响 B 节点的", (() => {
    a1.close();
    const live = [...document.querySelectorAll(".cft-stack-modal")].filter((el) => el.parentElement);
    return live.length === 1 && T.OPEN_MODALS.get("stack:3") === b1;
  })(), String(document.querySelectorAll(".cft-stack-modal").length));
  b1.close();

  /* ============================ R5：选择器刷新 / 视图 / 尺寸 ============================ */
  // 清掉之前缓存的 selection，用空堆节点确保计数干净
  const picker = new T.PickerModal(nodeP, () => {});
  picker.open();
  await tick(40);
  const gridEl = picker.grid;
  check("R5 选择器默认卡片网格", !!gridEl && gridEl.className.includes("cft-grid"), gridEl ? gridEl.className : "");
  const cardCount0 = picker.body.querySelectorAll(".cft-grid .cft-card-wrap").length;
  check("R5 初始卡片数 = 3", cardCount0 === 3, String(cardCount0));

  const reloadBefore = (globalThis.__CFT_CALLS__ || []).length;
  const refreshBtn = findIn(picker.toolbar, "button", "刷新");
  check("R5 存在「↻ 刷新」按钮", !!refreshBtn);
  if (refreshBtn) {
    refreshBtn.click();
    await tick(60);
  }
  const recent = (globalThis.__CFT_CALLS__ || []).slice(reloadBefore);
  check("R5 刷新调用了 /reload", recent.some((c) => c.url.endsWith("/cft_lora/reload")), JSON.stringify(recent.map((c) => c.url)));
  check("R5 刷新后强制重扫 /list?force=1", recent.some((c) => c.url.includes("/cft_lora/list") && c.url.includes("force=1")), JSON.stringify(recent.map((c) => c.url)));
  const cardCount1 = picker.body.querySelectorAll(".cft-grid .cft-card-wrap").length;
  check("R5 刷新后新增 Lora 出现（3 -> 4）", cardCount1 === 4, String(cardCount1));

  const listBtn = findIn(picker.toolbar, "button", "列表");
  check("R5 存在「☰ 列表」按钮", !!listBtn);
  if (listBtn) {
    listBtn.click();
    await tick(10);
  }
  check("R5 切列表后 .cft-grid 被替换为 .cft-list", picker.body.querySelectorAll(".cft-grid").length === 0 && picker.body.querySelectorAll(".cft-list").length === 1, "");
  check("R5 列表行数正确 = 4", picker.body.querySelectorAll(".cft-list-row").length === 4, String(picker.body.querySelectorAll(".cft-list-row").length));

  const gridBtn = findIn(picker.toolbar, "button", "卡片");
  if (gridBtn) {
    gridBtn.click();
    await tick(10);
  }
  const sizeBefore = picker.grid.style.getPropertyValue("--cft-card-size");
  const plusBtn = picker.toolbar.querySelector(".cft-cardsize button:last-child");
  if (plusBtn) {
    plusBtn.click();
    await tick(10);
  }
  const sizeAfter = picker.grid.style.getPropertyValue("--cft-card-size");
  check("R5 卡片尺寸变量变化", sizeBefore !== sizeAfter && sizeAfter !== "", `${sizeBefore} -> ${sizeAfter}`);
  const lsSize = localStorage.getItem("cft.loraStack.picker.cardSize");
  check("R5 卡片尺寸写入 localStorage", !!lsSize && String(JSON.parse(lsSize)) === sizeAfter.replace("px", ""), `${lsSize} vs ${sizeAfter}`);

  // 留下 list 模式以便验证恢复
  if (listBtn) { listBtn.click(); await tick(10); }
  const savedView = localStorage.getItem("cft.loraStack.picker.view");
  check("R5 视图模式写入 localStorage=list", savedView === "list", String(savedView));
  picker.close();

  const picker2 = new T.PickerModal(nodeP, () => {});
  picker2.open();
  await tick(40);
  check("R5 重开恢复列表视图", picker2.body.querySelectorAll(".cft-list").length === 1 && picker2.body.querySelectorAll(".cft-grid").length === 0, "");
  const restoredSize = picker2.grid.style.getPropertyValue("--cft-card-size");
  check("R5 重开恢复卡片尺寸", restoredSize === sizeAfter, `${restoredSize} vs ${sizeAfter}`);
  picker2.close();

  /* ============================ R1：详情页 Lightbox ============================ */
  const dm = new T.DetailModal("A/one.safetensors", () => {});
  dm.open();
  await tick(60);
  const mainImg = dm.body.querySelector(".cft-detail-img");
  check("R1 详情主图存在", !!mainImg);
  if (mainImg) mainImg.click();
  await tick(20);

  const lb = document.querySelector(".cft-lightbox");
  check("R1 点击主图后 Lightbox 出现", !!lb && getComputedStyle(lb).display !== "none", lb ? getComputedStyle(lb).display : "missing");
  if (lb) {
    const lbZ = parseInt(getComputedStyle(lb).zIndex, 10);
    const maskZ = parseInt(getComputedStyle(document.querySelector(".cft-detail-modal").parentElement).zIndex, 10);
    check("R1 Lightbox z-index 高于弹窗遮罩", lbZ > maskZ, `lb=${lbZ} mask=${maskZ}`);

    const lbImg = document.querySelector(".cft-lb-img");
    const t0 = lbImg ? lbImg.style.transform : "";
    lb.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 }));
    const t1 = lbImg ? lbImg.style.transform : "";
    check("R1 滚轮缩放改变 transform", t0 !== t1 && /scale\(/.test(t1), `${t0} -> ${t1}`);

    // 平移夹紧：放大后往右下拖 5000px，translate 必须被夹在 ±maxX/±maxY 内
    const lbStage = document.querySelector(".cft-lb-stage");
    if (lbStage && lbImg) {
      for (let i = 0; i < 4; i++) {
        lb.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -240, clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 }));
      }
      const scaleNow = Number((lbImg.style.transform.match(/scale\(([\d.]+)\)/) || [0, 1])[1]);
      const sr = lbStage.getBoundingClientRect();
      pointer(lbStage, "pointerdown", { clientX: sr.left + sr.width / 2, clientY: sr.top + sr.height / 2 });
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: sr.left + 5000, clientY: sr.top + 5000 }));
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      const tPan = lbImg.style.transform;
      const mm = tPan.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/);
      const expMaxX = Math.max(0, ((lbImg.offsetWidth || 1) * scaleNow - sr.width) / 2);
      const expMaxY = Math.max(0, ((lbImg.offsetHeight || 1) * scaleNow - sr.height) / 2);
      check("R1 放大后可拖拽平移且被夹紧（不会把图拖飞）",
        !!mm && Math.abs(Number(mm[1]) - expMaxX) < 2 && Math.abs(Number(mm[2]) - expMaxY) < 2,
        `${tPan} | 期望 tx=${expMaxX.toFixed(1)} ty=${expMaxY.toFixed(1)} scale=${scaleNow}`);
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick(10);
    check("R1 Esc 关闭 Lightbox", getComputedStyle(lb).display === "none", lb ? getComputedStyle(lb).display : "missing");
    check("R1 Esc 后详情窗口仍在（关键）", !!document.querySelector(".cft-detail-modal") && dm._opened === true, "");
  }

  // 画廊缩略图：只切主图，**不弹大图**（v2.17 用户要求）——
  // 以前点缩略图会顺手 Lightbox.open()，想看主图反而被一层大图挡住，还得先关掉才能设封面。
  // 看大图只认舞台那张封面图。
  const galItems = [...dm.body.querySelectorAll(".cft-gal-item")];
  const imgGal = galItems.find((el) => el.querySelector("img.cft-gallery-item"));
  if (imgGal) {
    const galSrc = imgGal.querySelector("img.cft-gallery-item").getAttribute("src");
    imgGal.click();
    await tick(40);
    const lbNo = document.querySelector(".cft-lightbox");
    check("R1 点画廊缩略图不弹大图（只切主图）",
      !lbNo || getComputedStyle(lbNo).display === "none",
      lbNo ? getComputedStyle(lbNo).display : "missing");
    const stageImg2 = dm.body.querySelector(".cft-detail-img");
    check("R1 点缩略图后主舞台换成那一张",
      !!stageImg2 && stageImg2.getAttribute("src") === galSrc,
      stageImg2 ? String(stageImg2.getAttribute("src")).slice(0, 46) : "(无舞台)");
    const covBtn2 = dm.body.querySelector(".cft-detail-set-cover");
    check("R1 点缩略图后「设为封面」已解锁（没有被大图挡住）",
      !!covBtn2 && covBtn2.disabled === false, covBtn2 ? String(covBtn2.disabled) : "(无按钮)");

    // 只有点舞台封面图才打开大图，而且要从**当前这张**开始（不是永远第 0 张）
    if (stageImg2) stageImg2.click();
    await tick(40);
    const lbYes = document.querySelector(".cft-lightbox");
    check("R1 点舞台封面图才打开大图",
      !!lbYes && getComputedStyle(lbYes).display !== "none",
      lbYes ? getComputedStyle(lbYes).display : "missing");
    const counter2 = document.querySelector(".cft-lb-counter");
    const seq = counter2 ? parseInt(String(counter2.textContent).trim(), 10) : 0;
    check("R1 大图从当前这张开始（序号 > 1，不是永远第 1 张）", seq > 1,
      counter2 ? counter2.textContent : "(无计数)");
    T.Lightbox.close();
    await tick(20);
  } else {
    check("R1 点画廊缩略图不弹大图（只切主图）", false, "无画廊图");
  }

  /* ============ R7b：回归 —— entry._meta 是「旧快照」时，查到信息后黄标必须消失 ============
     真实场景：Lora 是从选择器加进堆的，entry._meta 被写成加入那一刻的快照（无 C 站信息）。
     旧实现 _metaOf() 优先返回 entry._meta，只更新 _metaMap，
     于是「从 C 站查到信息了，黄标/作者/缩略图却一点都不动」——用户实际遇到的问题。 */
  const nodeStale = makeNode(21, [
    { lora: "E/five.safetensors", name: "five", display_name: "Five", weight: 1,
      _meta: { lora: "E/five.safetensors", name: "five", display_name: "Five", creator: "", tags: [], trained_words: [], base_model: "" } },
    { lora: "F/six.safetensors", name: "six", display_name: "Six", weight: 1,
      _meta: { lora: "F/six.safetensors", name: "six", display_name: "Six", creator: "", tags: [], trained_words: [], base_model: "" } },
  ]);
  // 让 five/six 出现在假列表里（未命中状态），并清掉 Store 缓存，
  // 这样 hydrate() 之后 _metaMap 里没有它们 → _metaOf 只能回退到 entry._meta 旧快照，
  // 完整复现「从选择器加进堆、之后才查到 C 站信息」的真实场景。
  FAKE.extra = true;
  T.Store.invalidate();
  const smStale = T.openStackManager(nodeStale);
  await tick(150);
  const staleBadges0 = smStale.body.querySelectorAll(".cft-badge-warn").length;
  check("R7b 旧快照节点打开时有 2 个黄标", staleBadges0 === 2, String(staleBadges0));
  const staleRow = smStale.body.querySelectorAll(".cft-stack-row")[0];
  const queryBtn = staleRow ? staleRow.querySelector(".cft-query-btn") : null;
  check("R7b 缺信息行有「查」按钮", !!queryBtn);
  if (queryBtn) {
    queryBtn.click();
    await tick(200);
    const staleBadges1 = smStale.body.querySelectorAll(".cft-badge-warn").length;
    check("R7b 点「查」后该行黄标消失（旧快照不得卡住）", staleBadges1 === 1, String(staleBadges1));
    const staleText = smStale.body.textContent || "";
    check("R7b 该行出现作者/基座文本", staleText.includes("creator-x") && staleText.includes("SD1.5"), "");
    const e0 = T.readStack(nodeStale)[0];
    check("R7b entry._meta 已写回新元数据（节点面板读它）", !!e0._meta && e0._meta.creator === "creator-x", e0._meta ? String(e0._meta.creator) : "null");
  }
  smStale.close();
  // 收尾：把 five/six 从假列表里撤掉，避免影响后面的断言
  FAKE.extra = false;
  T.Store.invalidate();

  /* ============ R7c：回归 —— 选择器卡片 → 详情窗「从 C 站刷新」→ 卡片黄标也要消失 ============ */
  FAKE.extra = true;
  T.Store.invalidate();
  const pickerR7c = T.openPicker(nodeP, () => {});
  await tick(140);
  const warnBefore = pickerR7c.body.querySelectorAll(".cft-chip-warn").length;
  check("R7c 选择器初始有黄标卡片", warnBefore >= 1, String(warnBefore));
  // 固定用卡片视图（R5 会把视图记忆成 list），并点「带黄标的那张卡」的 ⓘ
  pickerR7c.setView("grid");
  await tick(80);
  const warnCard = [...pickerR7c.body.querySelectorAll(".cft-card-wrap")].find((c) => c.querySelector(".cft-chip-warn"));
  const infoBtn = warnCard ? warnCard.querySelector(".cft-card-info") : null;
  check("R7c 找到黄标卡片的 ⓘ 按钮", !!infoBtn);
  if (infoBtn) {
    infoBtn.click();
    await tick(120);
    // 取最后一个详情窗（R1 的 dm 此时还开着，不能取第一个）
    const dmR7c = [...document.querySelectorAll(".cft-detail-modal")].pop();
    check("R7c 详情窗已打开", !!dmR7c);
    const refreshBtn = dmR7c
      ? [...dmR7c.querySelectorAll("button")].find((b) => (b.textContent || "").includes("从 C 站刷新"))
      : null;
    check("R7c 详情窗有「↻ 从 C 站刷新」", !!refreshBtn);
    if (refreshBtn) {
      const dbgName = dmR7c.querySelector(".cft-detail-path") ? dmR7c.querySelector(".cft-detail-path").textContent : "?";
      const dbgBefore = (globalThis.__CFT_CALLS__ || []).length;
      refreshBtn.click();
      await tick(350);
      const dbgCalls = (globalThis.__CFT_CALLS__ || []).slice(dbgBefore).map((c) => c.url);
      const warnAfter = pickerR7c.body.querySelectorAll(".cft-chip-warn").length;
      check("R7c 详情窗刷新后该卡片黄标消失", warnAfter === warnBefore - 1, `${warnBefore} -> ${warnAfter} | 详情窗=${dbgName} | 调用=${JSON.stringify(dbgCalls)}`);
      check("R7c 选择器已出现作者文本", (pickerR7c.body.textContent || "").includes("creator-x"), "");
    }
  }
  pickerR7c.close();
  FAKE.extra = false;
  T.Store.invalidate();

  /* ============ R7d：堆窗口 → 详情窗「从 C 站刷新」→ 堆里黄标也要消失 ============ */
  // 上一轮只测了选择器这条路径，堆面板 / 节点面板两条没测 —— 用户实际是盯着堆窗口看黄标的。
  const nodeDetail = makeNode(31, [
    { lora: "E/five.safetensors", name: "five", display_name: "Five", weight: 1 },
    { lora: "F/six.safetensors", name: "six", display_name: "Six", weight: 1 },
  ]);
  FAKE.extra = true;
  // R7b 的「查」按钮已把 five 标成命中，这里要复原成「都没信息」才能测黄标
  FAKE.resolved.delete("E/five.safetensors");
  FAKE.resolved.delete("F/six.safetensors");
  T.META_CACHE.clear();
  T.Store.invalidate();
  const smD = T.openStackManager(nodeDetail);
  await tick(160);
  const dBadges0 = smD.body.querySelectorAll(".cft-badge-warn").length;
  check("R7d 堆面板初始有 2 个黄标", dBadges0 === 2, String(dBadges0));
  const dName = smD.body.querySelector(".cft-stack-row .cft-name");
  check("R7d 堆行标题可点开详情", !!dName);
  if (dName) {
    dName.click();
    await tick(130);
    const dmD = [...document.querySelectorAll(".cft-detail-modal")].pop();
    const dBtn = dmD ? [...dmD.querySelectorAll("button")].find((b) => (b.textContent || "").includes("从 C 站刷新")) : null;
    check("R7d 详情窗有「↻ 从 C 站刷新」", !!dBtn);
    if (dBtn) {
      dBtn.click();
      await tick(360);
      const dBadges1 = smD.body.querySelectorAll(".cft-badge-warn").length;
      check("R7d 详情窗刷新后堆里该行黄标消失", dBadges1 === dBadges0 - 1, `${dBadges0} -> ${dBadges1}`);
      check("R7d 该行出现作者文本", (smD.body.textContent || "").includes("creator-x"), "");
      check("R7d entry._meta 已写回", T.readStack(nodeDetail).some((e) => e._meta && e._meta.creator === "creator-x"), "");
    }
    dmD?.remove();
  }
  smD.close();

  /* ============ R7e：/list 返回陈旧缺信息数据时，元数据不得回退 ============ */
  // 真实故障模式：刷新刚查到信息，紧接着的重扫因后端 20s 扫描缓存 / sidecar
  // 写入时序返回**缺信息**的旧条目，会把黄标打回原形。mergeMeta 必须兜住。
  {
    FAKE.extra = true;
    T.Store.invalidate();
    const first = await T.Store.list(true);
    const six = (first.items || []).find((i) => i.lora === "F/six.safetensors");
    T.META_CACHE.set("F/six.safetensors", { lora: "F/six.safetensors", creator: "cached-x", tags: ["t"], trained_words: ["w"], base_model: "SDXL", version_name: "v9", url: "https://civitai.com/models/42" });
    // 模拟后端回退：让 six 变成「未命中」状态
    FAKE.resolved.delete("F/six.safetensors");
    T.Store.invalidate();
    const second = await T.Store.list(true);
    const sixAfter = (second.items || []).find((i) => i.lora === "F/six.safetensors");
    check("R7e 陈旧 /list 不会抹掉已查到的作者", sixAfter && sixAfter.creator === "cached-x", sixAfter ? sixAfter.creator : "null");
    check("R7e 陈旧 /list 后仍判定为「不缺信息」", !!sixAfter && !T.isMissingMeta(sixAfter), "");
    check("R7e mergeMeta 让新数据优先", T.mergeMeta({ creator: "old" }, { creator: "new", tags: [] }).creator === "new", "");
    void six;
  }
  FAKE.extra = false;
  T.Store.invalidate();

  /* ============ R7f：侧车存在但字段不全的 lora 不得挂「无C站信息」黄标 ============ */
  // 用户真实截图：Anima V2 的详情窗里「数据来源 = C 站元数据文件」、基座/下载量/预览图齐全，
  // 但那份 .civitai.info 没有 creator/tags —— 旧判据只看三项，于是误挂黄标，怎么刷都没用。
  {
    FAKE.extra = true;
    T.Store.invalidate();
    // 前面的 R7c/R7d 把 six 标成了已命中并写进了 META_CACHE（mergeMeta 会正确地不让它
    // 倒退），对照组需要干净状态才能验证「真没信息 → 仍挂黄标」
    T.META_CACHE.clear();
    const nodeF = makeNode(61, []);
    const pickF = T.openPicker(nodeF, () => {});
    await tick(150);
    pickF.setView("grid");
    await tick(80);
    const wrapOf = (title) => [...pickF.body.querySelectorAll(".cft-card-wrap")]
      .find((c) => ((c.querySelector(".cft-card-title") || {}).textContent || "") === title);
    const wSeven = wrapOf("Anima V2");
    const wSix = wrapOf("Six");
    check("R7f 找到「Anima V2」卡片（复刻用户截图那条）", !!wSeven);
    check("R7f 有 C 站侧车但无 author/tags → 不挂黄标", !!wSeven && !wSeven.querySelector(".cft-chip-warn"), "");
    check("R7f 该卡片仍显示基座模型", !!wSeven && (wSeven.textContent || "").includes("Anima"), "");
    check("R7f 对照组：完全没 C 站信息的 lora 仍挂黄标", !!wSix && !!wSix.querySelector(".cft-chip-warn"), "");
    // 但它仍值得按哈希查一次（可能补上作者），所以要在批量名单里
    const targets = pickF._missingItems().map((i) => i.lora);
    check("R7f 字段不全的 lora 仍在批量查询名单里", targets.includes("G/seven.safetensors"), targets.join(","));
    check("R7f 已有作者的 lora 不在批量名单里", !targets.includes("A/one.safetensors"), targets.join(","));
    pickF.close();
  }
  FAKE.extra = false;
  T.Store.invalidate();

  /* ============ R8：窄窗口下「启用」开关与操作按钮不得重叠 ============ */
  // 用户把堆窗口调窄（竖长条放左侧）后，启用开关和 ↑ ↓ ✕ 画在了一起。
  // 旧 grid 写法：操作列写死 66px（实际需要 89px）+ 控件列不换行 → 溢出重叠。
  {
    // 用独立节点，避免单例复用前面还开着的堆窗口导致量到已脱离布局的元素
    const nodeN = makeNode(41, [
      { lora: "A/one.safetensors", name: "one", display_name: "One", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
      { lora: "B/two.safetensors", name: "two", display_name: "Two", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
    ]);
    const smN = T.openStackManager(nodeN);
    await tick(80);
    // R2 的最小化用例把 minimized 持久化进了 localStorage，新窗口会继承收起态
    // （此时 body 是 display:none，量到的 rect 全是 0），先展开再量。
    if (smN.root.classList.contains("cft-minimized")) smN.toggleMinimize();
    await tick(60);
    smN._applyGeomSize({ left: 40, top: 40, width: 380, height: 620 });
    await tick(120);
    const nRow0 = smN.body.querySelector(".cft-stack-row");
    const rr = smN.root.getBoundingClientRect();
    const br = smN.body.getBoundingClientRect();
    check(
      "R8 堆窗口已打开且在布局中",
      smN._opened && smN.root.isConnected && nRow0 && nRow0.getBoundingClientRect().width > 0,
      `root=${Math.round(rr.width)}x${Math.round(rr.height)} body=${Math.round(br.width)}x${Math.round(br.height)} `
        + `row=${nRow0 ? Math.round(nRow0.getBoundingClientRect().width) : "null"} min=${smN.root.classList.contains("cft-minimized")}`
    );
    smN._applyGeomSize({ left: 40, top: 40, width: 380, height: 620 });
    await tick(120);
    const rowN = smN.body.querySelector(".cft-stack-row");
    const toggleN = rowN ? rowN.querySelector(".cft-field-toggle") : null;
    const actionsN = rowN ? rowN.querySelector(".cft-row-actions") : null;
    check("R8 存在启用开关与操作列", !!toggleN && !!actionsN);
    if (toggleN && actionsN) {
      const t1 = toggleN.getBoundingClientRect();
      const t2 = actionsN.getBoundingClientRect();
      const overlap = !(t1.right <= t2.left || t2.right <= t1.left || t1.bottom <= t2.top || t2.bottom <= t1.top);
      check("R8 启用开关与操作按钮不重叠", !overlap, `toggle=${Math.round(t1.left)}~${Math.round(t1.right)} actions=${Math.round(t2.left)}~${Math.round(t2.right)}`);
      const btnsN = [...actionsN.querySelectorAll(".cft-icon-btn")];
      check("R8 操作按钮不被压扁（>=27px）", btnsN.length === 3 && btnsN.every((b) => b.getBoundingClientRect().width >= 26), btnsN.map((b) => Math.round(b.getBoundingClientRect().width)).join(","));
      const rowRect = rowN.getBoundingClientRect();
      check("R8 行内容不横向溢出", rowRect.width > 0 && rowN.scrollWidth <= rowRect.width + 2, `row=${Math.round(rowRect.width)} scroll=${rowN.scrollWidth}`);
      const ctrlN = rowN.querySelector(".cft-row-controls");
      const fldW = [...ctrlN.children].map((f) => Math.round(f.getBoundingClientRect().width));
      const ctrlLines = new Set([...ctrlN.children].map((f) => Math.round(f.getBoundingClientRect().top))).size;
      check(
        "R8 控件区自身不横向溢出",
        ctrlN.scrollWidth <= ctrlN.clientWidth + 2,
        `ctrl=${Math.round(ctrlN.clientWidth)} scroll=${ctrlN.scrollWidth} 字段宽=${fldW.join("/")} 占${ctrlLines}行`
      );
    }
    // 宽窗口下仍应是单行（不回归）
    smN._applyGeomSize({ left: 40, top: 40, width: 1020, height: 620 });
    await tick(120);
    const rowW = smN.body.querySelector(".cft-stack-row");
    if (rowW) {
      const tg = rowW.querySelector(".cft-field-toggle").getBoundingClientRect();
      const ac = rowW.querySelector(".cft-row-actions").getBoundingClientRect();
      check("R8 宽窗口下同行对齐（垂直不跨行）", Math.abs(tg.top - ac.top) < 12, `top差=${Math.round(Math.abs(tg.top - ac.top))}`);
    }
    smN.close();
  }

  /* ============ R9：前端版本标记可见（确认跑的是最新 JS） ============ */
  {
    const nodeV = makeNode(51, [{ lora: "A/one.safetensors", name: "one", display_name: "One", weight: 1 }]);
    const smV = T.openStackManager(nodeV);
    await tick(60);
    const ver = smV.footer ? smV.footer.querySelector(".cft-footer-ver") : null;
    check("R9 页脚显示前端版本号", !!ver && /v\d/.test(ver.textContent || ""), ver ? ver.textContent : "null");
    smV.close();
  }

  /* ============ R10：右键菜单 —— 堆行 / 选择器卡片 / 节点面板 ============ */
  {
    // 第四批起删除流程走自绘框，不再需要 stub confirm / prompt / alert。
    // （window.prompt 已在 main() 开头换成「调用即抛错」的护栏，这里绝不能覆盖它）
    const nodeR = makeNode(71, [
      { lora: "A/one.safetensors", name: "one", display_name: "One", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
      { lora: "B/two.safetensors", name: "two", display_name: "Two", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
    ]);
    const smR = T.openStackManager(nodeR);
    await tick(90);
    const rRow = smR.body.querySelector(".cft-stack-row");
    check("R10 堆行可右键", !!rRow && rRow.classList.contains("cft-ctxable"));
    if (rRow) {
      const rect = rRow.getBoundingClientRect();
      rRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 12 }));
      await tick(20);
      const menu = document.querySelector(".cft-ctxmenu");
      check("R10 右键后菜单出现", !!menu);
      const items = menu ? [...menu.querySelectorAll(".cft-ctxmenu-item")].map((b) => b.textContent) : [];
      check("R10 菜单含「跳转到所在文件夹」", items.some((t) => t.includes("跳转到所在文件夹")), items.join(" | "));
      check("R10 菜单含「查看本地文件清单」", items.some((t) => t.includes("查看本地文件清单")), items.join(" | "));
      check("R10 菜单含「本地删除」", items.some((t) => t.includes("本地删除")), items.join(" | "));
      check("R10 菜单含「从堆中移除」", items.some((t) => t.includes("从堆中移除")), items.join(" | "));
      check("R10 删除项标为危险色", !!menu && !!menu.querySelector(".cft-ctxmenu-danger"));
      check("R10 菜单有分隔线", !!menu && menu.querySelectorAll(".cft-ctxmenu-sep").length >= 2, menu ? String(menu.querySelectorAll(".cft-ctxmenu-sep").length) : "0");

      // 菜单定位不得跑出视口
      if (menu) {
        const mr = menu.getBoundingClientRect();
        check("R10 菜单在视口内", mr.left >= 0 && mr.top >= 0 && mr.right <= window.innerWidth + 2 && mr.bottom <= window.innerHeight + 2,
          `${Math.round(mr.left)},${Math.round(mr.top)},${Math.round(mr.right)},${Math.round(mr.bottom)} vp=${window.innerWidth}x${window.innerHeight}`);
        const z = parseInt(getComputedStyle(menu).zIndex, 10);
        const maskZ = parseInt(getComputedStyle(smR.mask).zIndex, 10);
        check("R10 菜单 z-index 高于弹窗遮罩", z > maskZ, `menu=${z} mask=${maskZ}`);
      }

      // 「跳转到所在文件夹」→ 应打到 /reveal 且带 name + mode=select
      const revealItem = menu ? [...menu.querySelectorAll(".cft-ctxmenu-item")].find((b) => b.textContent.includes("跳转到所在文件夹")) : null;
      const callsBeforeReveal = (globalThis.__CFT_CALLS__ || []).length;
      if (revealItem) { revealItem.click(); await tick(60); }
      const revealCall = (globalThis.__CFT_CALLS__ || []).slice(callsBeforeReveal).find((c) => c.url.endsWith("/cft_lora/reveal"));
      check("R10 「跳转文件夹」发起 /reveal", !!revealCall);
      if (revealCall) {
        check("R10 /reveal 带 lora 名与 mode=select", revealCall.body.name === "A/one.safetensors" && revealCall.body.mode === "select", JSON.stringify(revealCall.body));
      }

      // Esc 关闭菜单
      rRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 12 }));
      await tick(20);
      check("R10 再次右键菜单重新出现", !!document.querySelector(".cft-ctxmenu"));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await tick(20);
      check("R10 Esc 关闭菜单（堆窗口仍在）", !document.querySelector(".cft-ctxmenu") && smR._opened === true, "");

      // 「本地删除」→ 自绘文件清单框 → 选「移到隔离区」→ 直接执行（可还原，无需二次确认）
      FAKE.deleted.length = 0;
      rRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 12 }));
      await tick(20);
      const delItem = document.querySelector(".cft-ctxmenu")
        ? [...document.querySelectorAll(".cft-ctxmenu-item")].find((b) => b.textContent.includes("本地删除"))
        : null;
      check("R10 菜单含「本地删除」项可点", !!delItem);
      if (delItem) { delItem.click(); await tick(140); }
      const askR = [...document.querySelectorAll(".cft-ask-modal")].pop();
      check("R10 删除前弹出自绘文件清单（不是原生 confirm/prompt）", !!askR);
      check("R10 清单里列出 3 个文件（含预览图/信息文件）", !!askR && (askR.textContent || "").includes("3 个本地文件"), askR ? (askR.textContent || "").slice(0, 90) : "");
      check("R10 清单标明模型本体", !!askR && (askR.textContent || "").includes("模型本体"), "");
      const qR = askR ? [...askR.querySelectorAll("button")].find((b) => b.textContent.includes("移到隔离区")) : null;
      check("R10 提供隔离 / 永久两种方式", !!qR && !!findIn(askR, "button", "彻底删除"), "");
      if (qR) { qR.click(); await tick(180); }
      const delCall = FAKE.deleted.find((d) => d.name === "A/one.safetensors");
      check("R10 发起 delete_local", !!delCall, JSON.stringify(FAKE.deleted));
      check("R10 默认走隔离区（permanent=false）", !!delCall && delCall.permanent === false, delCall ? String(delCall.permanent) : "");
      check("R10 默认包含模型本体", !!delCall && delCall.include_body === true, "");
      check("R10 删除后该 lora 已从堆里移除", !T.readStack(nodeR).some((e) => e.lora === "A/one.safetensors"), JSON.stringify(T.readStack(nodeR).map((e) => e.lora)));
      // 剩下一行，行数应减少
      check("R10 堆里剩 1 行", T.readStack(nodeR).length === 1, String(T.readStack(nodeR).length));

      // 「从堆中移除」只动堆，不动磁盘
      FAKE.deleted.length = 0;
      const rRow2 = smR.body.querySelector(".cft-stack-row");
      if (rRow2) {
        const r2 = rRow2.getBoundingClientRect();
        rRow2.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r2.left + 30, clientY: r2.top + 12 }));
        await tick(20);
        const rmItem = document.querySelector(".cft-ctxmenu")
          ? [...document.querySelectorAll(".cft-ctxmenu-item")].find((b) => b.textContent.includes("从堆中移除"))
          : null;
        if (rmItem) { rmItem.click(); await tick(60); }
        check("R10 「从堆中移除」不删磁盘文件", FAKE.deleted.length === 0, JSON.stringify(FAKE.deleted));
        check("R10 「从堆中移除」后堆为空", T.readStack(nodeR).length === 0, String(T.readStack(nodeR).length));
      }
    }
    smR.close();

    // 选择器卡片右键
    const nodeRP = makeNode(72, []);
    const pickR = T.openPicker(nodeRP, () => {});
    await tick(120);
    pickR.setView("grid");
    await tick(60);
    const cardR = pickR.body.querySelector(".cft-card-wrap");
    check("R10 选择器卡片可右键", !!cardR && cardR.classList.contains("cft-ctxable"));
    if (cardR) {
      const cr = cardR.getBoundingClientRect();
      cardR.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: cr.left + 20, clientY: cr.top + 20 }));
      await tick(20);
      const menu2 = document.querySelector(".cft-ctxmenu");
      check("R10 卡片右键菜单出现", !!menu2);
      const items2 = menu2 ? [...menu2.querySelectorAll(".cft-ctxmenu-item")].map((b) => b.textContent) : [];
      check("R10 卡片菜单含跳转与删除", items2.some((t) => t.includes("跳转到所在文件夹")) && items2.some((t) => t.includes("本地删除")), items2.join(" | "));
      check("R10 卡片菜单不含「从堆中移除」（它不在堆里）", !items2.some((t) => t.includes("从堆中移除")), items2.join(" | "));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    // 列表行也要能右键
    pickR.setView("list");
    await tick(60);
    const listRowR = pickR.body.querySelector(".cft-list-row");
    check("R10 选择器列表行可右键", !!listRowR && listRowR.classList.contains("cft-ctxable"));
    pickR.close();

    // 节点内嵌面板行也要能右键
    const npR = nodeA._dom && nodeA._dom.el;
    const npRow = npR ? npR.querySelector(".cft-np-row") : null;
    check("R10 节点面板行可右键", !!npRow && npRow.classList.contains("cft-ctxable"), npRow ? npRow.className : "null");
  }

  /* ============ R11：清理窗口 —— 分类勾选 / 合计 / 隔离区 / 安全提示 ============ */
  {
    const nodeC = makeNode(81, []);
    // v2.15：清理入口只在「＋ 添加 Lora」选择器里，堆窗口已经把它撤了
    const smC = T.openStackManager(nodeC);
    await tick(60);
    check("R11 堆窗口已没有「清理垃圾」按钮", !findIn(smC.headerExtra, "button", "清理垃圾"), "");
    smC.close();
    await tick(40);
    const pkC = T.openPicker(nodeC, () => {});
    await tick(90);
    const cleanBtn = findIn(pkC.toolbar, "button", "清理垃圾");
    check("R11 选择器工具栏有「🧹 清理垃圾」按钮", !!cleanBtn);

    if (cleanBtn) {
      cleanBtn.click();
      await tick(140);
      const cm = document.querySelector(".cft-cleanup-modal");
      check("R11 清理窗口已打开", !!cm && cm.getBoundingClientRect().width > 0);
      check("R11 清理窗口是单例", T.OPEN_MODALS.get("cleanup") !== undefined);
      if (cm) {
        const groups = [...cm.querySelectorAll(".cft-cleanup-g-wrap")];
        check("R11 列出 5 个分类", groups.length === 5, String(groups.length));
        check("R11 显示总文件数与体积", (cm.querySelector(".cft-cleanup-banner") || {}).textContent?.includes("52 个"), cm.querySelector(".cft-cleanup-banner")?.textContent || "");
        check("R11 显示「模型本体不会被清理」的安全提示", (cm.textContent || "").includes("永远不会被清理"), "");
        check("R11 通用 .json 分类默认不勾选", (() => {
          const boxes = groups.map((g) => g.querySelector('input[type="checkbox"]'));
          return boxes[4] && boxes[4].checked === false && boxes[4].disabled === false;
        })(), "");
        check("R11 0 字节分类计数为 0 且复选框禁用", (() => {
          const b = groups[3].querySelector('input[type="checkbox"]');
          return b && b.disabled === true;
        })(), "");
        check("R11 默认勾选的分类展开了文件列表", !!cm.querySelector(".cft-cleanup-files"), "");
        check("R11 文件列表显示相对路径", (cm.querySelector(".cft-cleanup-file-rel") || {}).textContent?.includes(".preview.png"), cm.querySelector(".cft-cleanup-file-rel")?.textContent || "");
        check("R11 默认是隔离模式（footer 显示可还原）", (cm.querySelector(".cft-footer-info") || {}).textContent?.includes("可还原"), cm.querySelector(".cft-footer-info")?.textContent || "");
        const permBox = cm.querySelector(".cft-cleanup-perm input");
        check("R11 有「彻底删除」复选框且默认不勾选", !!permBox && permBox.checked === false);

        // 勾选状态变化 → 合计随之变化
        const footerBefore = cm.querySelector(".cft-footer-info").textContent;
        const jsonBox = groups[4].querySelector('input[type="checkbox"]');
        jsonBox.checked = true;
        jsonBox.dispatchEvent(new Event("change", { bubbles: true }));
        await tick(40);
        const footerAfter = document.querySelector(".cft-cleanup-modal .cft-footer-info").textContent;
        check("R11 勾上通用 .json 后合计变化", footerBefore !== footerAfter, `${footerBefore} -> ${footerAfter}`);
        check("R11 合计含勾选分类的数量（0 个文件的分类不计入）", footerAfter.includes("已选 4 类"), footerAfter);

        // 只留 preview + partial 两类要清：便于清理后仍能查某一类的计数是否归零
        for (const gi of [1, 4]) {
          const bx = groups[gi].querySelector('input[type="checkbox"]');
          if (bx && bx.checked) { bx.checked = false; bx.dispatchEvent(new Event("change", { bubbles: true })); }
          await tick(30);
        }
        const footerPicked = document.querySelector(".cft-cleanup-modal .cft-footer-info").textContent;
        check("R11 取消勾选后合计收窄到 2 类", footerPicked.includes("已选 2 类"), footerPicked);

        // 执行清理（默认隔离）
        const before = (globalThis.__CFT_CALLS__ || []).length;
        const runBtn = [...document.querySelectorAll(".cft-cleanup-modal button")].find((b) => b.textContent === "清理所选");
        check("R11 有「清理所选」按钮", !!runBtn && !runBtn.disabled);
        if (runBtn) { runBtn.click(); await tick(120); }
        // 第四批起清理确认也走自绘框（原 window.confirm，Electron 虽可用但观感差）
        const askRun = [...document.querySelectorAll(".cft-ask-modal")].pop();
        check("R11 清理前弹出自我绘确认框（不再用原生 confirm）", !!askRun);
        const okRun = askRun ? [...askRun.querySelectorAll("button")].find((b) => b.textContent.trim() === "移到隔离区") : null;
        check("R11 确认按钮文案为「移到隔离区」", !!okRun, okRun ? okRun.textContent : "");
        if (okRun) { okRun.click(); await tick(220); }
        const cleanCall = (globalThis.__CFT_CALLS__ || []).slice(before).find((c) => c.url.endsWith("/cft_lora/cleanup"));
        check("R11 发起 /cleanup 请求", !!cleanCall);
        if (cleanCall) {
          const cats = cleanCall.body.categories || [];
          check("R11 请求带分类清单（只含勾选的两类）", JSON.stringify(cats) === JSON.stringify(["orphan_preview", "partial"]), JSON.stringify(cats));
          check("R11 0 个文件的分类不进请求（省一次无用扫描）", !cats.includes("empty_file"), JSON.stringify(cats));
          check("R11 未勾选的分类不进请求", !cats.includes("orphan_meta") && !cats.includes("orphan_json"), JSON.stringify(cats));
          check("R11 默认 permanent=false", cleanCall.body.permanent === false, JSON.stringify(cleanCall.body));
        }
        check("R11 清理后窗口仍在（可继续操作）", !!document.querySelector(".cft-cleanup-modal"));
        check("R11 清理后重新扫描，被清的两类计数归零", (() => {
          const gs = [...document.querySelectorAll(".cft-cleanup-modal .cft-cleanup-g-wrap")];
          const cnt = (i) => (gs[i].querySelector(".cft-cleanup-g-count") || {}).textContent;
          return cnt(0) === "0 个" && cnt(2) === "0 个";
        })(), (() => {
          const gs = [...document.querySelectorAll(".cft-cleanup-modal .cft-cleanup-g-wrap")];
          return gs.map((g) => (g.querySelector(".cft-cleanup-g-count") || {}).textContent).join("/");
        })());
        check("R11 未勾选的分类计数不变", (() => {
          const gs = [...document.querySelectorAll(".cft-cleanup-modal .cft-cleanup-g-wrap")];
          return (gs[1].querySelector(".cft-cleanup-g-count") || {}).textContent === "30 个";
        })(), (() => {
          const gs = [...document.querySelectorAll(".cft-cleanup-modal .cft-cleanup-g-wrap")];
          return gs.map((g) => (g.querySelector(".cft-cleanup-g-count") || {}).textContent).join("/");
        })());
        check("R11 清理后按钮禁用（无选中分类可清）", (() => {
          const b = [...document.querySelectorAll(".cft-cleanup-modal button")].find((x) => /清理所选|彻底删除所选/.test(x.textContent));
          return !!b && b.disabled;
        })(), "");

        // 隔离区入口：这里只验证「点得开」（完整还原流程见 R13）
        const trashBtn = [...document.querySelectorAll(".cft-cleanup-modal button")].find((b) => b.textContent === "打开隔离区");
        check("R11 有「打开隔离区」按钮", !!trashBtn);
        if (trashBtn) { trashBtn.click(); await tick(160); }
        check("R11 点「打开隔离区」真的打开窗口（不再毫无反应）", document.querySelectorAll(".cft-trash-modal").length === 1, String(document.querySelectorAll(".cft-trash-modal").length));
        T.OPEN_MODALS.get("trash")?.close();
        await tick(40);

        // 永久删除开关
        const pm = document.querySelector(".cft-cleanup-modal .cft-cleanup-perm input");
        pm.checked = true;
        pm.dispatchEvent(new Event("change", { bubbles: true }));
        await tick(40);
        const runBtn2 = [...document.querySelectorAll(".cft-cleanup-modal button")].find((b) => b.textContent === "彻底删除所选");
        check("R11 勾选后按钮变「彻底删除所选」且变红", !!runBtn2 && runBtn2.classList.contains("cft-btn-danger"), runBtn2 ? runBtn2.className : "null");
        check("R11 永久模式 footer 提示已切换", (document.querySelector(".cft-cleanup-modal .cft-footer-info") || {}).textContent?.includes("彻底删除"), document.querySelector(".cft-cleanup-modal .cft-footer-info")?.textContent || "");
      }
    }
    // 关掉清理窗口：必须走 close()（只摘 DOM 会在单例注册表里留下 _opened 实例，
    // 之后 openCleanup 会 focus 到一个已脱离布局的窗口）
    T.OPEN_MODALS.get("cleanup")?.close();
    document.querySelectorAll(".cft-cleanup-modal").forEach((el) => el.parentElement?.remove());
    smC.close();
  }

  /* ============ R12：fmtBytes + Store 接口存在性 ============ */
  {
    check("R12 fmtBytes B", T.fmtBytes(512) === "512 B", T.fmtBytes(512));
    check("R12 fmtBytes KB", T.fmtBytes(2048) === "2.0 KB", T.fmtBytes(2048));
    check("R12 fmtBytes MB", T.fmtBytes(5 * 1024 * 1024) === "5.00 MB", T.fmtBytes(5 * 1024 * 1024));
    check("R12 fmtBytes GB", T.fmtBytes(3 * 1024 ** 3) === "3.00 GB", T.fmtBytes(3 * 1024 ** 3));
    check("R12 fmtBytes 0/负数", T.fmtBytes(0) === "0 B" && T.fmtBytes(-5) === "0 B", `${T.fmtBytes(0)}/${T.fmtBytes(-5)}`);

    for (const fn of ["cleanupScan", "cleanupRun", "cleanupTrash", "cleanupRestore", "bundle", "reveal", "deleteLocal"]) {
      check(`R12 Store.${fn} 存在`, typeof T.Store[fn] === "function");
    }
    check("R12 openCleanup 入口存在", typeof T.openCleanup === "function");
    check("R12 CleanupModal 已导出", typeof T.CleanupModal === "function");
    check("R12 ContextMenu 已导出", typeof T.ContextMenu === "object" || typeof T.ContextMenu?.open === "function");
    check("R12 前端版本号已升到 2.36", T.FRONTEND_VERSION === "2.36", T.FRONTEND_VERSION);

    // Store 层直连：确认请求路径与参数正确
    const before = (globalThis.__CFT_CALLS__ || []).length;
    const bundle = await T.Store.bundle("A/one.safetensors");
    const bcall = (globalThis.__CFT_CALLS__ || []).slice(before).find((c) => c.url.includes("/cft_lora/bundle"));
    check("R12 Store.bundle 请求带 name", !!bcall && bcall.url.includes("name=A%2Fone.safetensors"), bcall ? bcall.url : "null");
    check("R12 Store.bundle 返回文件清单", !!bundle && bundle.files.length === 3 && bundle.files[0].kind === "lora", JSON.stringify(bundle?.files?.map((f) => f.kind)));
    check("R12 bundle 标出本体 required", !!bundle && bundle.files[0].required === true, "");

    const before2 = (globalThis.__CFT_CALLS__ || []).length;
    // 用 orphan_meta：R11 只清掉了 orphan_preview + partial，这一类还有 30 个文件，
    // 才能验证 dry-run 真的回候选数（R11 起「打开隔离区」不再顺手还原）。
    const dry = await T.Store.cleanupRun(["orphan_meta"], { dryRun: true });
    const dcall = (globalThis.__CFT_CALLS__ || []).slice(before2).find((c) => c.url.endsWith("/cft_lora/cleanup"));
    check("R12 cleanupRun 传 dry_run", !!dcall && dcall.body.dry_run === true, JSON.stringify(dcall?.body));
    check("R12 dry-run 返回候选数而不真删", !!dry && dry.dry_run === true && dry.candidate_count > 0, JSON.stringify(dry));

    // 隔离批次形态：先做一次清理造出批次，再读列表
    await T.Store.cleanupRun(["orphan_preview"], {});
    const tr = await T.Store.cleanupTrash();
    check("R12 cleanupTrash 返回批次数组", Array.isArray(tr) && tr.length >= 1 && !!tr[0].stamp, JSON.stringify(tr).slice(0, 140));
    check("R12 批次含 count/size/original_root", !!tr[0] && typeof tr[0].count === "number" && typeof tr[0].size === "number" && !!tr[0].original_root, JSON.stringify(tr[0] || {}).slice(0, 140));
    check("R12 批次 id 唯一（不会撞进同一目录）", new Set(tr.map((b) => b.stamp)).size === tr.length, tr.map((b) => b.stamp).join(","));
    check("R12 隔离批次可还原", typeof T.Store.cleanupRestore === "function" && (await T.Store.cleanupRestore(tr[0].stamp)).restored > 0, "");
  }

  /* ============ R13：隔离区窗口（修「点『打开隔离区』没反应」） ============ */
  {
    const nodeT = makeNode(101, []);
    // v2.15：堆窗口的「清理垃圾」已撤（全局维护动作只留一份在选择器里），
    // 所以这里改从选择器工具栏进去，验的仍是同一条链路：清理窗 → 隔离区窗
    const pkT = T.openPicker(nodeT, () => {});
    await tick(90);
    const cleanBtnT = findIn(pkT.toolbar, "button", "清理垃圾");
    check("R13 选择器有「清理垃圾」入口", !!cleanBtnT);
    if (cleanBtnT) { cleanBtnT.click(); await tick(160); }
    const cmT = document.querySelector(".cft-cleanup-modal");
    check("R13 清理窗口已打开", !!cmT && cmT.getBoundingClientRect().width > 0);

    const trashBtnT = cmT ? [...cmT.querySelectorAll("button")].find((b) => b.textContent === "打开隔离区") : null;
    check("R13 有「打开隔离区」按钮", !!trashBtnT);
    if (trashBtnT) { trashBtnT.click(); await tick(200); }

    const tm = document.querySelector(".cft-trash-modal");
    check("R13 隔离区窗口真的打开了（不再是死按钮）", !!tm && document.querySelectorAll(".cft-trash-modal").length === 1);
    const rows0 = tm ? tm.querySelectorAll(".cft-trash-row").length : 0;
    check("R13 批次行数 = FAKE.trash.length", rows0 === FAKE.trash.length && rows0 >= 1, `${rows0} vs ${FAKE.trash.length}`);
    check("R13 批次行展示文件数与体积", !!tm && /个文件 · /.test((tm.querySelector(".cft-trash-row") || {}).textContent || ""), tm ? (tm.querySelector(".cft-trash-row") || {}).textContent : "");
    check("R13 批次号被格式化成时间", !!tm && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(((tm.querySelector(".cft-trash-stamp") || {}).textContent || "").trim()), tm ? (tm.querySelector(".cft-trash-stamp") || {}).textContent : "");

    const firstStamp = FAKE.trash[0].stamp;
    const beforeRestore = (globalThis.__CFT_CALLS__ || []).length;
    const rowBtn = tm ? tm.querySelector(".cft-trash-row .cft-trash-actions button") : null;
    check("R13 批次行有「还原」按钮", !!rowBtn && rowBtn.textContent === "还原");
    if (rowBtn) { rowBtn.click(); await tick(120); }
    const askT = [...document.querySelectorAll(".cft-ask-modal")].pop();
    check("R13 还原前弹自绘确认（不是 prompt）", !!askT);
    check("R13 确认框提到批次号与文件数", !!askT && (askT.textContent || "").includes(firstStamp) && (askT.textContent || "").includes("个文件"), askT ? (askT.textContent || "").slice(0, 80) : "");
    const okT = askT ? [...askT.querySelectorAll("button")].find((b) => b.textContent.trim() === "还原") : null;
    check("R13 确认按钮文案为「还原」", !!okT);
    if (okT) { okT.click(); await tick(240); }

    const restoreCall = (globalThis.__CFT_CALLS__ || []).slice(beforeRestore).find((c) => c.url.endsWith("/cft_lora/cleanup_restore"));
    check("R13 发起 /cleanup_restore", !!restoreCall);
    check("R13 还原的 stamp 正确", !!restoreCall && restoreCall.body.stamp === firstStamp, `${restoreCall?.body?.stamp} vs ${firstStamp}`);
    const rows1 = document.querySelectorAll(".cft-trash-modal .cft-trash-row").length;
    check("R13 还原后行数 -1", rows1 === rows0 - 1, `${rows0} -> ${rows1}`);

    T.OPEN_MODALS.get("trash")?.close();
    await tick(40);
    T.OPEN_MODALS.get("cleanup")?.close();
    document.querySelectorAll(".cft-cleanup-modal").forEach((el) => el.parentElement?.remove());
    pkT.close();
  }

  /* ============ R14：本地删除改自绘三步（不再用 prompt） ============ */
  {
    // 隔离路径
    FAKE.deleted.length = 0;
    const p1 = T.deleteLoraLocal("A/one.safetensors", () => {}, () => {}, false);
    await tick(120);
    const ask1 = [...document.querySelectorAll(".cft-ask-modal")].pop();
    check("R14 弹出自我绘删除框（不是 prompt）", !!ask1);
    check("R14 框内列出文件清单表格", !!ask1 && !!ask1.querySelector(".cft-ask-list"));
    check("R14 清单标明「模型本体」", !!ask1 && (ask1.textContent || "").includes("模型本体"), "");
    check("R14 清单写明 3 个本地文件与合计体积", !!ask1 && (ask1.textContent || "").includes("3 个本地文件") && (ask1.textContent || "").includes("合计"), ask1 ? (ask1.textContent || "").slice(0, 90) : "");
    const qBtn = ask1 ? [...ask1.querySelectorAll("button")].find((b) => b.textContent.includes("移到隔离区")) : null;
    check("R14 有「移到隔离区（推荐）」按钮", !!qBtn);
    if (qBtn) { qBtn.click(); }
    const r1 = await p1;
    await tick(60);
    const call1 = FAKE.deleted.find((d) => d.name === "A/one.safetensors");
    check("R14 隔离路径发出 delete_local 且 permanent=false", !!call1 && call1.permanent === false, JSON.stringify(FAKE.deleted));
    check("R14 隔离路径返回结果对象", !!r1 && r1.removed === 3, JSON.stringify(r1));

    // 彻底删除路径：必须先出二次确认
    FAKE.deleted.length = 0;
    const p2 = T.deleteLoraLocal("A/one.safetensors", () => {}, () => {}, false);
    await tick(120);
    const ask2 = [...document.querySelectorAll(".cft-ask-modal")].pop();
    const dBtn = ask2 ? [...ask2.querySelectorAll("button")].find((b) => b.textContent.includes("彻底删除")) : null;
    check("R14 有「彻底删除（不可还原）」按钮", !!dBtn);
    if (dBtn) { dBtn.click(); await tick(120); }
    const ask3 = [...document.querySelectorAll(".cft-ask-modal")].pop();
    check("R14 彻底删除前先出二次确认框", !!ask3 && ask3 !== ask2);
    check("R14 二次确认写明「无法还原」", !!ask3 && (ask3.textContent || "").includes("无法还原"), ask3 ? (ask3.textContent || "").slice(0, 80) : "");
    const confirm2 = ask3 ? [...ask3.querySelectorAll("button")].find((b) => b.textContent.trim() === "彻底删除") : null;
    check("R14 二次确认按钮文案为「彻底删除」", !!confirm2);
    if (confirm2) { confirm2.click(); }
    const r2 = await p2;
    await tick(60);
    const call2 = FAKE.deleted.find((d) => d.name === "A/one.safetensors");
    check("R14 彻底删除 permanent=true", !!call2 && call2.permanent === true, JSON.stringify(FAKE.deleted));
    check("R14 彻底删除也返回结果对象", !!r2 && r2.permanent === true, JSON.stringify(r2));

    // 取消路径：必须不发请求、返回 null
    FAKE.deleted.length = 0;
    const p3 = T.deleteLoraLocal("A/one.safetensors", () => {}, () => {}, false);
    await tick(120);
    const ask4 = [...document.querySelectorAll(".cft-ask-modal")].pop();
    const cBtn = ask4 ? [...ask4.querySelectorAll("button")].find((b) => b.textContent.trim() === "取消") : null;
    check("R14 有「取消」按钮", !!cBtn);
    if (cBtn) { cBtn.click(); }
    const r3 = await p3;
    check("R14 取消返回 null", r3 === null, String(r3));
    check("R14 取消不发 delete_local", FAKE.deleted.length === 0, JSON.stringify(FAKE.deleted));
    check("R14 全程未调用 window.prompt", PROMPT_CALLS === 0, String(PROMPT_CALLS));

    // 清理可能残留的对话框
    document.querySelectorAll(".cft-ask-modal").forEach((el) => el.parentElement?.remove());
  }

  /* ============ R15：详情窗自定义标签 / 说明 + 选择器按标签筛选 / 搜索 ============ */
  {
    FAKE.samples = true;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "A/one.safetensors";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const dmU = new T.DetailModal("A/one.safetensors", () => {});
    dmU.open();
    await tick(150);
    const sec = dmU.body.querySelector(".cft-user-section");
    check("R15 详情窗有「我的标签 / 说明」一节", !!sec);
    check("R15 即便没有自定义内容也显示该节（否则找不到入口）", !!sec && !!sec.querySelector(".cft-input") && !!sec.querySelector(".cft-textarea"));
    check("R15 标题旁提示「仅本地保存」", !!sec && (sec.textContent || "").includes("刷新 C 站不会覆盖"), "");

    const inp = sec.querySelector(".cft-input");
    inp.value = "测试标签";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await tick(140);
    check("R15 回车添加标签后立即出现标签 chip", !!sec.querySelector(".cft-tag-user") && (sec.textContent || "").includes("测试标签"), "");

    const ta = sec.querySelector(".cft-textarea");
    ta.value = "hello";
    // v2.19：没有「保存」按钮了，说明失焦即自动保存
    ta.dispatchEvent(new Event("blur"));
    await tick(160);

    const umCalls = (globalThis.__CFT_CALLS__ || []).filter((c) => c.url.endsWith("/cft_lora/user_meta") && c.method === "POST");
    const umLast = umCalls[umCalls.length - 1];
    check("R15 说明失焦自动保存，发出 POST /user_meta", !!umLast, JSON.stringify(umCalls.map((c) => c.body)));
    check("R15 body.tags 含「测试标签」", !!umLast && (umLast.body.tags || []).includes("测试标签"), JSON.stringify(umLast?.body));
    check("R15 body.note === 'hello'", !!umLast && umLast.body.note === "hello", String(umLast?.body?.note));
    check("R15 标签里的 ✕ 可删除", !!sec.querySelector(".cft-tag-x"), "");

    // 选择器：标签下拉 + 按标签筛选 + 用说明内容搜索
    T.Store.invalidate();
    const nodeU = makeNode(121, []);
    const pickU = T.openPicker(nodeU, () => {});
    await tick(170);
    pickU.setView("grid");
    await tick(80);

    const selects = [...pickU.body.querySelectorAll("select.cft-select")];
    const tagSel = selects.find((s) => [...s.options].some((o) => o.value === "测试标签"));
    check("R15 选择器下拉出现该标签选项", !!tagSel, selects.map((s) => [...s.options].map((o) => o.value).join("|")).join(" ; "));
    const allCards = () => pickU.grid.querySelectorAll(".cft-card-wrap").length;
    check("R15 未筛选时卡片多于 1 条", allCards() > 1, String(allCards()));
    if (tagSel) {
      tagSel.value = "测试标签";
      tagSel.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(90);
      check("R15 按「测试标签」筛选后只剩 1 条", allCards() === 1, String(allCards()));
      const onlyCard = pickU.grid.querySelector(".cft-card-wrap");
      check("R15 该卡片带 .cft-tag-user", !!onlyCard && !!onlyCard.querySelector(".cft-tag-user"), "");
      tagSel.value = "";
      tagSel.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(60);
    }
    const searchInp = pickU.toolbar.querySelector(".cft-search");
    searchInp.value = "hello";
    searchInp.dispatchEvent(new Event("input", { bubbles: true }));
    await tick(90);
    check("R15 搜索说明内容 'hello' 命中该条", allCards() === 1, String(allCards()));
    searchInp.value = "bin仪馆主任";
    searchInp.dispatchEvent(new Event("input", { bubbles: true }));
    await tick(90);
    check("R15 搜索文件名也能命中", allCards() === 1, String(allCards()));

    pickU.close();
    dmU.close();
  }

  /* ============ R16：封面（图片下载 / 视频只记链接 / 清除） ============ */
  {
    FAKE.samples = true;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "A/one.safetensors";
    T.META_CACHE.clear();
    T.Store.invalidate();

    // --- 图片封面：download:true，url 必须是原始 C 站 URL
    const dmC = new T.DetailModal("A/one.safetensors", () => {});
    dmC.open();
    await tick(160);
    const firstGal = dmC.body.querySelector(".cft-gal-item");
    check("R16 详情窗画廊出现", !!firstGal);
    // 新交互：点缩略图把该图切到主舞台 → 大图下侧「设为封面」按钮解锁
    const firstThumb = firstGal ? firstGal.querySelector(".cft-gallery-item") : null;
    if (firstThumb) { firstThumb.click(); await tick(60); }
    // 保险：万一还有残留的 Lightbox，先关掉避免遮挡后续命中测试
    // （v2.17 起点缩略图已经不会弹大图了，这里只是防止别的用例漏关）
    if (T.Lightbox) T.Lightbox.close();
    const covBtn = dmC.body.querySelector(".cft-detail-set-cover");
    check("R16 大图下侧有「设为封面」按钮", !!covBtn && /设为封面/.test(covBtn.textContent || ""));
    check("R16 点缩略图后「设为封面」按钮解锁", !!covBtn && covBtn.disabled === false, covBtn ? String(covBtn.disabled) : "无按钮");
    FAKE.coverCall = null;
    if (covBtn) { covBtn.click(); await tick(240); }
    check("R16 图片封面 POST /set_cover", !!FAKE.coverCall, JSON.stringify(FAKE.coverCall));
    check("R16 图片封面 type=image 且 download=true", !!FAKE.coverCall && FAKE.coverCall.type === "image" && FAKE.coverCall.download === true, JSON.stringify(FAKE.coverCall));
    check("R16 传的是原始 C 站 URL（不是 /cft_lora/image 代理）", !!FAKE.coverCall && /^https:\/\/image\.civitai\.com\//.test(FAKE.coverCall.url) && !String(FAKE.coverCall.url).includes("/cft_lora/"), String(FAKE.coverCall?.url));
    check("R16 封面状态提示为「自定义图片（已下载）」", (dmC.body.textContent || "").includes("封面：自定义图片（已下载）"), "");

    // --- 清除自定义封面
    const clearBtn = [...dmC.headerExtra.querySelectorAll("button")].find((b) => (b.textContent || "").includes("恢复原封面"));
    check("R16 设了封面后出现「恢复原封面」按钮", !!clearBtn);
    const beforeClear = (globalThis.__CFT_CALLS__ || []).length;
    if (clearBtn) { clearBtn.click(); await tick(120); }
    const askC = [...document.querySelectorAll(".cft-ask-modal")].pop();
    check("R16 清除封面先出自绘确认", !!askC);
    const okC = askC ? [...askC.querySelectorAll("button")].find((b) => b.textContent.includes("恢复原封面")) : null;
    check("R16 确认按钮文案为「恢复原封面」", !!okC);
    if (okC) { okC.click(); await tick(240); }
    const clearCall = (globalThis.__CFT_CALLS__ || []).slice(beforeClear).find((c) => c.url.endsWith("/cft_lora/clear_cover"));
    check("R16 发起 /clear_cover", !!clearCall);
    check("R16 清除后按钮消失", ![...dmC.headerExtra.querySelectorAll("button")].some((b) => (b.textContent || "").includes("恢复原封面")), "");
    dmC.close();
    document.querySelectorAll(".cft-ask-modal").forEach((el) => el.parentElement?.remove());

    // --- 视频封面：download:false，只记链接
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "Vid/onlyvideo.safetensors";
    T.Store.invalidate();
    const dmV = new T.DetailModal("Vid/onlyvideo.safetensors", () => {});
    dmV.open();
    await tick(180);
    check("R16 视频样本主舞台渲染成 <video>", !!dmV.body.querySelector("video.cft-detail-img"));
    const vGal = dmV.body.querySelector(".cft-gal-item-video");
    const vThumb = vGal ? vGal.querySelector(".cft-gallery-item") : null;
    if (vThumb) { vThumb.click(); await tick(60); }
    const vCovBtn = dmV.body.querySelector(".cft-detail-set-cover");
    check("R16 点视频缩略图后「设为封面」按钮解锁", !!vCovBtn && vCovBtn.disabled === false, vCovBtn ? String(vCovBtn.disabled) : "无按钮");
    check("R16 「设为封面」文案切到视频", !!vCovBtn && /视频/.test(vCovBtn.textContent || ""), vCovBtn ? vCovBtn.textContent : "");
    FAKE.coverCall = null;
    if (vCovBtn) { vCovBtn.click(); await tick(240); }
    check("R16 视频封面 type=video 且 download=false", !!FAKE.coverCall && FAKE.coverCall.type === "video" && FAKE.coverCall.download === false, JSON.stringify(FAKE.coverCall));
    check("R16 视频封面状态提示为「自定义视频（链接）」", (dmV.body.textContent || "").includes("封面：自定义视频（链接）"), "");
    dmV.close();

    // --- 列表卡片里的视频缩略图必须静音，否则 autoplay 起不来
    T.Store.invalidate();
    const nodeV = makeNode(131, []);
    const pickV = T.openPicker(nodeV, () => {});
    await tick(170);
    pickV.setView("grid");
    await tick(90);
    const vids = [...document.querySelectorAll(".cft-thumb-video")];
    check("R16 卡片渲染出视频缩略图", vids.length >= 1, vids.length ? vids.map((v) => v.tagName).join(",") : "0");
    // muted / defaultMuted 改成同步断言工厂产物：页面上那个 <video> 会因为
    // 「假 mp4 = SVG」解码失败被 guardVideo 异步换成占位图，抢时序会偶发红
    checkVideoThumbShape("R16 视频缩略图", { cover_type: "video", cover_url: "https://image.civitai.com/x/thumb.mp4" });
    check("R16 视频卡片带「▶ 视频」角标", !!document.querySelector(".cft-chip-video"), "");
    pickV.close();
  }

  /* ============ R17：同名 Lora 副本区分 ============ */
  {
    FAKE.samples = true;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const nodeDup = makeNode(141, []);
    const pickDup = T.openPicker(nodeDup, () => {});
    await tick(170);
    pickDup.setView("grid");
    await tick(90);

    const dupCards = [...pickDup.grid.querySelectorAll(".cft-card-wrap")]
      .filter((c) => ((c.querySelector(".cft-card-title") || {}).textContent || "") === "Bin Director");
    check("R17 找到两张同名副本卡片", dupCards.length === 2, String(dupCards.length));
    const chips = dupCards.map((c) => ((c.querySelector(".cft-chip-dup") || {}).textContent || ""));
    check("R17 两张卡片都带 .cft-chip-dup", chips.every((t) => t.includes("副本")), JSON.stringify(chips));
    check("R17 文案分别是「副本 1/2」「副本 2/2」", chips[0] === "副本 1/2" && chips[1] === "副本 2/2", JSON.stringify(chips));
    const subs = dupCards.map((c) => ((c.querySelector(".cft-card-sub") || {}).textContent || ""));
    check("R17 两张卡片各显示自己的文件名词干", subs.some((s) => s.includes("bin主任v2-step00009000")) && subs.some((s) => s.includes("bin仪馆主任 style")), JSON.stringify(subs));
    check("R17 两个词干互不相同", subs[0] !== subs[1], JSON.stringify(subs));
    check("R17 卡片 title 属性带完整文件名", dupCards.every((c) => {
      const t = c.querySelector(".cft-card-title");
      return !!t && (t.getAttribute("title") || "").includes("文件：");
    }), dupCards.map((c) => (c.querySelector(".cft-card-title") || {}).getAttribute?.("title") || "").join(" | "));
    check("R17 顶层容器带 cft-dup 类（可被测试与 CSS 命中）", dupCards.every((c) => c.classList.contains("cft-dup")), dupCards.map((c) => c.className).join(" | "));
    // 对照组：不重复的条目不得被误标
    const oneCard = [...pickDup.grid.querySelectorAll(".cft-card-wrap")]
      .find((c) => ((c.querySelector(".cft-card-title") || {}).textContent || "") === "One");
    check("R17 对照组：非重复条目不挂副本 chip", !!oneCard && !oneCard.querySelector(".cft-chip-dup"), "");
    pickDup.close();
  }

  /* ============ R18：版本号与新导出面 ============ */
  {
    check("R18 前端版本号 = 2.36", T.FRONTEND_VERSION === "2.36", T.FRONTEND_VERSION);
    check("R18 TrashModal 已导出", typeof T.TrashModal === "function");
    check("R18 openTrash 入口存在", typeof T.openTrash === "function");
    check("R18 askChoice / askConfirm / showInfoModal 已导出", typeof T.askChoice === "function" && typeof T.askConfirm === "function" && typeof T.showInfoModal === "function");
    check("R18 dupKeyOf / buildDupIndex / coverMedia / makeThumb 已导出", typeof T.dupKeyOf === "function" && typeof T.buildDupIndex === "function" && typeof T.coverMedia === "function" && typeof T.makeThumb === "function");
    check("R18 applyUserMetaToCache 已导出", typeof T.applyUserMetaToCache === "function");
    for (const fn of ["userMeta", "setUserMeta", "userTags", "setCover", "clearCover"]) {
      check(`R18 Store.${fn} 存在`, typeof T.Store[fn] === "function");
    }
    // dupKeyOf / coverMedia 的语义
    check("R18 dupKeyOf 优先按 model/version 分组",
      T.dupKeyOf({ model_id: 1, version_id: 2, display_name: "x" }) === "mv:1/2",
      T.dupKeyOf({ model_id: 1, version_id: 2, display_name: "x" }));
    check("R18 dupKeyOf 无 C 站信息时回退 display_name",
      T.dupKeyOf({ display_name: "Hello" }) === "n:hello",
      T.dupKeyOf({ display_name: "Hello" }));
    check("R18 dupKeyOf 全空返回 null", T.dupKeyOf({}) === null && T.dupKeyOf(null) === null, "");
    check("R18 buildDupIndex 只留重复组", (() => {
      const idx = T.buildDupIndex([{ model_id: 1, version_id: 1 }, { model_id: 1, version_id: 1 }, { display_name: "solo" }]);
      return idx.size === 1 && idx.get("mv:1/1").length === 2;
    })(), "");
    check("R18 coverMedia：视频封面走 /image 代理",
      T.coverMedia({ cover_type: "video", cover_url: "https://x/v.mp4" }).kind === "video"
      && T.coverMedia({ cover_type: "video", cover_url: "https://x/v.mp4" }).src.includes("/cft_lora/image?url="),
      T.coverMedia({ cover_type: "video", cover_url: "https://x/v.mp4" }).src);
    check("R18 coverMedia：无预览图 + C 站首图是视频 → 也判为视频",
      T.coverMedia({ preview: "", remote_images: [{ url: "https://x/v.mp4", type: "video" }] }).kind === "video");
    check("R18 coverMedia：有本地预览图 → 图片", T.coverMedia({ preview: "a.png", remote_images: [] }).kind === "image");
  }

  /* ============ R20：v2.19 全自动保存（标签 / 说明 / 关窗兜底，无「保存」按钮） ============ */
  {
    FAKE.samples = true;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "A/one.safetensors";
    T.META_CACHE.clear();
    T.Store.invalidate();
    (globalThis.__CFT_CALLS__ || []).length = 0;

    const dmS = new T.DetailModal("A/one.safetensors", () => {});
    dmS.open();
    await tick(170);
    const secS = dmS.body.querySelector(".cft-user-section");
    check("R20 详情窗有「我的标签 / 说明」一节", !!secS);
    check("R20 有「＋ 添加」按钮", !!(secS && secS.querySelector(".cft-user-add")));
    check("R20 已撤掉「保存」按钮（全自动保存，画蛇添足的手动步骤不再需要）",
      !!(secS && !secS.querySelector(".cft-user-save")), "");

    const umPosts = () => (globalThis.__CFT_CALLS__ || [])
      .filter((c) => c.url.endsWith("/cft_lora/user_meta") && c.method === "POST");

    // 核心场景：往输入框敲字但**不回车**，直接点到别处（失焦）→ 自动落盘
    const inpS = secS.querySelector(".cft-input");
    inpS.value = "未回车标签";
    inpS.dispatchEvent(new Event("blur"));
    await tick(220);

    const lastPost = umPosts().pop();
    check("R20 输入框失焦把未回车的文本自动提交进了 tags",
      !!lastPost && (lastPost.body.tags || []).includes("未回车标签"),
      JSON.stringify(lastPost && lastPost.body));
    check("R20 自动保存后输入框被清空（内容没丢、已入库）", inpS.value === "", JSON.stringify(inpS.value));
    check("R20 自动保存后详情窗标签区立即出现该 chip",
      [...secS.querySelectorAll(".cft-user-taglist .cft-tag-user")].some((x) => (x.textContent || "").includes("未回车标签")),
      [...secS.querySelectorAll(".cft-user-taglist .cft-tag-user")].map((x) => x.textContent).join("|"));
    const cached = T.META_CACHE.get("A/one.safetensors");
    check("R20 自动保存后 META_CACHE.user_tags 已更新（标签能显示在 lora 信息上）",
      !!cached && (cached.user_tags || []).includes("未回车标签"),
      JSON.stringify(cached && cached.user_tags));
    const statusS = secS.querySelector(".cft-user-status");
    check("R20 静默保存有可见反馈（状态字变「已保存 ✓」）",
      !!statusS && (statusS.textContent || "").includes("已保存"), statusS ? statusS.textContent : "(无状态字)");

    // 「＋ 添加」等价于回车
    inpS.value = "按钮加的标签";
    secS.querySelector(".cft-user-add").click();
    await tick(220);
    const lastPost2 = umPosts().pop();
    check("R20 「＋ 添加」把输入框内容加进 tags",
      !!lastPost2 && (lastPost2.body.tags || []).includes("按钮加的标签"),
      JSON.stringify(lastPost2 && lastPost2.body));

    // v2.20：清空拆成两份 —— 「清空标签」只动标签，「清空说明」只动说明
    const taS = secS.querySelector(".cft-textarea");
    taS.value = "保留的说明";
    taS.dispatchEvent(new Event("blur"));
    await tick(220);

    inpS.value = "待清空";
    const clearTagsBtnS = secS.querySelector(".cft-user-clear-tags");
    check("R20 有独立的「清空标签」按钮", !!clearTagsBtnS);
    if (clearTagsBtnS) {
      clearTagsBtnS.click();
      await tick(140);
      const askS = [...document.querySelectorAll(".cft-ask-modal")].pop();
      const okS = askS ? [...askS.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空标签") : null;
      check("R20 清空标签先出自绘确认", !!askS);
      if (okS) { okS.click(); await tick(240); }
      check("R20 清空标签后输入框内容也被清掉", inpS.value === "", JSON.stringify(inpS.value));
      check("R20 清空标签后标签区为空",
        !secS.querySelector(".cft-user-taglist .cft-tag-user"), "");
      check("R20 清空标签不影响说明", taS.value === "保留的说明", JSON.stringify(taS.value));
      const clearTagPost = umPosts().pop();
      check("R20 清空标签只提交空 tags，说明原样保留",
        !!clearTagPost && Array.isArray(clearTagPost.body.tags) && clearTagPost.body.tags.length === 0
          && clearTagPost.body.note === "保留的说明",
        JSON.stringify(clearTagPost && clearTagPost.body));
      document.querySelectorAll(".cft-ask-modal").forEach((el) => el.parentElement?.remove());
    }

    // 「清空说明」：只清说明，标签留着
    inpS.value = "留着标签";
    secS.querySelector(".cft-user-add").click();
    await tick(240);
    const clearNoteBtnS = secS.querySelector(".cft-user-clear-note");
    check("R20 有独立的「清空说明」按钮", !!clearNoteBtnS);
    if (clearNoteBtnS) {
      clearNoteBtnS.click();
      await tick(140);
      const askN = [...document.querySelectorAll(".cft-ask-modal")].pop();
      const okN = askN ? [...askN.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空说明") : null;
      if (okN) { okN.click(); await tick(240); }
      check("R20 清空说明后 textarea 为空", taS.value === "", JSON.stringify(taS.value));
      check("R20 清空说明不影响标签",
        [...secS.querySelectorAll(".cft-user-taglist .cft-tag-user")].some((x) => (x.textContent || "").includes("留着标签")),
        [...secS.querySelectorAll(".cft-user-taglist .cft-tag-user")].map((x) => x.textContent).join("|"));
      const clearNotePost = umPosts().pop();
      check("R20 清空说明只提交空 note，标签原样保留",
        !!clearNotePost && clearNotePost.body.note === "" && (clearNotePost.body.tags || []).includes("留着标签"),
        JSON.stringify(clearNotePost && clearNotePost.body));
      document.querySelectorAll(".cft-ask-modal").forEach((el) => el.parentElement?.remove());
    }

    // 说明：打字停手 700ms 自动保存（不用失焦、更不用点保存）
    taS.value = "自动保存的说明";
    taS.dispatchEvent(new Event("input"));
    await tick(950);
    const notePost = umPosts().pop();
    check("R20 说明输入停手后自动保存（无需失焦 / 点保存）",
      !!notePost && notePost.body.note === "自动保存的说明", JSON.stringify(notePost && notePost.body));

    // 卡片上要能看到自定义标签（用户原话「没有显示在 lora 信息上」）
    T.META_CACHE.clear();
    T.Store.invalidate();
    FAKE.user = { tags: ["卡片可见"], note: "", cover: null };
    const nodeS = makeNode(154, []);
    const pickS = T.openPicker(nodeS, () => {});
    await tick(170);
    pickS.setView("grid");
    await tick(90);
    const cardOne = [...pickS.grid.querySelectorAll(".cft-card-wrap")]
      .find((c) => ((c.querySelector(".cft-card-title") || {}).textContent || "") === "One");
    check("R20 保存过的标签显示在卡片标签区",
      !!cardOne && [...cardOne.querySelectorAll(".cft-card-tags .cft-tag-user")].some((x) => (x.textContent || "").includes("卡片可见")),
      cardOne ? [...cardOne.querySelectorAll(".cft-card-tags .cft-tag")].map((x) => x.textContent).join("|") : "(无卡片)");
    pickS.close();

    // 关窗兜底：刚打的说明还没到 700ms 防抖点就关窗 → flush 必须把它存掉
    taS.value = "关窗前最后一笔";
    taS.dispatchEvent(new Event("input"));
    await tick(80); // 远小于防抖 700ms
    dmS.close();
    await tick(400);
    const closePost = umPosts().pop();
    check("R20 关窗兜底把还没落盘的说明存掉（元素移除不触发 blur 也不丢）",
      !!closePost && closePost.body.note === "关窗前最后一笔",
      JSON.stringify(closePost && closePost.body));
  }

  /* ============ R39：v2.19 收藏按钮移到 lora 名称下面一行 ============ */
  {
    FAKE.samples = false;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null, favorite: false };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const dmP = new T.DetailModal("A/one.safetensors", () => {});
    dmP.open();
    await tick(220);

    const subrow = dmP.body.querySelector(".cft-detail-subrow");
    check("R39 lora 名称下方有独立子行（路径 + 收藏）", !!subrow, "");
    check("R39 该行仍显示 lora 路径",
      !!subrow && (subrow.textContent || "").includes("A/one.safetensors"), subrow ? subrow.textContent : "null");
    const favP = subrow ? subrow.querySelector(".cft-fav-btn") : null;
    check("R39 收藏按钮就挂在名称下一行", !!favP, "");
    check("R39 收藏按钮不再出现在「我的标签 / 说明」标题行",
      !dmP.body.querySelector(".cft-user-section .cft-section-title .cft-fav-btn"), "");
    if (favP) {
      favP.click();
      await tick(240);
      const favP2 = dmP.body.querySelector(".cft-detail-subrow .cft-fav-btn");
      check("R39 点收藏仍能生效（文案变「★ 已收藏」）",
        !!favP2 && (favP2.textContent || "").includes("已收藏") && favP2.dataset.fav === "1",
        favP2 ? `${favP2.textContent}|data-fav=${favP2.dataset.fav}` : "null");
      const favCall = (globalThis.__CFT_CALLS__ || [])
        .filter((c) => c.url.endsWith("/cft_lora/user_meta") && c.method === "POST").pop();
      check("R39 收藏仍走部分更新（body 只有 favorite 一位）",
        !!favCall && favCall.body.favorite === true && favCall.body.tags === undefined,
        JSON.stringify(favCall ? favCall.body : null));
    }
    dmP.close();
    await tick(80);
  }

  /* ============ R21：预览图 URL 带版本号，换封面立刻生效（报障 2） ============ */
  {
    const u1 = T.previewUrl({ lora: "X", preview: "X.preview.png", preview_mtime: 123 });
    const u2 = T.previewUrl({ lora: "X", preview: "X.preview.png" });
    check("R21 有 mtime 时 URL 带 &v=123", u1.includes("&v=123"), u1);
    check("R21 无 mtime 时也带 &v=0（换 URL 才能穿透已缓存的老图）", u2.includes("&v=0"), u2);
    check("R21 两个不同 mtime 生成不同 URL",
      u1 !== T.previewUrl({ lora: "X", preview: "X.preview.png", preview_mtime: 124 }), "");

    FAKE.samples = false;
    FAKE.extra = false;
    FAKE.previewMtime = 111;
    T.META_CACHE.clear();
    T.Store.invalidate();
    const nodePm = makeNode(151, []);
    const pickPm = T.openPicker(nodePm, () => {});
    await tick(170);
    pickPm.setView("grid");
    await tick(90);
    const findOne = () => [...pickPm.grid.querySelectorAll(".cft-card-wrap")]
      .find((c) => ((c.querySelector(".cft-card-title") || {}).textContent || "") === "One");
    const img0 = findOne() && findOne().querySelector(".cft-card-img");
    const srcBefore = img0 && img0.getAttribute("src");
    check("R21 卡片缩略图 URL 带 &v=（不是裸 ?name=）", !!srcBefore && srcBefore.includes("&v="), String(srcBefore));

    FAKE.previewMtime = 222;
    T.META_CACHE.clear();
    T.Store.invalidate();
    pickPm.data = await T.Store.list(true);
    pickPm.renderGrid();
    await tick(80);
    const srcAfter = (findOne() && findOne().querySelector(".cft-card-img")?.getAttribute("src")) || "";
    check("R21 改 preview_mtime 后缩略图 src 变化（换封面不再吃缓存）",
      !!srcBefore && srcAfter !== srcBefore, `${srcBefore} -> ${srcAfter}`);
    check("R21 新 URL 带 &v=222", srcAfter.includes("&v=222"), srcAfter);
    pickPm.close();
    await tick(40);
  }

  /* ============ R22：视频静音自动播放 + 失败可见反馈（报障 3） ============ */
  {
    FAKE.samples = true;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "Vid/onlyvideo.safetensors";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const dmVid = new T.DetailModal("Vid/onlyvideo.safetensors", () => {});
    dmVid.open();
    await tick(220);
    const stageVid = dmVid.body.querySelector("video.cft-detail-img");
    check("R22 详情主舞台是 <video>", !!stageVid);
    check("R22 主舞台 muted === true", !!stageVid && stageVid.muted === true, stageVid ? String(stageVid.muted) : "none");
    check("R22 主舞台 defaultMuted === true", !!stageVid && stageVid.defaultMuted === true, stageVid ? String(stageVid.defaultMuted) : "none");
    check("R22 主舞台有 controls", !!stageVid && stageVid.hasAttribute("controls"));
    check("R22 主舞台 preload=metadata", !!stageVid && stageVid.getAttribute("preload") === "metadata");
    check("R22 主舞台 src 走 /cft_lora/image 代理且无 crossorigin",
      !!stageVid && String(stageVid.getAttribute("src")).startsWith("/cft_lora/image?url=") && !stageVid.hasAttribute("crossorigin"),
      stageVid ? String(stageVid.getAttribute("src")) : "(无)");
    if (stageVid) stageVid.dispatchEvent(new Event("error"));
    await tick(60);
    // 只认主舞台容器里的兜底块（画廊里其它视频也可能自然失败，不能算数）
    const stageHostV = dmVid.body.querySelector(".cft-detail-stage");
    const errBlock = stageHostV ? stageHostV.querySelector(".cft-media-error") : null;
    check("R22 主舞台 error 后出现 .cft-media-error（不留黑框）", !!errBlock, stageHostV ? stageHostV.textContent.slice(0, 60) : "(无舞台)");
    check("R22 失败提示文案可执行", !!errBlock && (errBlock.textContent || "").includes("视频加载失败"), errBlock ? errBlock.textContent : "");
    check("R22 主舞台失败后视频被隐藏（不留黑框本体）", !!stageVid && stageVid.style.display === "none", stageVid ? stageVid.style.display : "none");
    dmVid.close();
    await tick(60);

    // 缩略图：静音自动播放、无 controls；error 后退化成占位图
    T.META_CACHE.clear();
    T.Store.invalidate();
    const nodeVid = makeNode(152, []);
    const pickVid = T.openPicker(nodeVid, () => {});
    await tick(180);
    pickVid.setView("grid");
    await tick(100);
    const thumbVid = pickVid.grid.querySelector(".cft-thumb-video");
    check("R22 缩略图带 cft-thumb-video 标识", !!thumbVid, thumbVid ? thumbVid.tagName : "null");
    // 属性走同步断言（原因见 checkVideoThumbShape 注释）；下面单独验 error 退化路径
    checkVideoThumbShape("R22 缩略图", { cover_type: "video", cover_url: "https://image.civitai.com/x/vid-thumb.mp4" });
    if (thumbVid) {
      const cardV = thumbVid.closest(".cft-card-wrap");
      thumbVid.dispatchEvent(new Event("error"));
      await tick(60);
      const ph = cardV && cardV.querySelector('img[src^="data:image/svg+xml"]');
      check("R22 缩略图 error 后退化成占位图（不再整排黑框）", !!ph);
      check("R22 缩略图 error 后不再是 <video>", !(cardV && cardV.querySelector("video.cft-thumb-video")));
    }
    pickVid.close();
    await tick(40);
  }

  /* ============ R23：标签下拉 = 我的标签 ∪ C 站标签（报障 4） ============ */
  {
    FAKE.samples = true;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "";   // 关键：不覆盖样本里硬编码的 user_tags
    T.META_CACHE.clear();
    T.Store.invalidate();
    const nodeT = makeNode(153, []);
    const pickT = T.openPicker(nodeT, () => {});
    await tick(180);
    const sel = pickT.tagSelect;
    check("R23 标签下拉存在", !!sel);
    const groups = [...sel.querySelectorAll("optgroup")].map((g) => g.label);
    check("R23 有「我的标签」分组", groups.includes("我的标签"), groups.join("|"));
    check("R23 有「C 站标签」分组", groups.includes("C 站标签"), groups.join("|"));

    const optOf = (v) => [...sel.options].find((o) => o.value === v);
    const groupOf = (v) => {
      const o = optOf(v);
      return o && o.parentElement && o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : "";
    };
    check("R23 C 站标签 style 进了「C 站标签」组",
      !!optOf("style") && groupOf("style") === "C 站标签", groupOf("style"));
    check("R23 同名标签「风格」优先归入「我的标签」组（user_tags 与 tags 都命中）",
      !!optOf("风格") && groupOf("风格") === "我的标签", groupOf("风格"));
    check("R23 合并后的「风格」计数取并集 = 2",
      !!optOf("风格") && /\(2\)/.test(optOf("风格").textContent || ""), optOf("风格") ? optOf("风格").textContent : "(无)");
    const head = sel.options[0];
    const kindCount = new Set([...sel.options].map((o) => o.value).filter(Boolean)).size;
    check("R23 顶部保留「全部标签 (N)」且 N = 去重后的标签种类数",
      head && head.value === "" && (head.textContent || "").includes(`全部标签 (${kindCount})`),
      `${head && head.textContent} vs ${kindCount}`);

    const cardCount = () => pickT.grid.querySelectorAll(".cft-card-wrap").length;
    const pick = async (v) => {
      sel.value = v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(100);
    };
    await pick("style");
    check("R23 按 C 站标签 style 筛选 → 命中 1 条", cardCount() === 1, String(cardCount()));
    await pick("风格");
    check("R23 按合并标签「风格」筛选 → user_tags / tags 任一命中，共 2 条", cardCount() === 2, String(cardCount()));
    await pick("");
    check("R23 清空筛选后卡片恢复", cardCount() > 2, String(cardCount()));
    pickT.close();
    await tick(40);
  }

  /* ============ R24：自定义标签混排进标签行、换色、去掉独立徽标（报障 5） ============ */
  {
    FAKE.samples = true;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();
    const nodeM = makeNode(155, []);
    const pickM = T.openPicker(nodeM, () => {});
    await tick(180);
    pickM.setView("grid");
    await tick(90);
    const cardM = [...pickM.grid.querySelectorAll(".cft-card-wrap")]
      .find((c) => ((c.querySelector(".cft-card-title") || {}).textContent || "") === "My Tagged");
    check("R24 找到自定义标签样本卡片", !!cardM);
    const tagsBox = cardM && cardM.querySelector(".cft-card-tags");
    check("R24 卡片有 .cft-card-tags 容器", !!tagsBox);
    const chips = tagsBox ? [...tagsBox.children] : [];
    const userN = chips.filter((c) => c.classList.contains("cft-tag-user")).length;
    const civN = chips.filter((c) => c.classList.contains("cft-tag") && !c.classList.contains("cft-tag-user") && !c.classList.contains("cft-tag-word")).length;
    check("R24 自定义标签与 C 站标签在**同一个** .cft-card-tags 容器里", userN >= 1 && civN >= 1, `user=${userN} civ=${civN}`);
    check("R24 自定义标签排在 C 站标签前面", chips.length > 0 && chips[0].classList.contains("cft-tag-user"), chips.map((c) => c.className).join(" | "));
    // v2.18：上限从 2 放宽到 5 —— 样本的 3 个自定义标签应全部显示、不折叠
    const moreChipM = tagsBox ? tagsBox.querySelector(".cft-tag-more") : null;
    check("R24 卡片自定义标签最多 5 个（样本 3 个全显、不折叠）", userN === 3 && !moreChipM, `user=${userN} more=${moreChipM ? moreChipM.textContent : "无"}`);
    check("R24 卡片每行最多 3 个 C 站标签", civN === 3, String(civN));
    const anyCustomBadge = [...pickM.grid.querySelectorAll(".cft-chip")].some((c) => (c.textContent || "").includes("自定义"));
    check("R24 不再出现独立的「✦ 自定义」徽标", !anyCustomBadge);
    pickM.close();
    await tick(40);

    // 详情窗的只读「标签」一节也要混排（自定义在前 + C 站标签），不与编辑区割裂
    FAKE.userName = "Mine/mytagged.safetensors";
    FAKE.user = { tags: ["风格X"], note: "", cover: null };
    T.META_CACHE.clear();
    T.Store.invalidate();
    const dmM = new T.DetailModal("Mine/mytagged.safetensors", () => {});
    dmM.open();
    await tick(190);
    const tagSec = [...dmM.body.querySelectorAll(".cft-section")]
      .find((s) => ((s.querySelector(".cft-section-title") || {}).textContent || "").trim() === "标签");
    check("R24 详情窗有只读「标签」一节", !!tagSec);
    const wordList = tagSec && tagSec.querySelector(".cft-word-list");
    const userInList = wordList ? wordList.querySelectorAll(".cft-tag-user").length : 0;
    const civInList = wordList ? [...wordList.children].filter((c) => c.classList.contains("cft-tag") && !c.classList.contains("cft-tag-user")).length : 0;
    check("R24 详情窗标签一节里自定义标签与 C 站标签混排", userInList >= 1 && civInList >= 1, `user=${userInList} civ=${civInList}`);
    check("R24 详情窗自定义标签排在 C 站标签前", !!wordList && wordList.children.length > 0 && wordList.children[0].classList.contains("cft-tag-user"));
    check("R24 详情窗仍保留可编辑的「我的标签 / 说明」一节", !!dmM.body.querySelector(".cft-user-section"));
    dmM.close();
    await tick(40);
  }

  /* ============ R27：标签计数/筛选必须含堆内 lora（报障 8） ============
     用户场景：从堆窗口给已在堆里的 lora 加自定义标签 → 标签出现在
     picker 下拉里但计数 (0)、按它筛选「没有匹配的 Lora」。
     根因：_fillTags()/filtered() 用 _filterBase()，其中「排除已在堆里的 lora」
     把标签主人整个滤掉了 —— 标签打在整个库上，不该受「是否在堆里」影响。 */
  {
    FAKE.samples = true;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "";   // 用 sampleItems() 里 mytagged 硬编码的 user_tags
    T.META_CACHE.clear();
    T.Store.invalidate();

    // 关键差异（对比 R23）：把 mytagged **放进堆里** —— 它带着「我的收藏/风格/夜景」
    const nodeR27 = makeNode(270, [{ lora: "Mine/mytagged.safetensors", weight: 1 }]);
    const pickR = T.openPicker(nodeR27, () => {});
    await tick(180);
    const selR = pickR.tagSelect;
    check("R27 标签下拉存在", !!selR);
    check("R27 拆分出 _tagBase()/_matchBase()/_stackSet()",
      typeof pickR._tagBase === "function" && typeof pickR._matchBase === "function" && typeof pickR._stackSet === "function");

    const optOfR = (v) => [...(selR ? selR.options : [])].find((o) => o.value === v);
    check("R27 堆内 lora 的自定义标签「我的收藏」计数 = 1（修复前 0）",
      !!optOfR("我的收藏") && /\(1\)/.test(optOfR("我的收藏").textContent || ""),
      optOfR("我的收藏") ? optOfR("我的收藏").textContent : "(无此选项)");
    check("R27 「夜景」计数 = 1（修复前 0）",
      !!optOfR("夜景") && /\(1\)/.test(optOfR("夜景").textContent || ""),
      optOfR("夜景") ? optOfR("夜景").textContent : "(无此选项)");
    check("R27 合并标签「风格」计数 = 2（堆内 user_tags + 堆外 onlyvideo 的 C 站标签）",
      !!optOfR("风格") && /\(2\)/.test(optOfR("风格").textContent || ""),
      optOfR("风格") ? optOfR("风格").textContent : "(无此选项)");

    const cardCountR = () => pickR.grid.querySelectorAll(".cft-card-wrap").length;
    const pickR27 = async (v) => {
      selR.value = v;
      selR.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(100);
    };

    // 按「我的收藏」筛选 → 命中的正是堆内那条：必须**出得来**且标「已在堆中」
    await pickR27("我的收藏");
    check("R27 按堆内标签筛选后网格非空（修复前「没有匹配的 Lora」）", cardCountR() >= 1, String(cardCountR()));
    const instackChip = pickR.grid.querySelector(".cft-chip-instack");
    check("R27 堆内命中卡片带「已在堆中」徽标", !!instackChip && (instackChip.textContent || "").includes("已在堆中"),
      instackChip ? instackChip.textContent : "(无徽标)");
    check("R27 堆内命中卡片有 cft-instack 降透明样式", !!pickR.grid.querySelector(".cft-card.cft-instack"));

    // 堆内条目不可再选（点卡片 body）
    const instackBody = pickR.grid.querySelector(".cft-card.cft-instack ~ .cft-card-body") || pickR.grid.querySelector(".cft-card-body");
    if (instackBody) instackBody.click();
    await tick(60);
    check("R27 点堆内条目不加入已选", pickR.selected.size === 0, String(pickR.selected.size));
    check("R27 点堆内条目弹「已在堆里」提示",
      !!pickR.root.querySelector(".cft-toast") && (pickR.root.querySelector(".cft-toast").textContent || "").includes("已在堆里"));

    // 堆外条目不受影响：清标签后只有堆外条目，可选
    await pickR27("");
    check("R27 清空标签后默认列表仍排除堆内（行为不变）",
      !pickR._filterBase().some((it) => it.lora === "Mine/mytagged.safetensors"));
    const otherCard = [...pickR.grid.querySelectorAll(".cft-card-body")].find((b) => !b.closest(".cft-card")?.classList.contains("cft-instack"));
    if (otherCard) otherCard.click();
    await tick(60);
    check("R27 堆外条目仍可正常选中", pickR.selected.size === 1, String(pickR.selected.size));

    pickR.close();
    await tick(40);
  }

  /* ============ R25：隔离区「彻底删除」/「清空隔离区」（报障 7） ============ */
  {
    check("R25 Store.trashDelete 已导出", typeof T.Store.trashDelete === "function");
    FAKE.trash.length = 0;
    FAKE.trash.push({
      stamp: "20261017-101010-dead", root: "/models/loras", path: "/models/loras/.cft_trash/20261017-101010-dead",
      count: 4, size: 40 * 1024 * 1024, size_mb: 40, original_root: "/models/loras", byCat: [],
    });
    FAKE.trashDeleteCalls.length = 0;

    const tm = T.openTrash(null);
    await tick(200);
    const delBtn = tm.body.querySelector(".cft-trash-del");
    check("R25 每个批次行有「🗑 彻底删除」按钮", !!delBtn && (delBtn.textContent || "").includes("彻底删除"));
    check("R25 彻底删除按钮用 danger 样式", !!delBtn && delBtn.classList.contains("cft-btn-danger"));
    const purgeBtn = tm.footer.querySelector(".cft-trash-purge");
    check("R25 页脚有「🗑 清空隔离区」按钮", !!purgeBtn);
    check("R25 有批次时「清空隔离区」可用", !!purgeBtn && purgeBtn.disabled === false);

    if (delBtn) {
      delBtn.click();
      await tick(140);
      const askD = [...document.querySelectorAll(".cft-ask-modal")].pop();
      check("R25 彻底删除先出自绘确认对话框", !!askD);
      check("R25 确认文案提示「无法还原」", !!(askD && (askD.textContent || "").includes("无法还原")));
      const okD = askD ? [...askD.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "彻底删除") : null;
      check("R25 确认按钮文案为「彻底删除」", !!okD);
      if (okD) { okD.click(); await tick(260); }
    }
    check("R25 确认后调用 /trash_delete 且带上批次号",
      FAKE.trashDeleteCalls.some((c) => c.stamp === "20261017-101010-dead" && c.all === false),
      JSON.stringify(FAKE.trashDeleteCalls));
    check("R25 删除后列表重载、该批次消失", (tm.batches || []).length === 0, String((tm.batches || []).length));
    check("R25 空态时「清空隔离区」按钮 disabled",
      !!tm.footer.querySelector(".cft-trash-purge") && tm.footer.querySelector(".cft-trash-purge").disabled === true);

    // 清空隔离区：all:true
    FAKE.trash.push(
      { stamp: "20261017-202020-aaaa", root: "/models/loras", path: "x", count: 3, size: 3 * 1024 * 1024, size_mb: 3, original_root: "/models/loras", byCat: [] },
      { stamp: "20261017-303030-bbbb", root: "/models/loras", path: "y", count: 2, size: 2 * 1024 * 1024, size_mb: 2, original_root: "/models/loras", byCat: [] },
    );
    await tm.load();
    await tick(80);
    const purgeBtn2 = tm.footer.querySelector(".cft-trash-purge");
    check("R25 重新载入后有 2 个批次", (tm.batches || []).length === 2, String((tm.batches || []).length));
    if (purgeBtn2) {
      purgeBtn2.click();
      await tick(140);
      const askA = [...document.querySelectorAll(".cft-ask-modal")].pop();
      const okA = askA ? [...askA.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "清空隔离区") : null;
      check("R25 清空先出自绘确认", !!askA);
      if (okA) { okA.click(); await tick(260); }
    }
    check("R25 清空调用 /trash_delete 且 all === true",
      FAKE.trashDeleteCalls.some((c) => c.all === true), JSON.stringify(FAKE.trashDeleteCalls));
    check("R25 清空后隔离区为空", (tm.batches || []).length === 0, String((tm.batches || []).length));
    tm.close();
    await tick(60);
    document.querySelectorAll(".cft-ask-modal").forEach((el) => el.parentElement?.remove());
  }

  /* ============ R26：确认对话框必须真居中、真可点（报障 6 回归护栏） ============
     机制：`.cft-modal` 是 position:relative，父级 `.cft-mask` 用
     `display:flex; justify-content:center` 做居中。旧代码把 _defaultGeom() 算出的
     「右上角绝对坐标」无条件写进 style.left —— 在 position:relative 下就变成
     「相对偏移」叠加在居中位置之上，视口越宽推得越远（1920 宽时 rect.x≈1989，
     整块跑到屏幕外），用户只看到变模糊的遮罩、点什么都没反应。

     为什么这一组必须用 elementFromPoint：element.click() 对「元素存在但看不见/
     点不到」完全不敏感 —— 这正是沙盒 344 项全绿却漏掉这个 bug 的原因。 */
  {
    check("R26 沙盒视口够宽（旧 bug 触发条件：≥844px）", innerWidth >= 844, `innerWidth=${innerWidth}`);

    // 命中测试前把沙盒自己的报告面板藏起来：它盖在页面最上层，
    // 会让 elementFromPoint 永远返回 <pre>，把「产品 bug」和「夹具遮挡」混为一谈。
    const repEl = document.getElementById("report");
    const repPrevDisplay = repEl ? repEl.style.display : null;
    if (repEl) repEl.style.display = "none";

    let resolved = null;
    const p = T.askChoice({
      title: "R26 几何自检",
      message: "确认对话框必须居中且可点",
      width: 560,
      buttons: [{ label: "关闭", value: "close", kind: "primary" }],
    }).then((v) => { resolved = v; return v; });
    await tick(220);

    const aRoot = document.querySelector(".cft-ask-modal");
    check("R26 确认对话框已挂到文档", !!aRoot);
    if (aRoot) {
      const aRect = aRoot.getBoundingClientRect();
      const aMask = aRoot.closest(".cft-mask");
      const mRect = aMask.getBoundingClientRect();
      check("R26 非浮动对话框不写 inline left/top",
        !aRoot.style.left && !aRoot.style.top,
        `left="${aRoot.style.left}" top="${aRoot.style.top}"`);
      check("R26 computed position 仍是 relative（没被改成 fixed）",
        getComputedStyle(aRoot).position === "relative", getComputedStyle(aRoot).position);
      const wantLeft = mRect.left + (mRect.width - aRect.width) / 2;
      check("R26 对话框水平居中（±1px）",
        Math.abs(aRect.left - wantLeft) <= 1,
        `rect.left=${aRect.left.toFixed(1)} 期望≈${wantLeft.toFixed(1)}`);
      check("R26 对话框完整落在视口内",
        aRect.left >= 0 && aRect.top >= 0 &&
        aRect.right <= innerWidth + 1 && aRect.bottom <= innerHeight + 1,
        JSON.stringify({ l: +aRect.left.toFixed(1), t: +aRect.top.toFixed(1), r: +aRect.right.toFixed(1), b: +aRect.bottom.toFixed(1), vw: innerWidth, vh: innerHeight }));

      const dTop = document.elementFromPoint(aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      check("R26 对话框中心 elementFromPoint 命中自身（看得见点得到）",
        !!dTop && (dTop === aRoot || aRoot.contains(dTop)),
        dTop ? `${dTop.tagName}.${dTop.className}` : "null");

      const aBtn = [...aRoot.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭");
      check("R26 对话框按钮存在", !!aBtn);
      if (aBtn) {
        const bRect = aBtn.getBoundingClientRect();
        const bTop = document.elementFromPoint(bRect.left + bRect.width / 2, bRect.top + bRect.height / 2);
        check("R26 按钮中心 elementFromPoint 命中按钮（能点下去）",
          !!bTop && (bTop === aBtn || aBtn.contains(bTop)),
          bTop ? `${bTop.tagName}.${bTop.className}` : "null");
      }
    }

    // 反向护栏：浮动窗口必须仍走绝对定位，别把这次的修复过度外溢
    const smGuard = new T.StackManagerModal(nodeA);
    smGuard.open();
    await tick(180);
    check("R26 浮动窗口仍写 inline left/top（修复未过度外溢）",
      !!smGuard.root.style.left && !!smGuard.root.style.top,
      `left="${smGuard.root.style.left}" top="${smGuard.root.style.top}"`);
    check("R26 浮动窗口 computed position 是 fixed",
      getComputedStyle(smGuard.root).position === "fixed", getComputedStyle(smGuard.root).position);
    smGuard.close();
    await tick(40);

    // 收尾：走真实关闭路径，确认 Promise 一定 resolve（不挂住 await）
    const closeA = aRoot && [...aRoot.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "关闭");
    if (closeA) closeA.click();
    await tick(140);
    await Promise.race([p, tick(800)]);
    check("R26 关闭后对话框移除", !document.querySelector(".cft-ask-modal"));
    check("R26 askChoice 的 Promise 已 resolve", resolved === "close", String(resolved));

    if (repEl) repEl.style.display = repPrevDisplay ?? "";
  }

  /* ============ R28：第三轮 —— 全部停用 / 收藏（右键+详情+分类+徽标）/ 文件名搜索 ============
     用户场景：
     ① 想把整堆临时关掉出图对比，以前只能逐条点「启用」开关；
     ② Lora 越攒越多，想把自己常用的几个收成一类一键筛出来；
     ③ 记不得英文名，只记得文件名里的一段（如 "senie"）也要能搜到。 */
  {
    /* ---- 28a：堆窗口「全部停用」 ---- */
    const nodeR28 = makeNode(281, [
      { lora: "A/one.safetensors", name: "one", display_name: "One", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
      { lora: "B/two.safetensors", name: "two", display_name: "Two", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
      { lora: "C/three.safetensors", name: "three", display_name: "Three", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
    ]);
    const smR28 = T.openStackManager(nodeR28);
    await tick(140);
    const btns28 = [...smR28.footer.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    const iOn28 = btns28.indexOf("全部启用");
    const iOff28 = btns28.indexOf("全部停用");
    check("R28 页脚有「全部停用」按钮", iOff28 >= 0, btns28.join("|"));
    check("R28 「全部停用」紧挨「全部启用」右侧", iOn28 >= 0 && iOff28 === iOn28 + 1, `启用@${iOn28} 停用@${iOff28}`);
    const offBtn28 = iOff28 >= 0 ? [...smR28.footer.querySelectorAll("button")][iOff28] : null;
    check("R28 「全部停用」带悬停说明", !!offBtn28 && (offBtn28.title || "").includes("停用"), offBtn28 ? offBtn28.title : "");
    if (offBtn28) {
      offBtn28.click();
      await tick(90);
      const hid28 = widgetJSON(nodeR28).map((e) => e.hidden);
      check("R28 点「全部停用」后全部条目 hidden=true", hid28.length === 3 && hid28.every(Boolean), JSON.stringify(hid28));
      check("R28 条目仍留在列表里（只改 hidden 不删条目）", widgetJSON(nodeR28).length === 3, String(widgetJSON(nodeR28).length));
      const finfo28 = (smR28.footer.querySelector(".cft-footer-info") || {}).textContent || "";
      check("R28 footer-info 变成「3 条 · 0 条生效」", finfo28.includes("共 3 条") && finfo28.includes("0 条生效"), finfo28);
      // 可逆性：点「全部启用」必须整堆回来
      const onBtn28 = [...smR28.footer.querySelectorAll("button")][iOn28];
      onBtn28.click();
      await tick(90);
      check("R28 点「全部启用」后全部恢复生效",
        widgetJSON(nodeR28).length === 3 && widgetJSON(nodeR28).every((e) => e.hidden === false),
        JSON.stringify(widgetJSON(nodeR28).map((e) => e.hidden)));
    }
    smR28.close();
    await tick(50);

    /* ---- 28b：详情窗收藏按钮 ---- */
    FAKE.samples = false;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null, favorite: false };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const dmF = new T.DetailModal("A/one.safetensors", () => {});
    dmF.open();
    await tick(220);
    const favBtnD = dmF.body.querySelector(".cft-fav-btn");
    check("R28 详情窗有收藏按钮（.cft-fav-btn）", !!favBtnD, "");
    check("R28 未收藏时文案为「⭐ 收藏」", !!favBtnD && (favBtnD.textContent || "").includes("收藏"), favBtnD ? favBtnD.textContent : "");
    if (favBtnD) {
      favBtnD.click();
      await tick(220);
      const favBtnD2 = dmF.body.querySelector(".cft-fav-btn");
      check("R28 点收藏后按钮变「★ 已收藏」",
        !!favBtnD2 && (favBtnD2.textContent || "").includes("已收藏") && favBtnD2.dataset.fav === "1",
        favBtnD2 ? `${favBtnD2.textContent}|data-fav=${favBtnD2.dataset.fav}` : "");
      const umFavCall = (globalThis.__CFT_CALLS__ || []).filter((c) => c.url.endsWith("/cft_lora/user_meta") && c.method === "POST").pop();
      check("R28 收藏发出 POST /user_meta 且 favorite=true",
        !!umFavCall && umFavCall.body.favorite === true, JSON.stringify(umFavCall ? umFavCall.body : null));
      check("R28 收藏后弹「已收藏」提示",
        [...dmF.root.querySelectorAll(".cft-toast")].some((t) => (t.textContent || "").includes("已收藏")),
        dmF.root.querySelector(".cft-toast") ? dmF.root.querySelector(".cft-toast").textContent : "(无 toast)");
      // 再点一次 = 取消
      const favBtnD3 = dmF.body.querySelector(".cft-fav-btn");
      if (favBtnD3) favBtnD3.click();
      await tick(200);
      const favBtnD4 = dmF.body.querySelector(".cft-fav-btn");
      check("R28 再点一次取消收藏（文案回到「⭐ 收藏」）",
        !!favBtnD4 && (favBtnD4.textContent || "").includes("收藏") && !(favBtnD4.textContent || "").includes("已收藏") && favBtnD4.dataset.fav !== "1",
        favBtnD4 ? `${favBtnD4.textContent}|data-fav=${favBtnD4.dataset.fav}` : "");
      // 最终收尾状态：保持「已收藏」，供 28c 的分类筛选断言使用
      const favBtnD5 = dmF.body.querySelector(".cft-fav-btn");
      if (favBtnD5) favBtnD5.click();
      await tick(160);
    }
    dmF.close();
    await tick(60);

    /* ---- 28c：选择器 —— 工具栏收藏按钮 / 徽标 / 右键切换 / 文件名搜索 ---- */
    T.Store.invalidate();
    const nodeR28c = makeNode(282, []);
    const pickF = T.openPicker(nodeR28c, () => {});
    await tick(180);
    pickF.setView("grid");
    await tick(80);

    // 负向断言：文件夹下拉里**不再有** __favorites__ 虚拟分类（v2.10 起改成工具栏独立按钮）
    check("R28 文件夹下拉不再有 __favorites__ 虚拟分类",
      ![...pickF.folderSelect.options].some((o) => o.value === "__favorites__"),
      [...pickF.folderSelect.options].map((o) => o.value).join("|"));
    check("R28 文件夹下拉首项仍是「全部文件夹」",
      pickF.folderSelect.options.length >= 1 && pickF.folderSelect.options[0].value === "",
      pickF.folderSelect.options[0] ? pickF.folderSelect.options[0].textContent : "");

    // 工具栏收藏按钮：存在、位于搜索框右侧、计数正确
    const favBtnF = pickF.toolbar.querySelector(".cft-fav-btn");
    check("R28 toolbar 有独立收藏按钮（.cft-fav-btn）", !!favBtnF, "");
    check("R28 28b 收藏后按钮计数 = 1", !!favBtnF && /⭐ 收藏 \(1\)/.test(favBtnF.textContent || ""), favBtnF ? favBtnF.textContent : "");
    check("R28 收藏按钮初始未激活（无 cft-active）", !!favBtnF && !favBtnF.classList.contains("cft-active"), favBtnF ? favBtnF.className : "");
    // 位置：搜索框之后、folderSelect 之前
    if (favBtnF) {
      const tbKids = [...pickF.toolbar.children];
      const iSearch = tbKids.indexOf(pickF.searchInput);
      const iFav = tbKids.indexOf(favBtnF);
      const iFolder = tbKids.indexOf(pickF.folderSelect);
      check("R28 收藏按钮位于搜索框右侧、文件夹下拉左侧", iSearch >= 0 && iFav === iSearch + 1 && iFolder > iFav,
        `search@${iSearch} fav@${iFav} folder@${iFolder}`);
    }

    const favCards = () => pickF.grid.querySelectorAll(".cft-card-wrap");

    // 激活「只看收藏」：只剩 A/one 一条，且带 ⭐ 徽标
    if (favBtnF) favBtnF.click();
    await tick(110);
    check("R28 激活收藏后按钮变 cft-active + 「★ 收藏中」",
      !!favBtnF && favBtnF.classList.contains("cft-active") && /★ 收藏中 \(1\)/.test(favBtnF.textContent || ""),
      `${favBtnF ? favBtnF.className : ""} | ${favBtnF ? favBtnF.textContent : ""}`);
    check("R28 picker.favOnly 开关为 true", pickF.favOnly === true, String(pickF.favOnly));
    check("R28 「只看收藏」下只剩 1 条", favCards().length === 1, String(favCards().length));
    check("R28 收藏卡片带 .cft-chip-fav 徽标", !!pickF.grid.querySelector(".cft-chip-fav"), "");
    check("R28 收藏卡片正是 A/one（One）",
      favCards().length === 1 && /One/.test(favCards()[0].querySelector(".cft-card-title").textContent || ""),
      favCards().length ? favCards()[0].querySelector(".cft-card-title").textContent : "");

    // 叠加筛选：激活收藏 + 选文件夹 A → 仍只剩 A/one（该文件夹里的收藏）
    pickF.folderSelect.value = "A";
    pickF.folderSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(110);
    check("R28 收藏激活 + 文件夹 A 叠加后仍只剩 A/one", favCards().length === 1, String(favCards().length));
    // 叠加筛选：激活收藏 + 选文件夹 B（B/two 未收藏）→ 空
    pickF.folderSelect.value = "B";
    pickF.folderSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(110);
    check("R28 收藏激活 + 文件夹 B（无收藏）叠加后为空", favCards().length === 0, String(favCards().length));

    // 取消激活：恢复全部（4 条）
    pickF.folderSelect.value = "";
    pickF.folderSelect.dispatchEvent(new Event("change", { bubbles: true }));
    if (favBtnF) favBtnF.click();
    await tick(110);
    check("R28 再点一次恢复全部（4 条）", favCards().length === 4, String(favCards().length));
    check("R28 取消激活后按钮回到非激活态",
      !!favBtnF && !favBtnF.classList.contains("cft-active") && /⭐ 收藏 \(1\)/.test(favBtnF.textContent || ""),
      favBtnF ? `${favBtnF.className} | ${favBtnF.textContent}` : "");
    check("R28 全部列表下 A/one 仍带 ⭐ 徽标", !!pickF.grid.querySelector(".cft-card-wrap .cft-chip-fav"), "");
    check("R28 全部列表下只有 1 个 ⭐ 徽标（其余未收藏）",
      pickF.grid.querySelectorAll(".cft-chip-fav").length === 1, String(pickF.grid.querySelectorAll(".cft-chip-fav").length));

    // 右键菜单切换收藏
    const oneWrapF = [...pickF.grid.querySelectorAll(".cft-card-wrap")]
      .find((w) => /One/.test((w.querySelector(".cft-card-title") || {}).textContent || ""));
    check("R28 找到 One 卡片（右键目标）", !!oneWrapF, "");
    if (oneWrapF) {
      const ofRect = oneWrapF.getBoundingClientRect();
      oneWrapF.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ofRect.left + 20, clientY: ofRect.top + 20 }));
      await tick(40);
      const menuF = document.querySelector(".cft-ctxmenu");
      check("R28 卡片右键菜单出现", !!menuF, "");
      const favItem = menuF ? [...menuF.querySelectorAll(".cft-ctxmenu-item")].find((b) => (b.textContent || "").includes("收藏")) : null;
      check("R28 右键菜单有「★ 取消收藏」项（已收藏态）", !!favItem && (favItem.textContent || "").includes("取消收藏"),
        favItem ? favItem.textContent : "(无此项)");
      if (favItem) {
        favItem.click();
        await tick(180);
        check("R28 取消后工具栏按钮计数回到 0", !!favBtnF && /⭐ 收藏 \(0\)/.test(favBtnF.textContent || ""), favBtnF ? favBtnF.textContent : "");
        check("R28 取消后网格里没有 ⭐ 徽标", pickF.grid.querySelectorAll(".cft-chip-fav").length === 0, String(pickF.grid.querySelectorAll(".cft-chip-fav").length));
        check("R28 取消后弹「已取消收藏」提示",
          [...pickF.root.querySelectorAll(".cft-toast")].some((t) => (t.textContent || "").includes("已取消收藏")), "");
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    // 再从右键收藏回来（验证未收藏态菜单文案 + 徽标 + 按钮计数刷新）
    // 注意：刚才的点击已触发 renderGrid，旧的 wrap 已 detached —— 必须重新按标题找
    const oneWrapF2 = [...pickF.grid.querySelectorAll(".cft-card-wrap")]
      .find((w) => /One/.test((w.querySelector(".cft-card-title") || {}).textContent || ""));
    if (oneWrapF2) {
      const ofRect2 = oneWrapF2.getBoundingClientRect();
      oneWrapF2.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ofRect2.left + 20, clientY: ofRect2.top + 20 }));
      await tick(40);
      const menuF2 = document.querySelector(".cft-ctxmenu");
      const favItem2 = menuF2 ? [...menuF2.querySelectorAll(".cft-ctxmenu-item")].find((b) => (b.textContent || "").includes("收藏")) : null;
      check("R28 未收藏态菜单文案为「⭐ 收藏」", !!favItem2 && !(favItem2.textContent || "").includes("取消"), favItem2 ? favItem2.textContent : "(无此项)");
      if (favItem2) favItem2.click();
      await tick(180);
      check("R28 重新收藏后按钮计数 = 1、徽标回来",
        !!favBtnF && /⭐ 收藏 \(1\)/.test(favBtnF.textContent || "") && pickF.grid.querySelectorAll(".cft-chip-fav").length === 1,
        `${favBtnF ? favBtnF.textContent : "?"} / badges=${pickF.grid.querySelectorAll(".cft-chip-fav").length}`);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    // ---- 28d：文件名搜索（真实后端已实测 373/373 条 file_name 非空，见回执） ----
    const searchF = pickF.toolbar.querySelector(".cft-search");
    check("R28 搜索框 placeholder 提示支持文件名", !!searchF && (searchF.placeholder || "").includes("文件名"), searchF ? searchF.placeholder : "");
    const cardsF = () => pickF.grid.querySelectorAll(".cft-card-wrap").length;
    const doSearch = async (v) => {
      pickF.folderSelect.value = "";
      pickF.folderSelect.dispatchEvent(new Event("change", { bubbles: true }));
      searchF.value = v;
      searchF.dispatchEvent(new Event("input", { bubbles: true }));
      await tick(110);
    };
    await doSearch("one.safetensors");
    check("R28 搜完整文件名 'one.safetensors' 命中 1 条", cardsF() === 1, String(cardsF()));
    await doSearch("three.safetensors");
    check("R28 搜文件名 'three.safetensors' 命中 1 条", cardsF() === 1, String(cardsF()));
    await doSearch(".safetensors");
    check("R28 搜扩展名 '.safetensors' 命中全部 4 条（A~D）", cardsF() === 4, String(cardsF()));
    await doSearch("no-such-lora");
    check("R28 搜不到时显示 0 条（空态）", cardsF() === 0, String(cardsF()));
    await doSearch("");

    pickF.close();
    await tick(50);
    document.querySelectorAll(".cft-ctxmenu").forEach((el) => el.remove());
  }

  /* ============ R29：applyUserMetaToCache 的 favorite 部分更新语义 ============
     QA 独立验证定位的防御性缺口：后端响应里**缺** favorite 键（旧后端 /
     半新版本）时，`Boolean(undefined)` 会把「没返回这个键」误当成「显式取消收藏」，
     把 META_CACHE 里已有的收藏静默打回 false。修法：缺键时保留缓存原值，
     只有显式传布尔值才覆盖。 */
  {
    const r29 = "R29/one.safetensors";
    T.META_CACHE.clear();

    // 1) 缓存里已收藏 + 响应缺 favorite 键 → 必须保住 true（缺陷复现点）
    T.META_CACHE.set(r29, { lora: r29, user_tags: ["t"], user_note: "n", favorite: true });
    T.applyUserMetaToCache(r29, { tags: [], note: "", exists: false });
    check("R29 响应缺 favorite 键时保留缓存里的 true（旧后端不清空收藏）",
      T.META_CACHE.get(r29).favorite === true, String(T.META_CACHE.get(r29).favorite));

    // 2) 对照：显式传 false 必须能被置 false（防修过头）
    T.applyUserMetaToCache(r29, { tags: [], note: "", exists: false, favorite: false });
    check("R29 显式传 favorite=false 能正确取消收藏",
      T.META_CACHE.get(r29).favorite === false, String(T.META_CACHE.get(r29).favorite));

    // 3) 对照：显式传 true 覆盖 false
    T.applyUserMetaToCache(r29, { tags: [], note: "", exists: false, favorite: true });
    check("R29 显式传 favorite=true 能正确收藏",
      T.META_CACHE.get(r29).favorite === true, String(T.META_CACHE.get(r29).favorite));

    // 4) 缓存里就没有 favorite（首次读）且响应缺键 → 默认 false，不是 undefined
    const r29b = "R29/two.safetensors";
    T.applyUserMetaToCache(r29b, { tags: [], note: "", exists: false });
    check("R29 缓存无记录且响应缺键时 favorite=false（规范默认值）",
      T.META_CACHE.get(r29b).favorite === false, String(T.META_CACHE.get(r29b).favorite));

    // 5) 其余用户字段仍按原语义覆盖（这次修复不能外溢）
    T.applyUserMetaToCache(r29, { tags: ["新标签"], note: "新说明", exists: true });
    const r29c = T.META_CACHE.get(r29);
    check("R29 修复不外溢：tags/note/has_user 仍按响应覆盖",
      JSON.stringify(r29c.user_tags) === JSON.stringify(["新标签"]) && r29c.user_note === "新说明" && r29c.has_user === true,
      JSON.stringify({ t: r29c.user_tags, n: r29c.user_note, h: r29c.has_user }));
    check("R29 修复不外溢：favorite 在缺键时仍保持上一步的 true", r29c.favorite === true, String(r29c.favorite));

    T.META_CACHE.clear();
  }

  /* ============ R30：收藏视图必须含堆内 lora（v2.11 报障：从堆里收藏的看不到） ============
     用户场景：在堆窗口给堆里的 lora 点收藏 → .cft-user.json 落盘、/list 也返回
     favorite=true（运行期已实测），但打开 picker 点「⭐ 收藏」后网格是空的，
     按钮计数却显示 N —— 自相矛盾。
     根因：favOnly 写在 _matchBase() 里，而 filtered() 无标签筛选分支走
     _filterBase()（排除已在堆里的），把 favOnly 一起消费掉了；
     与 v2.8 修掉的标签口径（报障 8）是同一类病——「是否在堆里」泄漏进了收藏维度。 */
  {
    FAKE.samples = true;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();

    // 堆里放 mytagged（「堆内已收藏」样本）+ B/two（「堆外已收藏」对照）
    const nodeR30 = makeNode(300, [
      { lora: "Mine/mytagged.safetensors", weight: 1 },
      { lora: "B/two.safetensors", weight: 1 },
    ]);
    const pickFav = T.openPicker(nodeR30, () => {});
    await tick(180);

    // 复刻运行期实况：/list 回来两条 favorite=true（一条堆内、一条堆外）
    const inStackFav = pickFav.data.items.find((it) => it.lora === "Mine/mytagged.safetensors");
    const outStackFav = pickFav.data.items.find((it) => it.lora === "B/two.safetensors");
    inStackFav.favorite = true;
    outStackFav.favorite = true;
    pickFav._syncFavBtn();

    // 1) 按钮计数必须认这两条（全量口径）—— 用户看到的「⭐ 收藏 (2)」
    const favBtn30 = pickFav.toolbar.querySelector(".cft-fav-btn");
    check("R30 收藏按钮计数 = 2（含堆内那条）",
      !!favBtn30 && /\(2\)/.test(favBtn30.textContent || ""), favBtn30 ? favBtn30.textContent : "");

    // 2) 激活「只看收藏」→ 网格必须出 2 条（堆内 + 堆外）
    if (favBtn30) favBtn30.click();
    await tick(80);
    check("R30 picker.favOnly 激活", pickFav.favOnly === true, String(pickFav.favOnly));
    const cards30 = () => [...pickFav.grid.querySelectorAll(".cft-card-wrap")];
    check("R30 收藏视图出 2 条（修复前只剩堆外 1 条）", cards30().length === 2, String(cards30().length));
    check("R30 堆内已收藏条目出现在收藏视图（用户报障点）",
      cards30().some((c) => (c.textContent || "").includes("My Tagged")),
      cards30().map((c) => (c.textContent || "").slice(0, 24)).join("|"));

    // 3) 堆内那条带「已在堆中」徽标 + 降透明样式 + 不可选
    const instackCard30 = cards30().find((c) => (c.textContent || "").includes("My Tagged"));
    check("R30 堆内收藏条目带「已在堆中」徽标",
      !!instackCard30 && !!instackCard30.querySelector(".cft-chip-instack"),
      instackCard30 ? "有徽标" : "(无卡片)");
    check("R30 堆内收藏条目有 cft-instack 样式",
      !!instackCard30 && !!instackCard30.querySelector(".cft-card.cft-instack"));
    const body30 = instackCard30 ? instackCard30.querySelector(".cft-card-body") : null;
    if (body30) body30.click();
    await tick(60);
    check("R30 堆内收藏条目点不动（不加入已选）", pickFav.selected.size === 0, String(pickFav.selected.size));

    // 4) favOnly + 标签叠加：仍走含堆内口径（组合不回归）
    const sel30 = pickFav.tagSelect;
    if (sel30) {
      sel30.value = "我的收藏";
      sel30.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(100);
      check("R30 收藏 + 标签叠加后堆内收藏条目仍在（组合不回归）",
        cards30().some((c) => (c.textContent || "").includes("My Tagged")),
        String(cards30().length));
      sel30.value = "";
      sel30.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(100);
    }

    // 5) 退出收藏视图后，默认列表仍排除堆内（既有行为不变）
    if (favBtn30) favBtn30.click();
    await tick(80);
    check("R30 取消「只看收藏」后默认列表仍排除堆内（行为不变）",
      !pickFav._filterBase().some((it) => it.lora === "Mine/mytagged.safetensors"));
    check("R30 取消后 favOnly 归位", pickFav.favOnly === false, String(pickFav.favOnly));

    pickFav.close();
    await tick(40);
  }

  /* ============ R19：prompt 护栏（最终复查） ============ */
  {
    check("R19 全程 window.prompt 调用次数为 0（Electron 不支持）", PROMPT_CALLS === 0, String(PROMPT_CALLS));
    check("R19 文档里没有残留的 .cft-ask-modal（不该有挂住的 await）", document.querySelectorAll(".cft-ask-modal").length === 0,
      String(document.querySelectorAll(".cft-ask-modal").length));
  }

  /* ============ R31：v2.11 收藏修复边界探针（叠加筛选 / 移除重现 / 批量口径 / 空态） ============
     R30 覆盖 favOnly 基础场景与「favOnly+标签」叠加；这里补工程师未跑的边界：
     ① favOnly 与搜索 / 文件夹单独及三重叠加（AND 语义，堆内收藏必须可见）；
     ② 堆内收藏条目被移出堆后，默认列表重现且仍带收藏徽标；
     ③ favOnly 激活时堆内条目不得混进「批量查 C 站」的 _missingItems 批次；
     ④ 空收藏态：按钮 (0) + 网格空态，无异常；
     ⑤ 收藏视图里堆内条目仍不可添加（提示 / selected / batch 按钮不受影响）。
     反回归（favOnly 关闭时默认列表排除堆内）由 R30 第 5 组断言覆盖，不重复造轮子。 */
  {
    FAKE.samples = true;   // 需要 Mine/mytagged（folder Mine）等第四批样本
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null, favorite: false };
    FAKE.userName = "";
    // R7 的 /refresh_batch 曾把 two/three 写进 FAKE.resolved（回填成「已查到 C 站」形态），
    // 这里显式还原成「缺 C 站信息」样本，保证下面 _missingItems 探针的口径可证
    FAKE.resolved.delete("B/two.safetensors");
    FAKE.resolved.delete("C/three.safetensors");
    T.META_CACHE.clear();
    T.Store.invalidate();

    /* 堆里放 mytagged（堆内收藏样本，folder Mine）+ B/two（堆内收藏样本，folder B，
       且缺 C 站信息：无 creator/tags/触发词 → needsCivitaiLookup=true）；
       堆外收藏对照：C/three（folder C，同样缺 C 站信息，未在堆里）。 */
    const nodeR31 = makeNode(310, [
      { lora: "Mine/mytagged.safetensors", weight: 1 },
      { lora: "B/two.safetensors", weight: 1 },
    ]);
    const pickR31 = T.openPicker(nodeR31, () => {});
    await tick(180);

    // 运行期实况复刻：/list 回来三条 favorite=true（两条堆内 + 一条堆外）
    const r31mytagged = pickR31.data.items.find((it) => it.lora === "Mine/mytagged.safetensors");
    const r31two = pickR31.data.items.find((it) => it.lora === "B/two.safetensors");
    const r31three = pickR31.data.items.find((it) => it.lora === "C/three.safetensors");
    r31mytagged.favorite = true;
    r31two.favorite = true;
    r31three.favorite = true;
    pickR31._syncFavBtn();

    const cards31 = () => [...pickR31.grid.querySelectorAll(".cft-card-wrap")];
    const cardTexts31 = () => cards31().map((c) => (c.textContent || "").slice(0, 20));
    const favBtn31 = () => pickR31.toolbar.querySelector(".cft-fav-btn");
    const searchInp31 = () => pickR31.toolbar.querySelector(".cft-search");
    const typeSearch31 = (v) => {
      searchInp31().value = v;
      searchInp31().dispatchEvent(new Event("input", { bubbles: true }));
    };
    const pickFolder31 = (v) => {
      pickR31.folderSelect.value = v;
      pickR31.folderSelect.dispatchEvent(new Event("change", { bubbles: true }));
    };

    /* ---- ① favOnly + 搜索叠加：搜索词只命中堆内收藏条目 ---- */
    favBtn31().click();   // 激活「只看收藏」
    await tick(80);
    check("R31 favOnly 激活后收藏视图 = 3 条（2 堆内 + 1 堆外）", cards31().length === 3, String(cards31().length));
    typeSearch31("mytagged");
    await tick(90);
    check("R31 favOnly+搜索：只命中堆内收藏条目（修复前被 _filterBase 吃掉 → 0 条）",
      cards31().length === 1 && (cards31()[0].textContent || "").includes("My Tagged"),
      cardTexts31().join("|"));

    /* ---- ② favOnly + 文件夹叠加：选文件夹后堆内收藏条目仍出现 ---- */
    typeSearch31("");
    await tick(80);
    // 假后端 folders 只含 A/B/C；B/two 在 folder B 且在堆里，是「堆内收藏 + 文件夹」的最小复刻
    pickFolder31("B");
    await tick(90);
    check("R31 favOnly+文件夹 B：堆内收藏条目 B/two 出现（修复前 0 条）",
      cards31().length === 1 && (cards31()[0].textContent || "").includes("Two"),
      cardTexts31().join("|"));

    /* ---- ③ 三重叠加 favOnly + 文件夹 + 搜索（AND 语义） ---- */
    typeSearch31("two");
    await tick(90);
    check("R31 favOnly+文件夹+搜索三重叠加：堆内收藏条目仍出现",
      cards31().length === 1 && (cards31()[0].textContent || "").includes("Two"),
      cardTexts31().join("|"));
    typeSearch31("mytagged");   // 文件夹仍是 B，mytagged 在 folder Mine → AND 后应为空
    await tick(90);
    check("R31 三重叠加 AND 语义：文件夹 B + 搜索 mytagged → 0 条（不破坏交集）",
      cards31().length === 0, cardTexts31().join("|"));
    typeSearch31("");
    pickFolder31("");
    await tick(80);

    /* ---- ⑤ _missingItems：堆内收藏条目不得混进批量查 C 站批次 ---- */
    check("R31 收藏视图（favOnly 激活）含堆内缺信息条目 B/two",
      pickR31.filtered().some((it) => it.lora === "B/two.safetensors"),
      pickR31.filtered().map((it) => it.lora).join("|"));
    const missing31 = pickR31._missingItems().map((it) => it.lora);
    check("R31 _missingItems 不含堆内收藏条目 B/two（批量刷新不波及堆内）",
      !missing31.includes("B/two.safetensors"), missing31.join("|"));
    check("R31 _missingItems 含堆外收藏条目 C/three（缺信息且未在堆里）",
      missing31.includes("C/three.safetensors"), missing31.join("|"));
    check("R31 批量按钮只计堆外 1 条",
      /批量查 C 站 \(1\)/.test(pickR31.batchBtn.textContent || ""), pickR31.batchBtn.textContent);

    /* ---- ⑦ 收藏视图中堆内条目不可添加：提示 / selected / batch 按钮 ---- */
    const batchTextBefore31 = pickR31.batchBtn.textContent;
    const inStackFavCard31 = cards31().find((c) => (c.textContent || "").includes("My Tagged"));
    const body31 = inStackFavCard31 ? inStackFavCard31.querySelector(".cft-card-body") : null;
    if (body31) body31.click();
    await tick(60);
    check("R31 收藏视图点堆内条目卡片 body 弹「已在堆里」提示",
      [...pickR31.root.querySelectorAll(".cft-toast")].some((t) => (t.textContent || "").includes("已在堆里")),
      inStackFavCard31 ? "已点卡片 body" : "(无卡片)");
    check("R31 收藏视图点堆内条目后 selected 不变（0）", pickR31.selected.size === 0, String(pickR31.selected.size));
    check("R31 收藏视图点堆内条目后批量按钮文案不受影响",
      pickR31.batchBtn.textContent === batchTextBefore31, `${batchTextBefore31} → ${pickR31.batchBtn.textContent}`);

    // 退出收藏视图，收摊（反回归：favOnly 关闭后默认列表排除堆内由 R30 第 5 组断言覆盖）
    favBtn31().click();
    await tick(80);
    pickR31.close();
    await tick(40);

    /* ---- ④ 从堆里移除后：默认列表重现且仍带收藏徽标 ---- */
    // 把 mytagged 从 node.widgets 的 lora_stack JSON 里移除（模拟用户在堆窗口删掉这一行）
    const entriesR31 = widgetJSON(nodeR31).filter((e) => e.lora !== "Mine/mytagged.safetensors");
    nodeR31.widgets.find((w) => w.name === "lora_stack").value = JSON.stringify(entriesR31);
    check("R31 前置：堆里已无 mytagged",
      !T.readStack(nodeR31).some((e) => e.lora === "Mine/mytagged.safetensors"),
      T.readStack(nodeR31).map((e) => e.lora).join("|"));
    const pickR31b = T.openPicker(nodeR31, () => {});
    await tick(180);
    // 重开 picker 可能拿到重建的 items，重新落收藏标记再渲染
    const r31mytagged2 = pickR31b.data.items.find((it) => it.lora === "Mine/mytagged.safetensors");
    r31mytagged2.favorite = true;
    pickR31b.renderGrid();
    await tick(40);
    const cards31b = () => [...pickR31b.grid.querySelectorAll(".cft-card-wrap")];
    const myCard31b = cards31b().find((c) => (c.textContent || "").includes("My Tagged"));
    check("R31 移除出堆后默认列表重现 mytagged（不再被「排除堆内」挡住）", !!myCard31b,
      cards31b().map((c) => (c.textContent || "").slice(0, 20)).join("|"));
    check("R31 重现条目仍带收藏徽标 .cft-chip-fav",
      !!myCard31b && !!myCard31b.querySelector(".cft-chip-fav"), myCard31b ? "有徽标" : "(无卡片)");
    check("R31 仍在堆里的 B/two 不出现在默认列表（行为不变）",
      !cards31b().some((c) => (c.textContent || "").includes("Two")),
      cards31b().map((c) => (c.textContent || "").slice(0, 20)).join("|"));
    pickR31b.close();
    await tick(40);

    /* ---- ⑥ 空收藏态：无任何收藏时点 ⭐ 收藏 ---- */
    FAKE.user = { tags: [], note: "", cover: null, favorite: false };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();
    const pickEmpty31 = T.openPicker(makeNode(311, []), () => {});
    await tick(180);
    const favBtnEmpty31 = pickEmpty31.toolbar.querySelector(".cft-fav-btn");
    check("R31 空收藏态：按钮显示「⭐ 收藏 (0)」",
      !!favBtnEmpty31 && /收藏 \(0\)/.test(favBtnEmpty31.textContent || ""),
      favBtnEmpty31 ? favBtnEmpty31.textContent : "");
    if (favBtnEmpty31) favBtnEmpty31.click();
    await tick(80);
    check("R31 空收藏态：激活后按钮显示「★ 收藏中 (0)」",
      /收藏中 \(0\)/.test(favBtnEmpty31.textContent || ""), favBtnEmpty31.textContent);
    const emptyCell31 = pickEmpty31.grid.querySelector(".cft-empty");
    check("R31 空收藏态：网格空态「没有匹配的 Lora」",
      !!emptyCell31 && (emptyCell31.textContent || "").includes("没有匹配的 Lora"),
      pickEmpty31.grid.textContent.slice(0, 40));
    check("R31 空收藏态：无卡片渲染",
      pickEmpty31.grid.querySelectorAll(".cft-card-wrap").length === 0,
      String(pickEmpty31.grid.querySelectorAll(".cft-card-wrap").length));
    const hintEmpty31 = (pickEmpty31.toolbar.querySelector(".cft-hint") || {}).textContent || "";
    check("R31 空收藏态：hint 显示「匹配 0 个」且无异常", hintEmpty31.includes("匹配 0"), hintEmpty31);
    pickEmpty31.close();
    await tick(40);
  }

  /* ============ R32：收藏星标 2 个新入口（卡片 / 列表行 ⓘ 旁 + 堆条目行「启用」旁） ============
     v2.12 需求：收藏别只藏在详情窗和右键菜单里，要放在随手就能点到的地方——
     ① 选择器的卡片 / 列表行脚部（ⓘ 左边）；② 堆条目行「启用」右边。
     点一下收藏、再点取消；四个入口（这两处 + 详情窗 + 右键菜单）写的是同一份
     .cft-user.json，所以工具栏「⭐ 收藏」的计数必须跟着一起动。 */
  {
    const lastFavCall = () =>
      (globalThis.__CFT_CALLS__ || []).filter((c) => c.url.endsWith("/cft_lora/user_meta") && c.method === "POST").pop();
    const favStar32 = (root) => root.querySelector(".cft-card-fav");

    /* ---- 32a：网格卡片脚部（ⓘ 左边） ---- */
    FAKE.samples = false;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null, favorite: false };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const nodeR32 = makeNode(320, []);
    const pick32 = T.openPicker(nodeR32, () => {});
    await tick(180);
    pick32.setView("grid");
    await tick(80);

    check("R32 卡片脚部有收藏星标（.cft-card-fav）", !!favStar32(pick32.grid), "");
    const foot32 = pick32.grid.querySelector(".cft-card-foot");
    const kids32 = foot32 ? [...foot32.children] : [];
    const iStar32 = kids32.findIndex((el) => el.classList.contains("cft-card-fav"));
    const iInfo32 = kids32.findIndex((el) => (el.textContent || "") === "ⓘ");
    check("R32 星标紧挨在 ⓘ 左边", iStar32 >= 0 && iInfo32 === iStar32 + 1, `星标@${iStar32} ⓘ@${iInfo32}`);
    check("R32 未收藏时空心 ☆ 且无 cft-faved",
      !!favStar32(pick32.grid) && (favStar32(pick32.grid).textContent || "") === "☆" && !favStar32(pick32.grid).classList.contains("cft-faved"),
      favStar32(pick32.grid) ? favStar32(pick32.grid).textContent : "(无星标)");
    check("R32 未收藏时卡片没有 ⭐ 徽标", !pick32.grid.querySelector(".cft-card-wrap .cft-chip-fav"), "");

    if (favStar32(pick32.grid)) {
      favStar32(pick32.grid).click();
      await tick(220);
      const s1 = favStar32(pick32.grid);
      check("R32 点一下 → 实心 ★ + cft-faved",
        !!s1 && (s1.textContent || "") === "★" && s1.classList.contains("cft-faved"), s1 ? s1.textContent : "(无星标)");
      check("R32 星标发出 POST /user_meta 且 favorite=true",
        !!lastFavCall() && lastFavCall().body.favorite === true, JSON.stringify(lastFavCall() ? lastFavCall().body : null));
      check("R32 收藏后卡片出现 ⭐ 徽标", !!pick32.grid.querySelector(".cft-card-wrap .cft-chip-fav"), "");
      const favBtnTxt32 = pick32.toolbar.querySelector(".cft-fav-btn");
      check("R32 工具栏收藏计数同步为 (1)", !!favBtnTxt32 && /\(1\)/.test(favBtnTxt32.textContent || ""),
        favBtnTxt32 ? favBtnTxt32.textContent : "");
      check("R32 收藏后弹「已收藏」提示",
        [...pick32.root.querySelectorAll(".cft-toast")].some((t) => (t.textContent || "").includes("已收藏")), "");

      // 再点一次 = 取消
      if (favStar32(pick32.grid)) {
        favStar32(pick32.grid).click();
        await tick(200);
        const s2 = favStar32(pick32.grid);
        check("R32 再点一次 → 回到 ☆（取消收藏）",
          !!s2 && (s2.textContent || "") === "☆" && !s2.classList.contains("cft-faved"), s2 ? s2.textContent : "(无星标)");
        check("R32 取消后 ⭐ 徽标消失", !pick32.grid.querySelector(".cft-card-wrap .cft-chip-fav"), "");
        const favBtnTxt32b = pick32.toolbar.querySelector(".cft-fav-btn");
        check("R32 取消后工具栏计数回到 (0)", !!favBtnTxt32b && /\(0\)/.test(favBtnTxt32b.textContent || ""),
          favBtnTxt32b ? favBtnTxt32b.textContent : "");
      }
    }

    /* ---- 32b：列表行（同一位置，视图切换后仍可用） ---- */
    pick32.setView("list");
    await tick(140);
    check("R32 列表行也有收藏星标", !!pick32.grid.querySelector(".cft-list-row .cft-card-fav"), "");
    const rowStar32 = pick32.grid.querySelector(".cft-list-row .cft-card-fav");
    if (rowStar32) {
      rowStar32.click();
      await tick(220);
      check("R32 列表行星标点一下 → ★",
        (() => { const s = pick32.grid.querySelector(".cft-list-row .cft-card-fav"); return !!s && (s.textContent || "") === "★"; })(),
        "");
      check("R32 列表行星标发出 POST favorite=true",
        !!lastFavCall() && lastFavCall().body.favorite === true, JSON.stringify(lastFavCall() ? lastFavCall().body : null));
      const rowStar32b = pick32.grid.querySelector(".cft-list-row .cft-card-fav");
      if (rowStar32b) { rowStar32b.click(); await tick(180); }
    }
    pick32.close();
    await tick(40);

    /* ---- 32c：堆条目行「启用」右边 ---- */
    FAKE.user = { tags: [], note: "", cover: null, favorite: false };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const nodeR32b = makeNode(321, [{ lora: "A/one.safetensors", weight: 1 }]);
    const sm32 = T.openStackManager(nodeR32b);
    await tick(200);
    const row32 = sm32.body.querySelector(".cft-stack-row");
    const starRow32 = row32 ? row32.querySelector(".cft-fav-toggle") : null;
    check("R32 堆条目行有收藏星标（.cft-fav-toggle）", !!starRow32, "");

    if (row32) {
      const fields32 = [...row32.querySelectorAll(".cft-row-controls .cft-field")];
      const iToggle32 = fields32.findIndex((f) => (f.textContent || "").includes("启用"));
      const iFav32 = fields32.findIndex((f) => (f.textContent || "").includes("收藏"));
      check("R32 收藏字段紧挨「启用」字段右侧", iToggle32 >= 0 && iFav32 === iToggle32 + 1, `启用@${iToggle32} 收藏@${iFav32}`);
    }
    check("R32 堆行星标初始为 ☆", !!starRow32 && (starRow32.textContent || "") === "☆", starRow32 ? starRow32.textContent : "");

    if (starRow32) {
      starRow32.click();
      await tick(220);
      const sr1 = sm32.body.querySelector(".cft-stack-row .cft-fav-toggle");
      check("R32 堆行星标点一下 → ★ + cft-faved",
        !!sr1 && (sr1.textContent || "") === "★" && sr1.classList.contains("cft-faved"), sr1 ? sr1.textContent : "(无星标)");
      check("R32 堆行星标发出 POST /user_meta 且 favorite=true",
        !!lastFavCall() && lastFavCall().body.favorite === true && lastFavCall().body.name === "A/one.safetensors",
        JSON.stringify(lastFavCall() ? lastFavCall().body : null));
      check("R32 堆行收藏后弹「已收藏」提示",
        [...sm32.root.querySelectorAll(".cft-toast")].some((t) => (t.textContent || "").includes("已收藏")), "");
      // 再点一次 = 取消
      if (sr1) {
        sr1.click();
        await tick(200);
        const sr2 = sm32.body.querySelector(".cft-stack-row .cft-fav-toggle");
        check("R32 堆行星标再点一次 → ☆（取消收藏）",
          !!sr2 && (sr2.textContent || "") === "☆" && !sr2.classList.contains("cft-faved"), sr2 ? sr2.textContent : "(无星标)");
        const call32 = lastFavCall();
        check("R32 堆行取消发出 POST favorite=false", !!call32 && call32.body.favorite === false,
          JSON.stringify(call32 ? call32.body : null));
      }
      // 收尾：保持已收藏状态，便于人工看效果（不影响后续断言）
      const sr3 = sm32.body.querySelector(".cft-stack-row .cft-fav-toggle");
      if (sr3) { sr3.click(); await tick(180); }
    }
    sm32.close();
    await tick(40);
  }

  /* ============ R33：堆数据本机备份 / 重启恢复（v2.13） ============
     报障：Lora 堆里加好 lora，重启 ComfyUI 后堆是空的（节点还在）。
     根因：堆数据只存在 lora_stack widget 里、随工作流保存，而只改 widget
     值不会让 ComfyUI 认为工作流变了（草稿 / 自动保存不刷新）→ 恢复的是
     堆还是空的那份旧快照。修复：① 写堆时显式通知图变更；② 额外写一份
     本机备份，重启后 widget 为空时自动回填。 */
  {
    const e33 = (lora, name, weight) =>
      ({ lora, name, weight, text_encoder_weight: 1, trigger_weight: 0 });

    const n33 = makeNode(3301, []);
    T.writeStack(n33, [e33("B/two.safetensors", "two", 0.8), e33("C/three.safetensors", "three", 0.5)]);
    check("R33 写堆后本机备份存在", T.readStackBackup(n33).length === 2,
      String(T.readStackBackup(n33).length));

    const bak33 = T.readStackBackup(n33);
    check("R33 备份内容保真（含权重）",
      bak33.length === 2 && bak33[0].lora === "B/two.safetensors" && Math.abs(bak33[0].weight - 0.8) < 1e-6,
      JSON.stringify(bak33.map((e) => [e.lora, e.weight])));

    // 模拟「重启 / 重载工作流」：widget 被工作流里的空值覆盖，备份还在
    n33.widgets[0].value = "[]";
    check("R33 模拟重启后 widget 里是空堆", T.readStack(n33).length === 0, String(T.readStack(n33).length));
    const restored33 = T.restoreStackFromBackup(n33);
    check("R33 从备份恢复 2 条", restored33 === 2, String(restored33));
    check("R33 恢复结果写回 widget（不只是内存）", T.readStack(n33).length === 2,
      widgetJSON(n33).length + " 条");

    // 有真实数据时绝不覆盖
    const n33b = makeNode(3302, []);
    T.writeStack(n33b, [e33("A/one.safetensors", "one", 1)]);
    const before33b = widgetJSON(n33b).map((e) => e.lora).join(",");
    check("R33 widget 有数据时恢复不覆盖",
      T.restoreStackFromBackup(n33b) === 0 && widgetJSON(n33b).map((e) => e.lora).join(",") === before33b,
      before33b);

    // 清空堆 = 删备份（否则清空后一重启又被填回来）
    const n33c = makeNode(3303, []);
    T.writeStack(n33c, [e33("D/four.safetensors", "four", 1)]);
    check("R33 清空前有备份", T.readStackBackup(n33c).length === 1, String(T.readStackBackup(n33c).length));
    T.writeStack(n33c, []);
    check("R33 清空堆后备份被删除", T.readStackBackup(n33c).length === 0, String(T.readStackBackup(n33c).length));
    check("R33 清空后重启不会被填回来", T.restoreStackFromBackup(n33c) === 0,
      String(T.restoreStackFromBackup(n33c)));

    // 通知图变更：草稿 / 自动保存才会感知（只改 widget 值默认不会）
    let changed33 = 0;
    const n33d = makeNode(3304, []);
    n33d.graph = { change() { changed33 += 1; } };
    T.writeStack(n33d, [e33("A/one.safetensors", "one", 1)]);
    check("R33 写堆时通知了图变更（草稿才会刷新）", changed33 === 1, String(changed33));

    // 备份按节点 id 隔离，互不影响
    check("R33 备份按节点 id 隔离",
      T.stackBakKey(n33) !== T.stackBakKey(n33b) &&
      T.readStackBackup(n33).length === 2 && T.readStackBackup(n33b).length === 1,
      `${T.readStackBackup(n33).length}/${T.readStackBackup(n33b).length}`);

    // 新建节点不得回填：备份 key 按 node id，新工作流 id 常从 1 开始，
    // 一视同仁地恢复会把别的堆凭空填进新节点（QA 实测撞号）
    const n33e = makeNode(3305, []);
    T.writeStack(n33e, [e33("B/two.safetensors", "two", 0.7)]);
    n33e.widgets[0].value = "[]";
    T.setupNode(n33e);
    await tick(120);
    check("R33 新建节点不回填备份（防跨工作流串号）", T.readStack(n33e).length === 0,
      String(T.readStack(n33e).length));

    // 加载路径（onConfigure）必须回填 —— 这才是用户「重启后」走的路
    const n33f = makeNode(3306, []);
    T.writeStack(n33f, [e33("B/two.safetensors", "two", 0.7)]);
    n33f.widgets[0].value = "[]";
    T.setupNode(n33f);
    await tick(20);
    if (typeof n33f.onConfigure === "function") n33f.onConfigure({});
    await tick(140);
    check("R33 加载工作流（onConfigure）时回填备份", T.readStack(n33f).length === 1,
      String(T.readStack(n33f).length));
  }

  /* ============ R34：v2.13 备份机制的边界探针（独立 QA 追加，永久保留） ============
     R33 覆盖的是 happy path；这里专挑 R33 没碰过的地方：
     ① 备份被写坏（非法 JSON / entries 非数组 / 条目为 null 或缺 lora）
     ② localStorage 不可用（隐私模式 / 配额满 / SecurityError）时不得崩溃
     ③ LRU 上限 30 真的会淘汰最旧备份、索引不失控
     ④ 恢复后用户一动手 → 横幅消失 + 备份同步更新
     ⑤ 跨工作流节点 id 撞车时的实际行为（已知取舍，这里如实记录）
     ⑥ 恢复出来的条目字段必须完整，能直接出图（不是只剩名字的残壳） */
  {
    const e34 = (lora, name, weight) =>
      ({ lora, name, weight, text_encoder_weight: 1, trigger_weight: 0, hidden: false });
    const keyOf = (node) => T.LS_PREFIX + T.stackBakKey(node);
    const idxOf = () => T.LS.getJSON("stackbak.index", []) || [];
    /** 调 fn 并捕获异常：期望「不抛」的用例用它，避免整份沙盒被一处 throw 打断 */
    const guard = (fn) => {
      try { return { ok: true, v: fn() }; } catch (err) { return { ok: false, v: "THROW:" + err.message }; }
    };

    /* ---------- ① 备份损坏 / 脏数据 ---------- */

    const n34a = makeNode(3401, []);

    localStorage.setItem(keyOf(n34a), "{not-json");
    const a1 = guard(() => T.readStackBackup(n34a));
    check("R34 非法 JSON 备份 → 空数组且不抛异常",
      a1.ok && Array.isArray(a1.v) && a1.v.length === 0, JSON.stringify(a1.v));

    localStorage.setItem(keyOf(n34a), JSON.stringify({ ts: 1, entries: { 0: "x" } }));
    const a2 = guard(() => T.readStackBackup(n34a));
    check("R34 entries 不是数组 → 空数组且不抛异常",
      a2.ok && Array.isArray(a2.v) && a2.v.length === 0, JSON.stringify(a2.v));

    localStorage.setItem(keyOf(n34a), JSON.stringify({ ts: 1, entries: null }));
    const a2b = guard(() => T.readStackBackup(n34a));
    check("R34 entries 为 null → 空数组且不抛异常",
      a2b.ok && Array.isArray(a2b.v) && a2b.v.length === 0, JSON.stringify(a2b.v));

    localStorage.setItem(keyOf(n34a), JSON.stringify({ ts: 1, entries: "我是被别的扩展写成字符串的备份" }));
    const a2c = guard(() => T.readStackBackup(n34a));
    check("R34 entries 是字符串 → 空数组且不抛异常",
      a2c.ok && Array.isArray(a2c.v) && a2c.v.length === 0, JSON.stringify(a2c.v));

    // 条目级脏数据：null / 缺 lora 字段 / 非对象
    localStorage.setItem(keyOf(n34a), JSON.stringify({
      ts: 1,
      entries: [null, undefined, { no_lora: 1 }, "", 0, e34("A/one.safetensors", "one", 1)],
    }));
    const a3 = guard(() => T.readStackBackup(n34a));
    check("R34 entries 含 null / 缺 lora / 非对象 → 只保留合法项且不抛异常",
      a3.ok && Array.isArray(a3.v) && a3.v.length === 1 && a3.v[0].lora === "A/one.safetensors",
      a3.ok ? JSON.stringify(a3.v.map((e) => e && e.lora)) : a3.v);
    check("R34 readStack 同样要扛住脏条目（同一条路上最容易被先打到）",
      (() => { n34a.widgets[0].value = JSON.stringify([null, { no_lora: 1 }, e34("A/one.safetensors", "one", 1)]);
        const r = guard(() => T.readStack(n34a));
        return r.ok && Array.isArray(r.v) && r.v.length === 1; })(),
      JSON.stringify(guard(() => T.readStack(n34a)).v.map ? guard(() => T.readStack(n34a)).v.map((e) => e && e.lora) : ""));

    // normalizeEntry 是上面所有链路的入口：它自己必须先不炸
    const ne1 = guard(() => T.normalizeEntry(null));
    check("R34 normalizeEntry(null) 返回 null 而不是抛异常", ne1.ok && ne1.v === null, String(ne1.v));
    const ne2 = guard(() => T.normalizeEntry(undefined));
    check("R34 normalizeEntry(undefined) 返回 null 而不是抛异常", ne2.ok && ne2.v === null, String(ne2.v));

    // 脏备份下走完整个恢复链路（真正会在重启时执行的那条路）
    n34a.widgets[0].value = "[]";
    const a4 = guard(() => T.restoreStackFromBackup(n34a));
    check("R34 脏备份下 restore 不抛异常且只回填合法项",
      a4.ok && a4.v === 1 && T.readStack(n34a).length === 1, `${a4.v}/${T.readStack(n34a).length}`);
    // widget 里是坏 JSON 而不是 "[]" 时也要能恢复
    n34a.widgets[0].value = "{也没词儿";
    const a5 = guard(() => T.restoreStackFromBackup(n34a));
    check("R34 widget 是坏 JSON 时也能从备份回填",
      a5.ok && a5.v === 1 && T.readStack(n34a).length === 1, `${a5.v}/${T.readStack(n34a).length}`);
    localStorage.removeItem(keyOf(n34a));

    /* ---------- ② localStorage 不可用（隐私模式 / 配额满 / 跨域被拒） ---------- */

    const n34b = makeNode(3402, []);
    const proto34 = Object.getPrototypeOf(localStorage);
    const origSet34 = proto34.setItem;
    const origRemove34 = proto34.removeItem;
    proto34.setItem = () => { throw new Error("QuotaExceededError: 配额已满"); };
    proto34.removeItem = () => { throw new Error("SecurityError: 存储被禁用"); };
    const b1 = guard(() => T.writeStack(n34b, [e34("B/two.safetensors", "two", 0.6)]));
    const b2 = guard(() => T.backupStack(n34b, [e34("B/two.safetensors", "two", 0.6)]));
    const b3 = guard(() => T.backupStack(n34b, []));          // 清空分支：走的是 removeItem
    const b4 = guard(() => T.restoreStackFromBackup(n34b));
    proto34.setItem = origSet34;
    proto34.removeItem = origRemove34;
    check("R34 setItem 抛错时 writeStack 静默降级不抛异常", b1.ok, String(b1.v));
    check("R34 setItem 抛错时 backupStack 静默降级不抛异常", b2.ok, String(b2.v));
    check("R34 removeItem 抛错时清空分支（backupStack([])）不抛异常", b3.ok, String(b3.v));
    check("R34 removeItem 抛错时 restore 链路不抛异常", b4.ok, String(b4.v));
    check("R34 存储不可用时堆仍然正常写进 widget（降级不损主功能）",
      T.readStack(n34b).length === 1 && Math.abs(T.readStack(n34b)[0].weight - 0.6) < 1e-6,
      String(T.readStack(n34b).length));
    check("R34 存储恢复可用后备份能补写回来",
      guard(() => T.backupStack(n34b, T.readStack(n34b))).ok && T.readStackBackup(n34b).length === 1,
      String(T.readStackBackup(n34b).length));

    /* ---------- ③ LRU 上限：连续写超过 30 个不同节点的备份 ---------- */

    // 前面的用例已经在索引里留下若干 key，先清干净才能确定地数边界
    for (const k of idxOf()) localStorage.removeItem(T.LS_PREFIX + k);
    localStorage.removeItem(T.LS_PREFIX + "stackbak.index");

    const nodes34 = [];
    for (let i = 1; i <= 35; i++) {
      const n34c = makeNode(3500 + i, []);
      nodes34.push(n34c);
      T.writeStack(n34c, [e34("B/two.safetensors", "two", 0.5)]);
    }
    const idx34 = idxOf();
    const firstKey34 = T.stackBakKey(nodes34[0]);
    const newestKey34 = T.stackBakKey(nodes34[34]);
    check("R34 索引长度停在上限 30（写 35 个节点）", idx34.length === 30, String(idx34.length));
    check("R34 最旧的备份数据被真正删除（不是只出索引）",
      localStorage.getItem(T.LS_PREFIX + firstKey34) === null,
      `idx 里还有=${idx34.includes(firstKey34)}`);
    check("R34 最旧的 key 不再留在索引里", !idx34.includes(firstKey34), String(idx34.includes(firstKey34)));
    check("R34 最新的备份仍在（数据 + 索引都在）",
      localStorage.getItem(T.LS_PREFIX + newestKey34) !== null && idx34.includes(newestKey34), newestKey34);
    check("R34 边界内第 6 个（索引头一个）仍在",
      localStorage.getItem(T.LS_PREFIX + T.stackBakKey(nodes34[5])) !== null,
      `idx[0]=${idx34[0]}`);
    // 再写一次旧 key：它会被重新挪到队尾，不会被永久遗忘
    T.writeStack(nodes34[0], [e34("B/two.safetensors", "two", 0.9)]);
    check("R34 重新写入的旧节点会回到队尾并被保留",
      idxOf().includes(firstKey34) && localStorage.getItem(T.LS_PREFIX + firstKey34) !== null,
      String(idxOf().includes(firstKey34)));
    // 清空堆：数据 + 索引项一起清掉（留死 key 会占 LRU 槽位，把有效备份提前挤掉）
    const beforeIdx34 = idxOf().slice();
    T.writeStack(nodes34[0], []);
    check("R34 清空堆后数据与索引项一起清掉（不留死 key 占槽位）",
      localStorage.getItem(T.LS_PREFIX + firstKey34) === null &&
      !idxOf().includes(firstKey34) && idxOf().length === beforeIdx34.length - 1,
      `before=${beforeIdx34.length} idx=${idxOf().length} 含旧key=${idxOf().includes(firstKey34)}`);
    check("R34 清空后索引项不会让数据凭空回填", T.restoreStackFromBackup(nodes34[0]) === 0,
      String(T.restoreStackFromBackup(nodes34[0])));

    /* ---------- ④ 恢复之后再改动：横幅 / 备份都要跟着走 ---------- */

    const n34d = makeNode(3404, []);
    T.writeStack(n34d, [e34("A/one.safetensors", "one", 1), e34("B/two.safetensors", "two", 1)]);
    n34d.widgets[0].value = "[]";       // 模拟重启后工作流里存着空堆
    T.setupNode(n34d);
    await tick(20);
    // 恢复只在「确实从工作流加载出来」的路径上跑：onConfigure（另见 loadedGraphNode）
    if (typeof n34d.onConfigure === "function") n34d.onConfigure({});
    await tick(140);
    const panel34 = n34d._dom && n34d._dom.el;
    check("R34 恢复后节点面板出现「已从本机备份恢复」横幅",
      !!panel34 && !!panel34.querySelector(".cft-np-restored"), panel34 ? panel34.className : "");
    // 取最近弹出的那一条：R33 的 setupNode 也会弹 toast，且 4.2s 后才自毁，
    // querySelector 拿到的是早先那条（测试一度因此误报过条数）。
    const toasts34 = [...document.querySelectorAll(".cft-toast-global")];
    const toast34 = toasts34[toasts34.length - 1];
    check("R34 恢复后弹出全局 toast 且写明条数",
      !!toast34 && /恢复 2 条/.test(toast34.textContent || ""), toast34 ? toast34.textContent : "(无)");
    check("R34 全局 toast 挂在 body 下的堆叠容器里（不会被弹窗容器裁掉）",
      !!toast34 && !!toast34.closest("#cft-toast-host") &&
      toast34.closest("#cft-toast-host").parentElement === document.body,
      toast34 ? String(toast34.parentElement && toast34.parentElement.id) : "");
    // 多条同时出现时挂在同一个容器里纵向堆叠，不再互相压住
    check("R34 多条 toast 共用同一个堆叠容器（不再互相盖住）",
      toasts34.length >= 1 && toasts34.every((t) => t.parentElement === document.getElementById("cft-toast-host")),
      `当前 ${toasts34.length} 条`);

    const list34d = T.readStack(n34d);
    if (list34d[0]) list34d[0].weight = 0.42;   // 防御：万一没恢复也别把测试整体带崩
    T.writeStack(n34d, list34d);
    T.refreshNodePanel(n34d);
    await tick(30);
    check("R34 用户一改手，恢复横幅就撤掉（state.restoredN 归零）",
      !!panel34 && !panel34.querySelector(".cft-np-restored"), "");
    const bak34d = T.readStackBackup(n34d);
    check("R34 改动后备份同步为新权重",
      bak34d.length === 2 && Math.abs(bak34d[0].weight - 0.42) < 1e-6,
      JSON.stringify(bak34d.map((e) => [e.lora, e.weight])));
    check("R34 横幅的 ✕ 也能手动关掉",
      (() => {
        n34d.widgets[0].value = "[]";
        T.restoreStackFromBackup(n34d);
        T.refreshNodePanel(n34d);
        const banner = panel34.querySelector(".cft-np-restored");
        const btn = banner && banner.querySelector(".cft-np-btn");
        if (!btn) return false;
        btn.click();
        return !panel34.querySelector(".cft-np-restored");
      })(), String(!!panel34.querySelector(".cft-np-restored")));

    /* ---------- ⑤ 两个节点 id 相同但内容不同（跨工作流 id 撞车） ---------- */

    const n34e1 = makeNode(3405, []);
    const n34e2 = makeNode(3405, []);   // 故意同 id：模拟另一个工作流里的同号节点
    T.writeStack(n34e1, [e34("A/one.safetensors", "one", 1)]);
    T.writeStack(n34e2, [e34("C/three.safetensors", "three", 1)]);
    check("R34 同 id 的两个节点共用同一份备份 key（已知取舍）",
      T.stackBakKey(n34e1) === T.stackBakKey(n34e2), T.stackBakKey(n34e1));
    check("R34 同 id：后写覆盖备份，但已有数据的旧节点 widget 不被改动（无数据丢失）",
      T.readStack(n34e1).length === 1 && T.readStack(n34e1)[0].lora === "A/one.safetensors" &&
      T.readStackBackup(n34e1)[0].lora === "C/three.safetensors",
      `widget=${T.readStack(n34e1).map((e) => e.lora).join(",")} bak=${T.readStackBackup(n34e1).map((e) => e.lora).join(",")}`);
    const n34e3 = makeNode(3405, []);   // 新工作流里的空节点
    const e3n = T.restoreStackFromBackup(n34e3);
    check("R34 同 id 的空节点会被另一份备份填满（记录行为：不丢数据，但可能串工作流）",
      e3n === 1 && T.readStack(n34e3)[0].lora === "C/three.safetensors",
      `${e3n}:${T.readStack(n34e3).map((e) => e.lora).join(",")}`);
    localStorage.removeItem(keyOf(n34e1));

    // A.3 对照组：全新节点（这个 id 没有任何备份）必须保持空、也不该挂横幅
    const n34g = makeNode(3499, []);
    T.setupNode(n34g);
    await tick(60);
    check("R34 全新节点（无备份）不会被误填、也不显示恢复横幅",
      T.readStack(n34g).length === 0 &&
      !(n34g._dom && n34g._dom.el && n34g._dom.el.querySelector(".cft-np-restored")),
      String(T.readStack(n34g).length));

    /* ---------- ⑥ 恢复出来的数据必须能直接出图（字段完整） ---------- */

    const n34f = makeNode(3406, []);
    T.writeStack(n34f, [{
      lora: "D/four.safetensors", name: "four", display_name: "Four",
      weight: 0.75, text_encoder_weight: 0.5, trigger_weight: 1, hidden: true,
    }]);
    n34f.widgets[0].value = "[]";
    T.restoreStackFromBackup(n34f);
    const f34 = T.readStack(n34f)[0] || {};
    check("R34 恢复出的字段完整：lora / weight / text_encoder_weight / trigger_weight / hidden",
      f34.lora === "D/four.safetensors" && Math.abs(f34.weight - 0.75) < 1e-6 &&
      Math.abs(f34.text_encoder_weight - 0.5) < 1e-6 && Math.abs(f34.trigger_weight - 1) < 1e-6 &&
      f34.hidden === true,
      JSON.stringify(f34));
    check("R34 恢复出的条目有 name / display_name（面板要显示）",
      f34.name === "four" && !!f34.display_name, `${f34.name}|${f34.display_name}`);
    check("R34 恢复出的条目 _meta 可取用（不清空 META_CACHE 就能显示作者）",
      "_meta" in f34, JSON.stringify(Object.keys(f34)));
    const raw34 = localStorage.getItem(keyOf(n34f));
    check("R34 备份里只存纯数据字段，不带 _meta / _preview（体积可控）",
      !!raw34 && !/"_(meta|preview)"/.test(raw34), raw34 ? raw34.slice(0, 96) : "(无备份)");
    localStorage.removeItem(keyOf(n34f));

    /* ---------- ⑦ 反向边界：工作流里存的是「旧的非空堆」 ---------- */

    // 只在 widget 为空时回填 = 绝不覆盖真实数据。代价：用户"存过旧版本 → 又改了
    // 但没保存"的那部分增量仍然会丢（备份不会盖回去）。这是有意的安全取舍，记录之。
    const n34h = makeNode(3407, []);
    T.writeStack(n34h, [
      e34("A/one.safetensors", "one", 1),
      e34("B/two.safetensors", "two", 1),
      e34("C/three.safetensors", "three", 1),
    ]);
    n34h.widgets[0].value = JSON.stringify([
      { lora: "A/one.safetensors", name: "one", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
    ]);
    check("R34 工作流里是旧的非空堆时备份不覆盖（旧值优先，未保存的增量会丢：已知取舍）",
      T.restoreStackFromBackup(n34h) === 0 && T.readStack(n34h).length === 1,
      `恢复条数=${T.restoreStackFromBackup(n34h)} 当前=${T.readStack(n34h).length} 条`);
    localStorage.removeItem(keyOf(n34h));
  }

  /* ------------------------------------------------------------------ R35
     QA 独立复核（第二轮）新增的边界探针，永久保留。
     起因：v2.13 的 markGraphChanged 是整个「重启不丢堆」修复的落地动作，
     但沙盒的 app stub 只有 registerExtension（没有 api / rootGraph），
     也就是说**之前没有任何一条断言真正跑过 markGraphChanged 的事件分支**。
     R35 补的就是这块空白：
     ① 改堆真的发出 api 的 graphChanged，payload 是改动后的画布快照
     ② 发事件不污染自身逻辑，也不产生 dispatch→保存→dispatch 死循环
     ③ 新建节点（只 setupNode）不回填 vs 加载节点（onConfigure）回填 的完整时序
     ④ 清空 → 索引同步摘 key；再写回 → key 重新入队
     ⑤ 连弹 3 条 toast：都在 #cft-toast-host 内、容器挂在 body 下
  */
  {
    const e35 = (lora, name, weight) =>
      ({ lora, name, weight, text_encoder_weight: 1, trigger_weight: 0, hidden: false });
    const keyOf35 = (node) => T.LS_PREFIX + T.stackBakKey(node);
    const idxOf35 = () => T.LS.getJSON("stackbak.index", []) || [];
    const guard35 = (fn) => {
      try { return { ok: true, v: fn() }; } catch (err) { return { ok: false, m: err.message }; }
    };

    // 拿到插件 import 的那**同一个** app 实例（同 specifier → 同模块实例，
    // 改它的属性等于改插件眼里看到的 app）。用完必须还原，否则会污染后面的截图模式。
    const appMod = await import("./scripts/app.js");
    const appStub = appMod.app;
    const savedApi = appStub.api;
    const savedRootGraph = appStub.rootGraph;
    const savedGraph = appStub.graph;
    try {

      /* ---------- ① markGraphChanged 真的把事件发出去 ---------- */

      const spy = { custom: [], native: [], serials: 0 };
      const n35 = makeNode(3501, []);
      const fakeRootGraph = {
        serialize() {
          spy.serials++;
          // 用节点 widget 的实时值造"画布快照"，用来验证 payload 是改动**之后**的
          return {
            last_node_id: 3501,
            nodes: [{ id: n35.id, type: "CFTLoraStack", widgets_values: [n35.widgets[0].value] }],
          };
        },
      };
      appStub.rootGraph = fakeRootGraph;
      appStub.api = { dispatchCustomEvent(type, payload) { spy.custom.push({ type, payload }); } };

      T.writeStack(n35, [e35("A/one.safetensors", "one", 1)]);
      check("R35 改堆后确实向 api 发出 graphChanged（不再是空操作）",
        spy.custom.length === 1 && spy.custom[0].type === "graphChanged",
        JSON.stringify(spy.custom.map((c) => c.type)));
      const p35a = spy.custom[0] && spy.custom[0].payload;
      check("R35 事件 payload 是当前画布快照，且含改动后的堆",
        !!p35a && !!p35a.nodes && /A\/one\.safetensors/.test(JSON.stringify(p35a.nodes[0].widgets_values || [])),
        p35a ? JSON.stringify(p35a.nodes[0].widgets_values).slice(0, 90) : "(无 payload)");

      // 再改一次：payload 必须跟着变 —— 证明是实时快照而不是首帧缓存
      T.writeStack(n35, [e35("B/two.safetensors", "two", 0.5)]);
      const p35b = spy.custom[1] && spy.custom[1].payload;
      check("R35 再改一次，payload 跟着更新（实时快照，不是首帧缓存）",
        spy.custom.length === 2 && !!p35b &&
        /B\/two\.safetensors/.test(JSON.stringify(p35b.nodes[0].widgets_values)) &&
        !/A\/one\.safetensors/.test(JSON.stringify(p35b.nodes[0].widgets_values)),
        p35b ? JSON.stringify(p35b.nodes[0].widgets_values).slice(0, 90) : `calls=${spy.custom.length}`);

      /* ---------- ② 不产生 dispatch→保存→dispatch 死循环 ---------- */

      check("R35 一次 writeStack 只发一次事件、只序列化一次（无循环调用）",
        spy.custom.length === 2 && spy.serials === 2,
        `dispatch=${spy.custom.length} serialize=${spy.serials}`);
      n35.widgets[0].value = "[]";   // 模拟重启后工作流里存着空堆
      const rn35 = T.restoreStackFromBackup(n35);
      check("R35 恢复回填也只发一次事件，且真的回填了",
        rn35 === 1 && spy.custom.length === 3 && spy.serials === 3,
        `恢复=${rn35} dispatch=${spy.custom.length} serialize=${spy.serials}`);
      check("R35 发事件后 readStack / 备份 / 恢复结果不受污染（不循环触发）",
        T.readStack(n35).length === 1 && T.readStackBackup(n35).length === 1 &&
        T.restoreStackFromBackup(n35) === 0 && spy.custom.length === 3,
        `堆=${T.readStack(n35).length} 备份=${T.readStackBackup(n35).length} dispatch=${spy.custom.length}`);

      /* ---------- ③ app.api 缺失 / 事件通道抛错时主流程照走 ---------- */

      appStub.api = undefined;
      appStub.rootGraph = undefined;
      const g1 = guard35(() => T.writeStack(n35, [e35("C/three.safetensors", "three", 1)]));
      check("R35 app.api / app.rootGraph 不存在时 writeStack 不抛错，堆照样写进 widget",
        g1.ok && T.readStack(n35).length === 1 && T.readStack(n35)[0].lora === "C/three.safetensors",
        `${g1.ok} ${g1.m || ""} ${T.readStack(n35).map((e) => e.lora).join(",")}`);
      check("R35 事件通道缺失时备份照写（静默降级，不损主功能）",
        T.readStackBackup(n35).length === 1 && T.readStackBackup(n35)[0].lora === "C/three.safetensors",
        T.readStackBackup(n35).map((e) => e.lora).join(","));

      appStub.api = { dispatchEvent(ev) { spy.native.push(ev && ev.type); } };
      T.writeStack(n35, [e35("D/four.safetensors", "four", 1)]);
      check("R35 没有 dispatchCustomEvent 时退回 api.dispatchEvent('graphChanged')",
        spy.native.length === 1 && spy.native[0] === "graphChanged",
        JSON.stringify(spy.native));

      appStub.rootGraph = fakeRootGraph;
      appStub.api = { dispatchCustomEvent() { throw new Error("boom"); } };
      const g2 = guard35(() => T.writeStack(n35, [e35("E/five.safetensors", "five", 1)]));
      check("R35 dispatchCustomEvent 抛错被吞掉，堆与备份仍写成功",
        g2.ok && T.readStack(n35)[0].lora === "E/five.safetensors" &&
        T.readStackBackup(n35)[0].lora === "E/five.safetensors",
        `${g2.ok} ${g2.m || ""}`);

      appStub.api = { dispatchCustomEvent(t, p) { spy.custom.push({ type: t, payload: p }); } };
      appStub.rootGraph = { serialize() { throw new Error("serialize boom"); } };
      const g3 = guard35(() => T.writeStack(n35, [e35("F/six.safetensors", "six", 1)]));
      check("R35 rootGraph.serialize 抛错也被吞掉，主流程不中断",
        g3.ok && T.readStack(n35)[0].lora === "F/six.safetensors", `${g3.ok} ${g3.m || ""}`);
      // serialize 抛错时：payload 降级为 null，但**事件仍要发出去**（3 个监听方
      // 都不读 payload）。此前 payload 作为实参先求值，serialize 一抛连事件都丢。
      check("R35 serialize 抛错时事件仍发出（payload 降级为 null，不再整体丢失）",
        spy.custom.length === 4 &&
        spy.custom[spy.custom.length - 1].type === "graphChanged" &&
        spy.custom[spy.custom.length - 1].payload === null,
        `dispatch=${spy.custom.length} payload=${JSON.stringify(spy.custom[spy.custom.length - 1]?.payload)}`);

      // 还原成"有事件通道"的正常形态，供 ④ 使用
      appStub.api = { dispatchCustomEvent(t, p) { spy.custom.push({ type: t, payload: p }); } };
      appStub.rootGraph = fakeRootGraph;

      /* ---------- ④ 清空 → 索引同步摘 key；再写回 → key 重新入队 ---------- */

      const n35b = makeNode(3502, []);
      T.writeStack(n35b, [e35("A/one.safetensors", "one", 1)]);
      const key35b = T.stackBakKey(n35b);
      const before35 = idxOf35();
      check("R35 写备份后 key 进入索引", before35.includes(key35b), key35b);
      T.writeStack(n35b, []);   // 清空堆
      const after35 = idxOf35();
      check("R35 清空堆后索引不含该 key 且长度减一",
        !after35.includes(key35b) && after35.length === before35.length - 1 &&
        localStorage.getItem(keyOf35(n35b)) === null,
        `before=${before35.length} after=${after35.length} 含旧key=${after35.includes(key35b)}`);
      T.writeStack(n35b, [e35("G/seven.safetensors", "seven", 1)]);   // 再写回
      const back35 = idxOf35();
      check("R35 再写回后 key 重新入队（回到队尾）",
        back35.includes(key35b) && back35[back35.length - 1] === key35b &&
        localStorage.getItem(keyOf35(n35b)) !== null,
        `含key=${back35.includes(key35b)} 队尾=${back35[back35.length - 1]}`);

      /* ---------- ⑤ 新建 vs 加载路径的完整时序 ---------- */

      const n35c = makeNode(3503, []);
      // 先造一份备份（模拟"上一次会话里这个 id 的节点配过堆"）
      T.writeStack(n35c, [e35("A/one.safetensors", "one", 1), e35("B/two.safetensors", "two", 1)]);
      n35c.widgets[0].value = "[]";      // 重启后工作流里存着空堆
      T.setupNode(n35c);                 // ① 只走 setupNode（= 新建节点那条路）
      await tick(140);
      check("R35 新建节点（只 setupNode）不回填备份 —— 防跨工作流串号",
        T.readStack(n35c).length === 0, `当前 ${T.readStack(n35c).length} 条`);

      // ② 再走加载路径（onConfigure = 确实是从工作流里加载出来的）
      const hasHook35 = typeof n35c.onConfigure === "function";
      if (hasHook35) n35c.onConfigure({});
      await tick(160);
      check("R35 加载节点（onConfigure）才回填备份",
        hasHook35 && T.readStack(n35c).length === 2 &&
        T.readStack(n35c)[0].lora === "A/one.safetensors",
        `hook=${hasHook35} 当前 ${T.readStack(n35c).length} 条`);

      // ③ 恢复后再改堆 → 备份同步更新（时序闭环）
      const list35c = T.readStack(n35c);
      list35c[0].weight = 0.42;
      T.writeStack(n35c, list35c);
      const bak35c = T.readStackBackup(n35c);
      check("R35 恢复 → 再改堆 → 备份同步更新（完整时序闭环）",
        bak35c.length === 2 && Math.abs(bak35c[0].weight - 0.42) < 1e-6,
        JSON.stringify(bak35c.map((e) => [e.lora, e.weight])));

      // ④ 扩展的 loadedGraphNode 钩子里也有恢复（与 onConfigure 双保险）
      const ext35 = globalThis.__CFT_EXT__;
      check("R35 扩展同时挂了 loadedGraphNode 恢复钩子（与 onConfigure 双保险）",
        !!ext35 && typeof ext35.loadedGraphNode === "function", "");
      const n35d = makeNode(3504, []);
      T.writeStack(n35d, [e35("H/eight.safetensors", "eight", 1)]);
      n35d.widgets[0].value = "[]";
      T.setupNode(n35d);
      await tick(140);
      check("R35 loadedGraphNode 前：仍未回填（恢复只发生在加载路径上）",
        T.readStack(n35d).length === 0, `当前 ${T.readStack(n35d).length} 条`);
      if (ext35 && typeof ext35.loadedGraphNode === "function") {
        await ext35.loadedGraphNode(n35d);
        await tick(160);
      }
      check("R35 走 loadedGraphNode 后回填成功",
        T.readStack(n35d).length === 1 && T.readStack(n35d)[0].lora === "H/eight.safetensors",
        `当前 ${T.readStack(n35d).map((e) => e.lora).join(",")}`);

      /* ---------- ⑥ toast 堆叠：连弹 3 条 ---------- */

      const host35 = document.getElementById("cft-toast-host");
      const before35t = host35 ? host35.children.length : 0;
      T.globalToast("R35-第一条");
      T.globalToast("R35-第二条");
      T.globalToast("R35-第三条");
      const host35b = document.getElementById("cft-toast-host");
      const all35 = [...document.querySelectorAll(".cft-toast-global")];
      const mine35 = all35.filter((t) => /^R35-/.test(t.textContent || ""));
      check("R35 连弹 3 条 toast 都进了 #cft-toast-host（同一个堆叠容器）",
        !!host35b && mine35.length === 3 && mine35.every((t) => t.parentElement === host35b),
        `命中 ${mine35.length} 条，容器=${host35b ? host35b.id : "(无)"}`);
      check("R35 堆叠容器挂在 body 下（不被弹窗容器裁掉）",
        !!host35b && host35b.parentElement === document.body,
        host35b ? String(host35b.parentElement && host35b.parentElement.tagName) : "");
      check("R35 3 条 toast 是容器的连续子节点（纵向堆叠，互不重叠）",
        !!host35b && host35b.children.length === before35t + 3 &&
        [...host35b.children].slice(-3).every((t) => /^R35-/.test(t.textContent || "")),
        `容器子节点 ${host35b ? host35b.children.length : 0} 条`);

      localStorage.removeItem(keyOf35(n35));
      localStorage.removeItem(keyOf35(n35b));
      localStorage.removeItem(keyOf35(n35c));
      localStorage.removeItem(keyOf35(n35d));
    } finally {
      // 必须还原：截图模式（SHOT）在 main() 之后还会开弹窗、改堆，
      // 留着假 api / 假 rootGraph 会改变后续行为。
      appStub.api = savedApi;
      appStub.rootGraph = savedRootGraph;
      appStub.graph = savedGraph;
    }
  }

  /* ============ R36：节点高度 = 用户拖动，显示条数跟着高度自适应（v2.16） ============
     v2.14 把方向做反了：插件自己算面板高度（封顶 200）、固定只渲染 24 条、
     还按差值去 setSize 改节点高度 —— 结果用户拖高节点，面板一点不涨。
     根因（LiteGraph `_arrangeWidgets` 源码）：`if (w.computeSize)` 是第一分支，
     有 computeSize 的 widget 被当**固定高度**，不参与 distributeSpace 分空间；
     只有走 `computeLayoutSize` 的可伸缩 widget 才会吃掉节点剩余空间。
     所以正确做法是：不给 domWidget 设 computeSize、getMinHeight 只报小常量、
     不设 getMaxHeight，面板内部 flex + overflow。 */
  {
    const e36 = (lora) => ({ lora, name: lora.split("/").pop(), weight: 0.8, text_encoder_weight: 1, trigger_weight: 0 });
    const stackOf = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(e36(`X/lora${i}.safetensors`)); return a; };

    const n36 = makeNode(3601, []);
    T.setupNode(n36);
    await tick(60);
    const panel36 = n36._dom && n36._dom.el;
    const list36 = () => (panel36 ? panel36.querySelector(".cft-np-list") : null);
    const dw36 = n36._dw;

    /* --- ① 布局契约：必须走「可伸缩」分支，否则拖高无效 --- */
    check("R36 domWidget 不再有 computeSize（有它就会被当固定高度）",
      !dw36 || typeof dw36.computeSize !== "function", dw36 ? typeof dw36.computeSize : "(无 widget)");
    check("R36 getMinHeight 只报一个小常量（96），不是算出来的高度",
      !!dw36 && dw36.options.getMinHeight() === 96, dw36 ? String(dw36.options.getMinHeight()) : "(无)");
    check("R36 不设 getMaxHeight（undefined → distributeSpace 按 Infinity 吃满剩余空间）",
      !!dw36 && typeof dw36.options.getMaxHeight !== "function");

    // 新建节点给了个默认高度（约 3 行），之后就该完全由用户控制
    const hDefault = n36.size[1];
    check("R36 新建节点有可用的默认高度（≥150）", hDefault >= 150, String(hDefault));

    /* --- ② 条目数不参与节点高度计算，也不主动 setSize --- */
    const calls0 = n36._setSizeCalls || 0;
    T.writeStack(n36, [e36("A/one.safetensors")]);
    T.refreshNodePanel(n36);
    await tick(30);
    const h1 = n36.size[1];

    T.writeStack(n36, stackOf(30));
    T.refreshNodePanel(n36);
    await tick(30);
    const h30 = n36.size[1];

    check("R36 堆从 1 条变成 30 条，节点高度纹丝不动（高度是用户的输入）",
      h30 === h1, `${h1} → ${h30}`);
    check("R36 刷新面板全程不调 node.setSize（插件不再碰节点高度）",
      (n36._setSizeCalls || 0) === calls0, `setSize 次数 ${calls0} → ${n36._setSizeCalls || 0}`);
    check("R36 30 条时 getMinHeight 仍是那个常量（不随条目数变）",
      dw36.options.getMinHeight() === 96, String(dw36.options.getMinHeight()));

    T.writeStack(n36, [e36("A/one.safetensors"), e36("B/two.safetensors")]);
    T.refreshNodePanel(n36);
    await tick(30);
    check("R36 删条目同样不改节点高度", n36.size[1] === h1, `${h30} → ${n36.size[1]}`);

    /* --- ③ 不再固定截断 24 条，高度决定看到多少 --- */
    T.writeStack(n36, stackOf(30));
    T.refreshNodePanel(n36);
    await tick(30);
    const rows30 = list36() ? list36().querySelectorAll(".cft-np-row").length : 0;
    check("R36 30 条全部渲染（不再固定只显示 24 条）", rows30 === 30, String(rows30));
    check("R36 没有「还有 N 条」的截断提示", !/还有 \d+ 条/.test((list36() || {}).textContent || ""),
      ((list36() || {}).textContent || "").slice(-24));
    check("R36 列表不设内联 max-height（高度交给 flex，不看插件脸色）",
      !!(list36() && !list36().style.maxHeight), list36() ? (list36().style.maxHeight || "(空)") : "(无列表)");

    /* --- ④ 真 Chromium 实测：容器变高 → 列表变高 → 可见行数变多 ---
       host 要按 ComfyUI 真实的 DOM widget wrapper 形状来做：**绝对定位 + 显式高度**
       （DomWidget.vue 里 widgetState.size 给的就是 height），而不是 flex 容器 ——
       用 flex 容器的话 flex-shrink 会替我们压缩面板，把 height:100% 的作用掩盖掉。 */
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:340px;overflow:hidden";
    host.style.height = "200px";
    document.body.appendChild(host);
    host.appendChild(panel36);
    await tick(60);
    const measure = () => {
      const l = list36();
      if (!l) return { listH: 0, rowH: 0, visible: 0, scroll: false };
      const rowH = (l.querySelector(".cft-np-row") || {}).offsetHeight || 26;
      return { listH: l.clientHeight, rowH, visible: Math.floor(l.clientHeight / rowH), scroll: l.scrollHeight > l.clientHeight + 1 };
    };
    const low = measure();

    // 面板 / 列表都必须**不超过容器**：.cft-node-panel 的 height:100% 是整条链路的落点，
    // 少了它面板会退回内容高度（30 行 ≈ 760px），把节点重新顶长。
    const boxH = () => panel36.getBoundingClientRect().height;
    const overflowH = () => {
      const l = list36();
      if (!l) return 0;
      return Math.max(0, l.getBoundingClientRect().bottom - panel36.getBoundingClientRect().bottom);
    };
    check("R36 面板高度被容器约束（height:100% 生效，不会把节点顶长）",
      boxH() <= 201, `panelH=${boxH().toFixed(1)} 容器=200`);
    check("R36 列表不溢出面板底部", overflowH() <= 1, `溢出 ${overflowH().toFixed(1)}px`);
    check("R36 矮的时候要滚动才看得全（内容比可视区高）", low.scroll === true,
      `scrollHeight>clientHeight=${low.scroll}`);

    // 滚到底：第 30 条必须真的能滚出来（不是被截断掉）
    const l36 = list36();
    if (l36) l36.scrollTop = l36.scrollHeight;
    await tick(40);
    const lastRow = l36 ? l36.querySelectorAll(".cft-np-row")[29] : null;
    const inView = (() => {
      if (!lastRow || !l36) return false;
      const rr = lastRow.getBoundingClientRect();
      const cr = l36.getBoundingClientRect();
      return rr.bottom <= cr.bottom + 2 && rr.top >= cr.top - 2;
    })();
    check("R36 滚到底能看到第 30 条（全部可访问，不是只渲染 24 条）",
      !!lastRow && inView, lastRow ? `inView=${inView}` : "(没有第 30 行)");

    host.style.height = "560px";
    await tick(80);
    const high = measure();

    check("R36 容器（≈节点）变高后列表跟着变高", high.listH > low.listH + 150, `${low.listH} → ${high.listH}`);
    check("R36 可见行数随高度增加（这就是「显示数量自适应」）",
      high.visible > low.visible, `${low.visible} 行 → ${high.visible} 行（行高 ${high.rowH}）`);
    check("R36 矮的时候出滚动条，高的地方能看到更多", low.scroll === true && high.visible >= 10,
      `矮: scroll=${low.scroll} 可见=${low.visible} | 高: 可见=${high.visible}`);
    // 极矮：必须能缩到下限而不撑破
    host.style.height = "70px";
    await tick(60);
    const tiny = measure();
    check("R36 拖到极矮时列表被压扁但不溢出（min-height:0 生效）",
      tiny.listH <= 70 && tiny.scroll === true, `listH=${tiny.listH} scroll=${tiny.scroll}`);

    host.style.height = "200px";
    await tick(40);
    host.remove();

    // 清空堆：走空状态分支，不报错
    T.writeStack(n36, []);
    T.refreshNodePanel(n36);
    await tick(30);
    check("R36 清空堆后渲染空状态且高度仍不变",
      !!panel36.querySelector(".cft-np-empty") && n36.size[1] === h1,
      `${n36.size[1]} vs ${h1}`);
  }

  /* ============ R37：v2.15 单例（详情窗按 lora / 堆窗口按节点）+ 点击语义 ============ */
  {
    // 清掉前面留下的详情窗，让计数从 0 开始
    for (const k of [...T.OPEN_MODALS.keys()]) {
      if (k.startsWith("detail:")) T.OPEN_MODALS.get(k)?.close();
    }
    await tick(60);
    FAKE.samples = false;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const nDetail = () => document.querySelectorAll(".cft-detail-modal").length;

    /* --- 1) 同一个 lora：只开一个详情窗 --------------------------------- */
    const dA1 = T.openDetailModal("A/one.safetensors", () => {});
    await tick(80);
    const dA2 = T.openDetailModal("A/one.safetensors", () => {});
    await tick(80);
    check("R37 同一 lora 二次打开返回同一实例", dA1 === dA2, "");
    check("R37 同一 lora 只有 1 个详情窗（不叠窗）", nDetail() === 1, String(nDetail()));
    check("R37 详情窗按 lora 登记在 OPEN_MODALS", T.OPEN_MODALS.get("detail:A/one.safetensors") === dA1, "");

    // 就算有人绕过入口直接 new，也必须顶掉旧窗（singletonKey 写在构造函数里）
    const dA3 = new T.DetailModal("A/one.safetensors", () => {});
    dA3.open();
    await tick(80);
    check("R37 直接 new（绕过入口）也会顶掉旧窗，不并存两个", nDetail() === 1 && T.OPEN_MODALS.get("detail:A/one.safetensors") === dA3, `窗=${nDetail()}`);

    /* --- 2) 不同 lora：各开各的，可以同时看 ------------------------------ */
    const dB1 = T.openDetailModal("B/two.safetensors", () => {});
    await tick(80);
    check("R37 不同 lora 能同时开 2 个详情窗", dB1 !== dA3 && nDetail() === 2, `窗=${nDetail()}`);
    check("R37 两个窗口各绑自己的 lora", dA3.loraName === "A/one.safetensors" && dB1.loraName === "B/two.safetensors", `${dA3.loraName} | ${dB1.loraName}`);
    dA3.close();
    await tick(60);
    check("R37 关掉 A 的详情窗不影响 B 的", nDetail() === 1 && dB1._opened === true, `窗=${nDetail()}`);
    dB1.close();
    await tick(60);
    check("R37 全关后详情窗计数归零", nDetail() === 0, String(nDetail()));
    const dA4 = T.openDetailModal("A/one.safetensors", () => {});
    await tick(80);
    check("R37 关掉之后再开是新实例（不复用已关的）", dA4 !== dA3 && nDetail() === 1, "");
    dA4.close();
    await tick(60);

    /* --- 2b) 同一详情窗被多个父窗口打开时，回调要全部保留 ---------------- */
    const hits = [];
    const dM1 = T.openDetailModal("B/two.safetensors", () => hits.push("picker"));
    await tick(80);
    const dM2 = T.openDetailModal("B/two.safetensors", () => hits.push("stackwindow"));
    await tick(60);
    check("R37 复用详情窗是同一实例", dM1 === dM2 && nDetail() === 1, `窗=${nDetail()}`);
    await dM1.onChange();
    check("R37 两个父窗口的回调都会被执行（不会只留最后一个）", hits.includes("picker") && hits.includes("stackwindow"), hits.join(","));
    dM1.close();
    await tick(60);

    /* --- 3) 选择器：只有封面图 / ⓘ 开详情，其余位置是「选中」 ------------ */
    const nodeS = makeNode(161, []);
    const pkS = new T.PickerModal(nodeS, () => {});
    pkS.open();
    await tick(160);
    const KEY = "A/one.safetensors";
    const itemS = { lora: KEY, name: "one", display_name: "One", base_model: "SD 1.5", size_mb: 12, tags: ["x"], user_tags: ["mine"] };
    const wrapS = pkS.buildCard(itemS);
    document.body.appendChild(wrapS);
    await tick(30);
    const isSel = () => pkS.selected.has(KEY);

    check("R37 造出的测试卡片初始未选中", isSel() === false, String(isSel()));
    wrapS.querySelector(".cft-card-title").click();
    await tick(40);
    check("R37 点标题 = 选中（不弹详情）", isSel() === true && nDetail() === 0, `选中=${isSel()} 详情窗=${nDetail()}`);
    wrapS.querySelector(".cft-card-title").click();
    await tick(40);
    check("R37 再点标题 = 取消选中（不弹详情）", isSel() === false && nDetail() === 0, `选中=${isSel()} 详情窗=${nDetail()}`);
    wrapS.querySelector(".cft-card-sub").click();
    await tick(40);
    check("R37 点副标题 = 选中（不弹详情）", isSel() === true && nDetail() === 0, `选中=${isSel()} 详情窗=${nDetail()}`);
    wrapS.querySelector(".cft-card-tags").click();
    await tick(40);
    check("R37 点标签行 = 取消选中（不弹详情）", isSel() === false && nDetail() === 0, `选中=${isSel()} 详情窗=${nDetail()}`);
    wrapS.querySelector(".cft-card-meta").click();
    await tick(40);
    check("R37 点徽标行 = 选中（不弹详情）", isSel() === true && nDetail() === 0, `选中=${isSel()} 详情窗=${nDetail()}`);

    // 封面图：开详情，且不该顺带把选中态切了
    const selBeforeImg = isSel();
    wrapS.querySelector(".cft-card-img").click();
    await tick(120);
    check("R37 点封面图 = 打开详情", nDetail() === 1, `窗=${nDetail()}`);
    check("R37 点封面图不会顺带切换选中态", isSel() === selBeforeImg, `${selBeforeImg} → ${isSel()}`);
    for (const k of [...T.OPEN_MODALS.keys()]) if (k.startsWith("detail:")) T.OPEN_MODALS.get(k)?.close();
    await tick(60);

    // ⓘ：同样开详情
    wrapS.querySelector(".cft-card-info").click();
    await tick(120);
    check("R37 点 ⓘ = 打开详情", nDetail() === 1, `窗=${nDetail()}`);
    check("R37 点 ⓘ 也不会切换选中态", isSel() === selBeforeImg, `${selBeforeImg} → ${isSel()}`);
    for (const k of [...T.OPEN_MODALS.keys()]) if (k.startsWith("detail:")) T.OPEN_MODALS.get(k)?.close();
    await tick(60);

    // 列表视图：名称 = 选中，ⓘ = 详情
    const rowS = pkS.buildListRow({ lora: "C/three.safetensors", name: "three", display_name: "Three", size_mb: 8 });
    document.body.appendChild(rowS);
    await tick(30);
    rowS.querySelector(".cft-list-name").click();
    await tick(40);
    check("R37 列表视图点名称 = 选中（不弹详情）", pkS.selected.has("C/three.safetensors") && nDetail() === 0, `详情窗=${nDetail()}`);
    rowS.querySelector(".cft-card-info").click();
    await tick(120);
    check("R37 列表视图点 ⓘ = 打开详情", nDetail() === 1, `窗=${nDetail()}`);
    for (const k of [...T.OPEN_MODALS.keys()]) if (k.startsWith("detail:")) T.OPEN_MODALS.get(k)?.close();
    await tick(60);

    wrapS.remove();
    rowS.remove();
    pkS.close();
    await tick(40);

    /* --- 4) 堆窗口 / 节点面板：没有「选中」概念，名字仍可开详情 -------- */
    const nodeM = makeNode(162, [{ lora: "A/one.safetensors", name: "one", display_name: "One", weight: 1 }]);
    const smM = new T.StackManagerModal(nodeM);
    smM.open();
    await tick(140);
    const nameM = smM.body.querySelector(".cft-name");
    check("R37 堆窗口有行名可点", !!nameM, nameM ? nameM.textContent : "null");
    if (nameM) nameM.click();
    await tick(140);
    check("R37 堆窗口点名字仍能开详情（那里没有选中概念）", nDetail() === 1, `窗=${nDetail()}`);
    for (const k of [...T.OPEN_MODALS.keys()]) if (k.startsWith("detail:")) T.OPEN_MODALS.get(k)?.close();
    await tick(60);
    smM.close();
    await tick(40);
  }

  /* ============ R38：v2.18 卡片自定义标签上限 5、超出折叠成「+N」 ============ */
  {
    FAKE.samples = false;
    FAKE.extra = false;
    FAKE.user = { tags: [], note: "", cover: null };
    FAKE.userName = "";
    T.META_CACHE.clear();
    T.Store.invalidate();

    const nodeT = makeNode(163, []);
    const pkT = new T.PickerModal(nodeT, () => {});
    pkT.open();
    await tick(160);

    // 7 个自定义标签 → 卡片上只出现 5 个 + 一个「+2」折叠芯片
    const item7 = {
      lora: "T/seven.safetensors", name: "seven", display_name: "Seven", base_model: "SD 1.5", size_mb: 3,
      tags: ["c1", "c2", "c3", "c4", "c5", "c6"],
      trained_words: ["w1", "w2", "w3"],
      user_tags: ["u1", "u2", "u3", "u4", "u5", "u6", "u7"],
    };
    const wrap7 = pkT.buildCard(item7);
    document.body.appendChild(wrap7);
    await tick(30);
    const visibleUser = wrap7.querySelectorAll(".cft-card-tags .cft-tag-user:not(.cft-tag-more)");
    const moreChip = wrap7.querySelector(".cft-card-tags .cft-tag-more");
    check("R38 7 个自定义标签卡片上只显示 5 个", visibleUser.length === 5, String(visibleUser.length));
    check("R38 超出部分折叠成「+2」芯片", !!moreChip && moreChip.textContent === "+2", moreChip ? moreChip.textContent : "null");
    check("R38 悬停 +N 芯片能看到其余标签完整列表",
      !!moreChip && (moreChip.title || "").includes("u6") && (moreChip.title || "").includes("u7"),
      moreChip ? moreChip.title : "null");
    // C 站标签 / 触发词的上限保持不变（3 / 2）
    const civitaiTags = wrap7.querySelectorAll(".cft-card-tags .cft-tag:not(.cft-tag-user):not(.cft-tag-word)");
    const wordTags = wrap7.querySelectorAll(".cft-card-tags .cft-tag-word");
    check("R38 C 站标签仍最多 3 个", civitaiTags.length === 3, String(civitaiTags.length));
    check("R38 触发词仍最多 2 个", wordTags.length === 2, String(wordTags.length));
    wrap7.remove();

    // ≤5 个自定义标签：不出现 +N 芯片
    const item3 = { lora: "T/three_u.safetensors", name: "three_u", display_name: "T3", size_mb: 2, user_tags: ["a", "b", "c"] };
    const wrap3 = pkT.buildCard(item3);
    document.body.appendChild(wrap3);
    await tick(30);
    check("R38 ≤5 个自定义标签不出现 +N 芯片",
      wrap3.querySelectorAll(".cft-card-tags .cft-tag-user").length === 3 && !wrap3.querySelector(".cft-tag-more"), "");
    wrap3.remove();

    pkT.close();
    await tick(40);
  }

  /* ============================ R40：v2.21 设置按钮 + v2.22 语言切换 ============================ */
  {
    // 先清掉前面可能残留的浮窗，保证干净环境
    for (const m of T.OPEN_MODALS.values()) { try { m.close(); } catch (e) {} }
    document.querySelectorAll(".cft-stack-modal,.cft-picker-modal,.cft-settings-modal,.cft-detail-modal,.cft-cleanup-modal,.cft-trash-modal,.cft-lightbox").forEach((el) => el.remove());

    // (1) T() 翻译函数：中文回落 + 英文切换 + 占位符
    T.setLang("zh");
    check("R40 T() 中文默认回落", T.T("设置") === "设置", T.T("设置"));
    check("R40 T() 占位符中文", T.T("副本 {0}/{1}", 2, 3) === "副本 2/3", T.T("副本 {0}/{1}", 2, 3));
    T.setLang("en");
    check("R40 T() 切到英文", T.T("设置") === "Settings", T.T("设置"));
    check("R40 T() 占位符英文", T.T("副本 {0}/{1}", 2, 3) === "Copy 2/3", T.T("副本 {0}/{1}", 2, 3));
    check("R40 T() 未译回落中文", T.T("这是一个不存在的键测试") === "这是一个不存在的键测试", T.T("这是一个不存在的键测试"));
    T.setLang("zh");

    // (2) 设置按钮出现在「堆窗口」header（v2.21 放置点）
    const sm = T.openStackManager(nodeA);
    await tick(60);
    const smEl = document.querySelector(".cft-stack-modal");
    const smSetBtn = smEl && [...smEl.querySelectorAll(".cft-settings-btn")].find((b) => (b.textContent || "").includes("⚙"));
    check("R40 堆窗口 header 含设置按钮（⚙）", !!smSetBtn, smEl ? smEl.querySelectorAll(".cft-settings-btn").length + " 个" : "no modal");
    sm.close();
    await tick(30);

    // (3) 设置弹窗内的语言行 + 中/英切换（点按钮即时重渲染）
    T.openSettings();
    await tick(80);
    const setEl = document.querySelector(".cft-settings-modal");
    check("R40 设置弹窗已打开", !!setEl);
    const langRow = setEl && setEl.querySelector(".cft-settings-langrow");
    check("R40 设置弹窗含语言行", !!langRow);
    const zhBtn = langRow && [...langRow.querySelectorAll("button")].find((b) => (b.textContent || "").includes("中文"));
    const enBtn = langRow && [...langRow.querySelectorAll("button")].find((b) => (b.textContent || "").includes("English"));
    check("R40 语言行含「中文」「English」按钮", !!zhBtn && !!enBtn);
    const titleEl = setEl && setEl.querySelector(".cft-title");
    check("R40 设置标题默认中文", titleEl && titleEl.textContent === "设置", titleEl ? titleEl.textContent : "n/a");
    // 点 English → 切到英文，重渲染后标题应变为 Settings
    if (enBtn) { enBtn.click(); await tick(80); }
    check("R40 点 English 后 getLang=en", T.getLang() === "en", T.getLang());
    const titleEn = document.querySelector(".cft-settings-modal .cft-title");
    check("R40 切英文后标题=Settings", titleEn && titleEn.textContent === "Settings", titleEn ? titleEn.textContent : "n/a");
    // 点回中文
    const langRow2 = document.querySelector(".cft-settings-modal .cft-settings-langrow");
    const zhBtn2 = langRow2 && [...langRow2.querySelectorAll("button")].find((b) => (b.textContent || "").includes("中文"));
    if (zhBtn2) { zhBtn2.click(); await tick(80); }
    check("R40 点回中文后 getLang=zh", T.getLang() === "zh", T.getLang());
    // 收尾：关掉设置弹窗
    T.OPEN_MODALS.get("cft-settings")?.close();
    await tick(20);
  }

  /* ============================ R41：v2.23 节点插槽名显示翻译 ============================ */
  {
    check("R41 applySocketLabels 已导出", typeof T.applySocketLabels === "function");
    const mk = () => ({
      comfyClass: "CFTLoraStack",
      title: "CFT Lora堆",
      inputs: [{ name: "model" }, { name: "clip" }, { name: "reset_cache" }],
      outputs: [{ name: "CLIP" }, { name: "MODEL" }, { name: "触发词" }],
      widgets: [{ name: "reset_cache" }],
    });
    // 非 CFT 节点直接跳过，一个 label 都不碰
    const stranger = { comfyClass: "KSampler", inputs: [{ name: "model" }], outputs: [], widgets: [] };
    check("R41 非 CFT 节点不动", T.applySocketLabels(stranger) === false);
    // —— 中文模式 ——
    T.setLang("zh");
    const n1 = mk();
    check("R41 中文模式有改动", T.applySocketLabels(n1) === true);
    check("R41 zh 输入 model→模型", n1.inputs[0].label === "模型", n1.inputs[0].label);
    check("R41 zh 输入 clip→CLIP（专名保留）", n1.inputs[1].label === "CLIP", n1.inputs[1].label);
    check("R41 zh 输出 MODEL→模型", n1.outputs[1].label === "模型", n1.outputs[1].label);
    check("R41 zh 输出 触发词 保持", n1.outputs[2].label === "触发词", n1.outputs[2].label);
    check("R41 zh 参数 reset_cache→重置缓存", n1.widgets[0].label === "重置缓存", n1.widgets[0].label);
    check("R41 zh 旧默认标题升级为新名", n1.title === "CLR - LoRA 加载器", n1.title);
    // 功能名（name）绝不能被改 —— 序列化 / 连线 / 后端 kwargs 全靠它
    check("R41 功能名未被改", n1.inputs[0].name === "model" && n1.outputs[1].name === "MODEL" && n1.widgets[0].name === "reset_cache");
    // —— 英文模式 ——
    T.setLang("en");
    const n2 = mk();
    T.applySocketLabels(n2);
    check("R41 en 输入 model 保持英文", n2.inputs[0].label === "model", n2.inputs[0].label);
    check("R41 en 输出 MODEL 保持英文", n2.outputs[1].label === "MODEL", n2.outputs[1].label);
    check("R41 en 输出 触发词→Trigger Words", n2.outputs[2].label === "Trigger Words", n2.outputs[2].label);
    check("R41 en 标题→Civitai LoRA Rack (CLR)", n2.title === "Civitai LoRA Rack (CLR)", n2.title);
    // 重复调用幂等（en 下第二次应无改动）—— 必须在 n2 仍是 en 时测
    check("R41 重复调用幂等", T.applySocketLabels(n2) === false);
    // 旧版后端 RETURN_NAMES 的「模型」也能匹配（在 zh 下，免重启兼容旧运行中的 ComfyUI）
    T.setLang("zh");
    const n3 = { comfyClass: "CFTLoraStack", inputs: [], outputs: [{ name: "模型" }], widgets: [] };
    T.applySocketLabels(n3);
    check("R41 旧版输出名「模型」也覆盖", n3.outputs[0].label === "模型", n3.outputs[0].label);
    // —— 单条加载器节点（zh）——
    const n4 = { comfyClass: "CFTLoraLoader", title: "CFT Lora加载器", inputs: [{ name: "model" }], outputs: [{ name: "CLIP" }], widgets: [{ name: "strength_model" }] };
    T.applySocketLabels(n4);
    check("R41 加载器 zh model→模型", n4.inputs[0].label === "模型", n4.inputs[0].label);
    check("R41 加载器 zh strength_model→模型强度", n4.widgets[0].label === "模型强度", n4.widgets[0].label);
    check("R41 CLS 标题升级（旧名 CFT Lora加载器）", n4.title === "CLS - 单条 LoRA 加载", n4.title);
    // 用户自己改过的标题绝不被覆盖
    const n5 = mk();
    n5.title = "我的堆";
    T.applySocketLabels(n5);
    check("R41 自定义标题不被覆盖", n5.title === "我的堆", n5.title);
    // v2.31 改名：CLR / CLS，旧默认名进白名单以接管旧工作流里的标题
    check("R41 CLR 标题映射", T.NODE_TITLES.CFTLoraStack.zh === "CLR - LoRA 加载器" && T.NODE_TITLES.CFTLoraStack.en === "Civitai LoRA Rack (CLR)");
    check("R41 CLS 标题映射", T.NODE_TITLES.CFTLoraLoader.zh === "CLS - 单条 LoRA 加载" && T.NODE_TITLES.CFTLoraLoader.en === "Civitai LoRA Slot (CLS)");
    check(
      "R41 旧默认名进白名单（旧工作流不残留老标题）",
      (T.LEGACY_NODE_TITLES.CFTLoraStack || []).includes("CFT Lora堆") &&
        (T.LEGACY_NODE_TITLES.CFTLoraStack || []).includes("CFT Lora Stack") &&
        (T.LEGACY_NODE_TITLES.CFTLoraLoader || []).includes("CFT Lora加载器")
    );
    // —— 切换语言重刷（n2 当前仍是 en，切 zh 应重刷）——
    T.setLang("zh");
    const changed = T.applySocketLabels(n2);
    check("R41 切到中文重刷 label", changed === true && n2.outputs[2].label === "触发词", n2.outputs[2].label);
    check("R41 切到中文标题还原", n2.title === "CLR - LoRA 加载器", n2.title);
    // 再切回英文重刷
    T.setLang("en");
    const c2 = T.applySocketLabels(n2);
    check("R41 切回英文重刷 label", c2 === true && n2.outputs[2].label === "Trigger Words", n2.outputs[2].label);
    // 客户端按钮 widget（「🎴 打开 LoRA 堆」）：跟着 _cftI18nKey 换语言
    T.setLang("en");
    const nb = { comfyClass: "CFTLoraStack", inputs: [], outputs: [], widgets: [{ name: "🎴 打开 LoRA 堆", _cftI18nKey: "🎴 打开 LoRA 堆" }] };
    T.applySocketLabels(nb);
    check("R41 按钮 widget 切英文生效", nb.widgets[0].name === T.T("🎴 打开 LoRA 堆") && nb.widgets[0].label === T.T("🎴 打开 LoRA 堆"), nb.widgets[0].name);
    T.setLang("zh");
    check("R41 按钮 widget 切回中文", T.applySocketLabels(nb) && nb.widgets[0].name === "🎴 打开 LoRA 堆", nb.widgets[0].name);
    T.setLang("zh"); // 保证后续轮次语言状态干净
  }

  /* ============================ R42：v2.23 设置面板分组排版 ============================ */
  {
    T.setLang("zh");
    T.openSettings();
    await tick(120);
    const se = document.querySelector(".cft-settings-modal");
    const sections = se ? [...se.querySelectorAll(".cft-settings-section")] : [];
    check("R42 设置面板为分组卡片结构", sections.length >= 2, sections.length + " 张");
    const t0 = sections[0]?.querySelector(".cft-settings-section-title");
    check("R42 第一组标题=语言", t0 && t0.textContent === "语言", t0 ? t0.textContent : "n/a");
    const t1 = sections[1]?.querySelector(".cft-settings-section-title");
    check("R42 第二组标题含 C 站 API Key", t1 && (t1.textContent || "").includes("C 站 API Key"), t1 ? t1.textContent : "n/a");
    check("R42 语言行嵌在分组卡片内", !!(sections[0] && sections[0].querySelector(".cft-settings-langrow")));
    check("R42 语言行不再重复放「语言」小标签", !(sections[0] && sections[0].querySelector(".cft-settings-langlabel")));
    // 切英文：分组标题同步，布局结构不变
    T.setLang("en");
    await tick(100);
    const se2 = document.querySelector(".cft-settings-modal");
    const s0e = se2?.querySelector(".cft-settings-section .cft-settings-section-title");
    check("R42 切英文后第一组标题=Language", s0e && s0e.textContent === "Language", s0e ? s0e.textContent : "n/a");
    const allTitles = se2 ? [...se2.querySelectorAll(".cft-settings-section-title")].map((el) => el.textContent) : [];
    check("R42 切英文后第二组标题=Civitai API Key", allTitles[1] === "Civitai API Key", allTitles[1] || "n/a");
    const descEn = se2?.querySelector(".cft-settings-section-desc");
    check("R42 切英文后语言说明不再中文", !!descEn && /language/i.test(descEn.textContent || ""), descEn ? descEn.textContent : "n/a");
    T.setLang("zh");
    await tick(80);
    T.OPEN_MODALS.get("cft-settings")?.close();
    await tick(20);
  }

  /* ============================ R43：v2.26 空白保存不覆盖 Key + 显式清除 ============================ */
  {
    const prevHandler = globalThis.__CFT_HANDLE__;
    let setCalls = [];
    let hasKey = true; // 假装已存过 Key
    globalThis.__CFT_HANDLE__ = async (url, opts) => {
      if (url.includes("/cft_lora/config/set")) {
        let body = {};
        try { body = JSON.parse((opts && opts.body) || "{}"); } catch { body = {}; }
        setCalls.push(body);
        hasKey = Boolean(String(body.api_key || "").trim());
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { has_api_key: hasKey, api_key_masked: hasKey ? "sk-…abcd" : "" } }) };
      }
      if (url.includes("/cft_lora/config")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, data: { has_api_key: hasKey, api_key_masked: hasKey ? "sk-…abcd" : "" } }) };
      }
      return prevHandler ? prevHandler(url, opts) : { ok: false, status: 404, json: async () => ({ ok: false }) };
    };

    T.setLang("zh");
    T.openSettings();
    await tick(160);
    const sm = document.querySelector(".cft-settings-modal");
    const clearBtn = sm && sm.querySelector(".cft-settings-clear");
    const clearRow = clearBtn && clearBtn.closest(".cft-settings-dangerrow");
    check("R43 有 Key 时「清除 API Key」可见", !!clearBtn && !!clearRow && getComputedStyle(clearRow).display !== "none");
    check("R43 有 Key 时占位提示改为「留空不会改动」", !!sm && /留空不会改动/.test(sm.querySelector(".cft-settings-input")?.placeholder || ""), sm?.querySelector(".cft-settings-input")?.placeholder);

    // ① 输入框留空直接点保存 → 绝不能调用 /config/set
    setCalls = [];
    const saveBtn = sm && [...sm.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === T.T("保存"));
    check("R43 找到保存按钮", !!saveBtn);
    // v2.30：保存/验证从 footer 移进 API 卡片
    check(
      "R43 保存按钮位于 API 卡片内",
      !!saveBtn && !!saveBtn.closest(".cft-settings-apibtnrow") && !!saveBtn.closest(".cft-settings-modal .cft-settings-section")
    );
    if (saveBtn) saveBtn.click();
    await tick(140);
    check("R43 空白保存不写配置（不覆盖已存 Key）", setCalls.length === 0, JSON.stringify(setCalls));

    // ② 点「清除 API Key」→ 二次确认 → 才写入空串
    if (clearBtn) clearBtn.click();
    await tick(140);
    const askModal = document.querySelector(".cft-ask-modal");
    const okBtn = askModal && [...askModal.querySelectorAll(".cft-footer button")].find((b) => (b.textContent || "").trim() === T.T("清除"));
    check("R43 清除前有二次确认", !!okBtn);
    if (okBtn) okBtn.click();
    await tick(200);
    check("R43 确认后写入空 Key", setCalls.length === 1 && setCalls[0].api_key === "", JSON.stringify(setCalls));

    // ③ 清掉之后「清除」按钮应隐藏
    const clearRow2 = document.querySelector(".cft-settings-modal .cft-settings-dangerrow");
    check("R43 清除后按钮隐藏", !!clearRow2 && getComputedStyle(clearRow2).display === "none");

    T.OPEN_MODALS.get("cft-settings")?.close();
    await tick(30);
    globalThis.__CFT_HANDLE__ = prevHandler;
  }

  /* ==================== R44：v2.30 设置面板精简 ====================
   * ① 删掉「工作流标签栏」应急分组（根因已在插件侧修好）
   * ② 「验证 / 保存」从弹窗 footer 移进 API 卡片内部
   */
  {
    const setCalls = [];
    const fakeStore = { openWorkflows: [], get activeWorkflow() { return null; } };
    const fakeSetting = { async set(k, v) { setCalls.push([k, v]); }, get() { return true; } };
    T.app.extensionManager = { workflow: fakeStore, setting: fakeSetting };

    T.setLang("zh");
    T.openSettings();
    await tick(180);
    const se = document.querySelector(".cft-settings-modal");
    const sections = se ? [...se.querySelectorAll(".cft-settings-section")] : [];
    const titleOf = (s) => (s.querySelector(".cft-settings-section-title")?.textContent || "").trim();
    const titles = sections.map(titleOf);

    check("R44 设置只剩两组（语言 / C 站 API Key）", sections.length === 2, JSON.stringify(titles));
    check("R44 不再出现「工作流标签栏」分组", !titles.includes("工作流标签栏"), JSON.stringify(titles));

    const apiSec = sections.find((s) => titleOf(s) === "C 站 API Key");
    check("R44 找到 API 卡片", !!apiSec);

    const apiBtnRow = apiSec?.querySelector(".cft-settings-apibtnrow");
    const apiBtns = apiBtnRow ? [...apiBtnRow.querySelectorAll(".cft-btn")].map((b) => (b.textContent || "").trim()) : [];
    check(
      "R44 「验证 / 保存」已在 API 卡片内",
      JSON.stringify(apiBtns) === JSON.stringify(["验证", "保存"]),
      JSON.stringify(apiBtns)
    );
    check(
      "R44 按钮行属于卡片、不在 footer",
      !!apiSec && !!apiBtnRow && apiSec.contains(apiBtnRow) && !apiBtnRow.closest(".cft-footer")
    );

    const footerEl = se?.querySelector(".cft-footer");
    check(
      "R44 弹窗 footer 已隐藏且无按钮",
      !!footerEl && getComputedStyle(footerEl).display === "none" && footerEl.querySelectorAll("button").length === 0,
      footerEl ? `display=${getComputedStyle(footerEl).display}, btns=${footerEl.querySelectorAll("button").length}` : "n/a"
    );

    // 英文：整块文案跟随语言（防再次「英文模式残留中文」）
    T.setLang("en");
    await tick(160);
    const seEn = document.querySelector(".cft-settings-modal");
    const secEn = seEn ? [...seEn.querySelectorAll(".cft-settings-section")] : [];
    const titlesEn = secEn.map(titleOf);
    check(
      "R44 英文下仍是两组且无 tab bar 分组",
      secEn.length === 2 && !titlesEn.includes("Workflow tab bar"),
      JSON.stringify(titlesEn)
    );
    const btnsEn = secEn[1]
      ? [...secEn[1].querySelectorAll(".cft-settings-apibtnrow .cft-btn")].map((b) => (b.textContent || "").trim())
      : [];
    check("R44 英文下按钮已翻译", JSON.stringify(btnsEn) === JSON.stringify(["Verify", "Save"]), JSON.stringify(btnsEn));
    T.setLang("zh");
    await tick(120);


    T.OPEN_MODALS.get("cft-settings")?.close();
    await tick(30);

    // 纯函数：临时工作流判定（UI 虽已移除，能力仍保留给「× 兜底关闭」复用）
    const wfTemp = { path: "workflows/Unsaved Workflow (2).json", get isTemporary() { return true; } };
    const wfKept = { path: "workflows/局部重绘.json", get isTemporary() { return false; } };
    check(
      "R44 临时工作流判定（isTemporary / Unsaved Workflow 路径）",
      T.cftIsTemporaryWorkflow(wfTemp) === true &&
        T.cftIsTemporaryWorkflow({ path: "workflows/Unsaved Workflow.json" }) === true &&
        T.cftIsTemporaryWorkflow(wfKept) === false &&
        T.cftIsTemporaryWorkflow(null) === false
    );

    // 清草稿刷新：关 Persist + 打标记（delay 拉长，避免测试中途真的刷新）
    setCalls.length = 0;
    await T.cftReloadWithoutDrafts(600000);
    check(
      "R44 清草稿刷新会先关掉草稿持久化",
      setCalls.some(([k, v]) => k === "Comfy.Workflow.Persist" && v === false),
      JSON.stringify(setCalls)
    );
    check("R44 清草稿刷新会写恢复标记", localStorage.getItem(T.CFT_PERSIST_RESTORE_KEY) === "1");

    // 下次启动把开关打开回来，并清掉标记
    setCalls.length = 0;
    T.cftRestorePersistSetting();
    check(
      "R44 刷新后自动恢复草稿持久化",
      setCalls.some(([k, v]) => k === "Comfy.Workflow.Persist" && v === true),
      JSON.stringify(setCalls)
    );
    check("R44 恢复后标记被清掉", !localStorage.getItem(T.CFT_PERSIST_RESTORE_KEY));

    delete T.app.extensionManager;
  }

  /* ==================== R45：v2.28 标签 × 点了没反应 → 自动兜底关闭 ==================== */
  {
    const closed = [];
    const wfKeep = {
      path: "workflows/keep.json",
      get isTemporary() { return false; },
      isLoaded: true,
      activeState: { nodes: [], links: [] },
      unload() {},
    };
    const wfStray = {
      path: "workflows/Unsaved Workflow (9).json",
      get isTemporary() { return true; },
      isLoaded: true,
      activeState: { nodes: [], links: [] },
    };
    const store = {
      openWorkflows: [wfKeep, wfStray],
      get activeWorkflow() { return wfKeep; },
      async closeWorkflow(w) {
        closed.push(w.path);
        store.openWorkflows = store.openWorkflows.filter((x) => x !== w);
      },
    };
    T.app.extensionManager = { workflow: store, setting: { async set() {}, get() { return true; } } };
    globalThis.__CFT_TAB_GUARD_DELAYS__ = [120, 260];
    T.cftInstallTabCloseGuard();

    const wrap = document.createElement("div");
    wrap.innerHTML =
      '<div class="workflow-tab" data-testid="workflow-tab" data-workflow-path="workflows/Unsaved Workflow (9).json">' +
      '<span class="workflow-label">Unsaved Workflow (9)</span>' +
      '<button class="close-button" aria-label="关闭"></button></div>';
    document.body.appendChild(wrap);
    const btn = wrap.querySelector("button.close-button");

    // ① 前端不处理这次点击（模拟"点了没反应"）→ 兜底应当补刀
    if (btn) btn.click();
    await tick(60);
    check("R45 兜底有延迟，不打断正常关闭", closed.length === 0, JSON.stringify(closed));
    await tick(180);
    check(
      "R45 × 没生效时自动强制关闭该标签",
      closed.length === 1 && closed[0].includes("Unsaved Workflow (9)"),
      JSON.stringify(closed)
    );

    // ② 有原生确认框在等用户回答时，绝不能代答
    closed.length = 0;
    store.openWorkflows = [wfKeep, wfStray];
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    dlg.style.cssText = "position:fixed;left:20px;top:20px;width:240px;height:140px;";
    dlg.textContent = "未保存，确定关闭？";
    document.body.appendChild(dlg);
    check("R45 能识别到原生确认框", T.cftOverlayBusy() === true);
    if (btn) btn.click();
    await tick(320);
    check("R45 确认框在时不抢答", closed.length === 0, JSON.stringify(closed));

    // ③ 用户点了「取消」把框关掉后，兜底也不能补刀（他已经在做选择了）
    closed.length = 0;
    store.openWorkflows = [wfKeep, wfStray];
    if (btn) btn.click();           // 第 1 次检查时框还在 → 记为「见过对话框」
    await tick(150);
    dlg.remove();                   // 用户取消，框消失
    await tick(250);
    check("R45 见过确认框后（哪怕被取消）不再兜底", closed.length === 0, JSON.stringify(closed));

    dlg.remove();
    check("R45 插件自己的窗口不算原生对话框", (() => {
      const m = document.createElement("div");
      m.className = "cft-modal";
      m.setAttribute("role", "dialog");
      m.style.cssText = "position:fixed;left:20px;top:20px;width:240px;height:140px;";
      document.body.appendChild(m);
      const r = T.cftOverlayBusy();
      m.remove();
      return r === false;
    })());

    wrap.remove();
    delete globalThis.__CFT_TAB_GUARD_DELAYS__;
    delete T.app.extensionManager;
  }

  /* ============ R46：v2.29 旧扩展兼容垫片（LGraphNode.requestVueRedraw） ============ */
  {
    const flagKey = T.CFT_LEGACY_SHIM_FLAG;
    const had = Object.prototype.hasOwnProperty.call(globalThis, "LGraphNode");
    const oldLGN = globalThis.LGraphNode;
    const oldFlag = globalThis[flagKey];
    const cleanup = () => {
      if (had) globalThis.LGraphNode = oldLGN;
      else delete globalThis.LGraphNode;
      if (oldFlag === undefined) delete globalThis[flagKey];
      else globalThis[flagKey] = oldFlag;
    };

    // ① 没有 LGraphNode：安全返回 false，不抛
    delete globalThis.LGraphNode;
    delete globalThis[flagKey];
    let r1 = "threw";
    try { r1 = T.cftInstallLegacyNodeApiShims(); } catch (e) { r1 = "threw"; }
    check("R46 没有 LGraphNode 时安全返回 false", r1 === false, String(r1));

    // ② 已有同名方法：不覆盖
    const origMethod = function originalRequestVueRedraw() { return "orig"; };
    globalThis.LGraphNode = function FakeLGraphNode() {};
    globalThis.LGraphNode.prototype.requestVueRedraw = origMethod;
    delete globalThis[flagKey];
    const r2 = T.cftInstallLegacyNodeApiShims();
    check(
      "R46 已存在 requestVueRedraw 时不覆盖",
      r2 === false && globalThis.LGraphNode.prototype.requestVueRedraw === origMethod,
      String(r2)
    );

    // ③ 缺失时补上空实现，且只装一次
    globalThis.LGraphNode = function FakeLGraphNode2() {};
    delete globalThis[flagKey];
    const r3 = T.cftInstallLegacyNodeApiShims();
    const installed = globalThis.LGraphNode.prototype.requestVueRedraw;
    const r4 = T.cftInstallLegacyNodeApiShims();
    check("R46 缺失时安装垫片", r3 === true && typeof installed === "function", String(r3));
    check("R46 重复调用不重复安装", r4 === false && globalThis.LGraphNode.prototype.requestVueRedraw === installed, String(r4));

    // ④ 垫片会把节点与画布标脏重绘
    const calls = [];
    const fakeNode = {
      setDirtyCanvas: (a, b) => calls.push(["node", a, b]),
      graph: { setDirtyCanvas: (a, b) => calls.push(["graph", a, b]) },
    };
    installed.call(fakeNode);
    check(
      "R46 垫片刷新节点与画布",
      calls.length === 2 && calls[0][0] === "node" && calls[1][0] === "graph",
      JSON.stringify(calls)
    );

    // ⑤ 内部异常必须吞掉（旧扩展不能因垫片再崩一次）
    let threw = false;
    try {
      installed.call({ setDirtyCanvas() { throw new Error("boom"); }, get graph() { throw new Error("boom2"); } });
    } catch (e) { threw = true; }
    check("R46 垫片内部异常不外抛", threw === false);

    cleanup();
  }

  /* ============ R47：v2.33 节点来源徽章文本（Civitai-LoRA-Rack → Civitai LoRA Rack） ============ */
  {
    // ① 常量
    check(
      "R47 徽章常量 = 插件全名（badge/display 一致）",
      T.NODE_SOURCE_BADGE &&
        T.NODE_SOURCE_BADGE.badgeText === "Civitai LoRA Rack" &&
        T.NODE_SOURCE_BADGE.displayText === "Civitai LoRA Rack",
      JSON.stringify(T.NODE_SOURCE_BADGE)
    );

    // ② 只改自己两个节点
    const mkDef = (name, extra = {}) => ({
      name,
      nodeSource: { type: "custom_nodes", className: "comfy-custom-nodes", displayText: "Civitai-LoRA-Rack", badgeText: "Civitai-LoRA-Rack", ...extra },
    });
    const stackDef = mkDef("CFTLoraStack");
    const loaderDef = mkDef("CFTLoraLoader");
    const otherDef = mkDef("SomeOtherNode");

    check(
      "R47 CFTLoraStack 徽章被改写",
      T.patchNodeSourceBadge(stackDef) === true &&
        stackDef.nodeSource.badgeText === "Civitai LoRA Rack" &&
        stackDef.nodeSource.displayText === "Civitai LoRA Rack",
      JSON.stringify(stackDef.nodeSource)
    );
    check(
      "R47 CFTLoraLoader 徽章被改写",
      T.patchNodeSourceBadge(loaderDef) === true && loaderDef.nodeSource.badgeText === "Civitai LoRA Rack"
    );
    check(
      "R47 第三方节点完全不动",
      T.patchNodeSourceBadge(otherDef) === false && otherDef.nodeSource.badgeText === "Civitai-LoRA-Rack",
      otherDef.nodeSource.badgeText
    );
    check("R47 空 / 异常输入安全返回 false", T.patchNodeSourceBadge(null) === false && T.patchNodeSourceBadge({}) === false);
    const coreDef = mkDef("CFTLoraStack", {});
    coreDef.nodeSource.type = "core";
    check("R47 非 custom_nodes 类型不动", T.patchNodeSourceBadge(coreDef) === false && coreDef.nodeSource.badgeText === "Civitai-LoRA-Rack");

    // ③ store 覆盖：普通对象 + Map 两种形态
    const prevApp = globalThis.app;
    try {
      const objDefs = { CFTLoraStack: mkDef("CFTLoraStack"), CFTLoraLoader: mkDef("CFTLoraLoader") };
      globalThis.app = { extensionManager: { _p: { state: { value: { nodeDef: { nodeDefsByName: objDefs } } } } } };
      check("R47 store（对象形态）覆盖成功", T.patchNodeSourceBadgeStore() === 2 && objDefs.CFTLoraStack.nodeSource.badgeText === "Civitai LoRA Rack");

      const mapDefs = new Map([
        ["CFTLoraStack", mkDef("CFTLoraStack")],
        ["CFTLoraLoader", mkDef("CFTLoraLoader")],
      ]);
      globalThis.app = { extensionManager: { _p: { state: { value: { nodeDef: { nodeDefsByName: mapDefs } } } } } };
      check(
        "R47 store（Map 形态）覆盖成功",
        T.patchNodeSourceBadgeStore() === 2 &&
          mapDefs.get("CFTLoraStack").nodeSource.badgeText === "Civitai LoRA Rack" &&
          mapDefs.get("CFTLoraLoader").nodeSource.badgeText === "Civitai LoRA Rack"
      );
      check("R47 cftNodeDefEntry 能取到条目", T.cftNodeDefEntry("CFTLoraStack")?.name === "CFTLoraStack");
    } finally {
      if (prevApp === undefined) delete globalThis.app;
      else globalThis.app = prevApp;
    }

    // ④ 没有 store 时静默返回 0（不抛）
    let threw = false;
    const prevApp2 = globalThis.app;
    try {
      globalThis.app = undefined;
      let n = -1;
      try { n = T.patchNodeSourceBadgeStore(); } catch { threw = true; }
      check("R47 无 store 时返回 0 且不抛", n === 0 && threw === false, `n=${n}`);
    } finally {
      if (prevApp2 === undefined) delete globalThis.app;
      else globalThis.app = prevApp2;
    }
  }

  dm.close();
}

/* --------------------------------------------------------------- 输出 */

let fatal = "";
try {
  if (!T) throw new Error("__CFT_TEST__ 未挂载");
  await main();
} catch (err) {
  fatal = (err && err.stack) ? err.stack : String(err);
  check("沙盒执行未抛异常", false, fatal.split("\n")[0]);
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const lines = [`SANDBOX_RESULT passed=${passed} failed=${failed.length}`];
for (const r of results) lines.push(`${r.ok ? "[OK]  " : "[FAIL]"} ${r.label}${r.detail ? " — " + r.detail : ""}`);
if (fatal) lines.push("\nFATAL:\n" + fatal);
const reportText = lines.join("\n");
document.getElementById("report").textContent = reportText;
document.title = failed.length ? `FAIL(${failed.length})` : `PASS(${passed})`;
console.log(reportText);
// 回传通道：新版 Chrome 在 Windows 上 --dump-dom 不再写 stdout（恒 0 字节），
// 所以把报告 POST 给 run_sandbox.mjs 的本地服务，由它解析断言结果。
try { await fetch("/__report", { method: "POST", body: reportText }); } catch (_) { /* ignore */ }

/* --------------------------------------------------------------- 截图模式 */

/* ?shot=stack|picker|lightbox|cleanup|ctxmenu|trash|detail_user|narrow
   —— 隐藏报告浮层并摆出「用户典型布局」，供 chrome --screenshot 拍视觉证据。
   只用于出图，不参与断言。 */
const SHOT = (location.search.match(/[?&]shot=([a-z_]+)/) || [])[1] || "";
if (SHOT) {
  // virtual-time-budget 会把 CSS 动画冻在任意帧（常是 opacity:0 的首帧），
  // 导致截图里窗口/菜单“隐形”。截图模式统一跳到动画终态。
  const animKill = document.createElement("style");
  animKill.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
  document.head.appendChild(animKill);
  const rep = document.getElementById("report");
  if (rep) rep.style.display = "none";
  document.querySelectorAll(".cft-mask").forEach((el) => el.remove());
  T.OPEN_MODALS.clear();
  // 视觉证据可选语言：?shot=settings&lang=en
  if (/[?&]lang=en/.test(location.search)) T.setLang("en");
  const shotNode = makeNode(11, [
    { lora: "A/one.safetensors", name: "one", display_name: "One", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
    { lora: "B/two.safetensors", name: "two", display_name: "Two", weight: 0.8, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
    { lora: "C/three.safetensors", name: "three", display_name: "Three", weight: 1.2, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
  ]);
  try {
    if (SHOT === "settings") {
      // v2.23 视觉证据：设置面板的分组卡片排版（不出断言，只用来看）
      // ?key=1 时伪装「已保存 Key」，用来看「清除 API Key」按钮的样子
      if (/[?&]key=1/.test(location.search)) FAKE.apiKey = "sk-shot-12345678abcd";
      T.openSettings();
      await tick(260);
      const sm = T.OPEN_MODALS.get("cft-settings");
      if (sm && sm._applyGeomSize) sm._applyGeomSize({ left: 380, top: 70, width: 540, height: 575 });
      await tick(140);
    } else {
    const stack = T.openStackManager(shotNode);
    await tick(60);
    // localStorage 里可能存着收起态，截图前强制展开
    if (stack.root.classList.contains("cft-minimized")) stack.toggleMinimize();
    await tick(40);
    if (SHOT === "narrow") {
      // 复现用户场景：把堆窗口调成窄竖条，检查「启用」开关与 ↑ ↓ ✕ 不再重合
      stack._applyGeomSize({ left: 24, top: 40, width: 340, height: 780 });
      await tick(120);
      stack._persistGeom && stack._persistGeom();
    } else {
      stack._applyGeomSize({ left: 24, top: 56, width: 452, height: 740 });
    }
    if (SHOT === "cleanup") {
      // 清理窗口：真实数据形态的假报告（含默认不勾选的 .json 与 0 个文件的分类）
      const cm = T.openCleanup(stack);
      await tick(160);
      cm._applyGeomSize({ left: 300, top: 46, width: 880, height: 740 });
    } else if (SHOT === "trash") {
      // 隔离区窗口：清理窗口靠左 + 隔离区窗口靠右
      // 前面 R1~R19 跑完会留下 0 个文件的临时批次，截图前恢复成预置形态（截图不参与断言）
      FAKE.trash.length = 0;
      FAKE.trash.push(
        { stamp: "20261016-101500-aaaa", root: "/models/loras", path: "/models/loras/.cft_trash/20261016-101500-aaaa",
          count: 15, size: 690 * 1024 * 1024, size_mb: 690, original_root: "/models/loras", byCat: [] },
        { stamp: "20261016-113000-bbbb", root: "/models/loras", path: "/models/loras/.cft_trash/20261016-113000-bbbb",
          count: 9, size: 88 * 1024 * 1024, size_mb: 88, original_root: "/models/Krea2", byCat: [] },
      );
      const cm = T.openCleanup(stack);
      await tick(160);
      cm._applyGeomSize({ left: 36, top: 46, width: 648, height: 700 });
      const trash = T.openTrash(cm);
      await tick(200);
      trash._applyGeomSize({ left: 706, top: 62, width: 764, height: 540 });
    } else if (SHOT === "ctxmenu") {
      // 右键菜单：悬在堆面板第一行上
      const row = stack.body.querySelector(".cft-stack-row");
      if (row) {
        const rr = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rr.left + 160, clientY: rr.top + 40 }));
        await tick(60);
        // Chrome 截图前初始化视口会触发一次 resize，而菜单监听了 resize 自毁。
        // 只影响截图：冻结实例的 destroy，让菜单活到快门。
        const inst = T.ContextMenu._inst;
        if (inst) inst.destroy = () => {};
      }
    } else if (SHOT === "picker") {      // 用空堆节点 + 强制卡片视图，让网格/卡片尺寸控件在截图里看得见；
      // 打开 FAKE.extra 把「侧车齐全但无 author/tags」的 Anima V2 也放进来，
      // 用于肉眼确认它**不再**挂「无C站信息」黄标
      FAKE.extra = true;
      T.META_CACHE.clear();
      T.Store.invalidate();
      localStorage.setItem("cft.loraStack.picker.view", "grid");
      const picker = T.openPicker(makeNode(12, []), () => {});
      await tick(120);
      picker._applyGeomSize({ left: 508, top: 56, width: 860, height: 740 });
    } else if (SHOT === "tags") {
      // v2.18 视觉证据：自定义标签最多显 5 个、超出折叠成「+N」芯片
      FAKE.extra = false;
      T.META_CACHE.clear();
      T.Store.invalidate();
      localStorage.setItem("cft.loraStack.picker.view", "grid");
      const picker = T.openPicker(makeNode(13, []), () => {});
      await tick(120);
      const itemBig = {
        lora: "Shot/many_tags.safetensors", name: "many_tags", display_name: "Many Tags Lora",
        base_model: "SD 1.5", size_mb: 42, creator: "ShotStudio",
        tags: ["details", "add more details", "micro details"],
        trained_words: ["addmicrodetails"],
        user_tags: ["11", "22", "33", "44", "55", "66", "77", "88"],
      };
      const wrapBig = picker.buildCard(itemBig);
      picker.grid.prepend(wrapBig);
      await tick(60);
      picker._applyGeomSize({ left: 508, top: 56, width: 860, height: 740 });
    } else if (SHOT === "ask") {
      // 报障 6 的视觉证据：宽视口下确认框必须【居中】，而不是被推到屏幕右侧之外。
      // 复刻用户真实路径：清理窗口里点「清理所选」→ CleanupModal._run() 里的 askConfirm({width:560})
      const cm = T.openCleanup(stack);
      await tick(180);
      cm._applyGeomSize({ left: 36, top: 46, width: 800, height: 700 });
      stack.close(); // 堆窗口会压住居中后的确认框，收起来
      await tick(80);
      T.askConfirm({
        title: "清理确认",
        message: "即将移到隔离区 316 个文件（78.06 MB）。",
        detailLines: [
          "分类：孤立预览图、孤立信息文件",
          "文件会移到 loras/.cft_trash/，之后可在「打开隔离区」里还原。",
        ],
        okLabel: "移到隔离区",
        width: 560,
      });
      await tick(300);
    } else if (SHOT === "detail_user") {
      // 详情窗（自定义标签 + 说明 + 封面按钮 + 视频主图）：用视频样本
      FAKE.samples = true;
      FAKE.userName = "Vid/onlyvideo.safetensors";
      FAKE.user = {
        tags: ["我的收藏", "风格", "夜景"],
        note: "自己写的说明：主打夜景与电影感。\n建议权重 0.8，配合 20 步采样。",
        cover: { kind: "remote", url: "https://image.civitai.com/x/vid.mp4", type: "video", set_at: 1792083355.2 },
      };
      T.META_CACHE.clear();
      T.Store.invalidate();
      const detail = new T.DetailModal("Vid/onlyvideo.safetensors", () => {});
      detail.open();
      await tick(200);
      detail._applyGeomSize({ left: 400, top: 40, width: 960, height: 780 });
    } else if (SHOT === "fav") {
      // v2.11 视觉证据：收藏视图必须含堆内条目（用户报障「从堆里收藏的看不到」修复后形态）
      stack.close(); // 堆窗口会压住 picker，收起来
      await tick(60);
      FAKE.samples = true;
      FAKE.extra = false;
      FAKE.user = { tags: [], note: "", cover: null, favorite: false };
      FAKE.userName = "";
      T.META_CACHE.clear();
      T.Store.invalidate();
      localStorage.setItem("cft.loraStack.picker.view", "grid");
      const favNode = makeNode(13, [
        { lora: "Mine/mytagged.safetensors", weight: 1 },
        { lora: "B/two.safetensors", weight: 1 },
      ]);
      const favPicker = T.openPicker(favNode, () => {});
      await tick(160);
      // 复刻运行期实况：两条堆内收藏 + 一条堆外收藏（Vid/onlyvideo）
      for (const n of ["Mine/mytagged.safetensors", "B/two.safetensors", "Vid/onlyvideo.safetensors"]) {
        const it = favPicker.data.items.find((x) => x.lora === n);
        if (it) it.favorite = true;
      }
      favPicker._syncFavBtn();
      const favBtnS = favPicker.toolbar.querySelector(".cft-fav-btn");
      if (favBtnS) favBtnS.click();
      await tick(120);
      favPicker._applyGeomSize({ left: 210, top: 36, width: 1080, height: 784 });
    } else if (SHOT === "favstar") {
      // v2.12 视觉证据：收藏星标的两个新入口 ——
      // ① 堆条目行「启用」右边；② 选择器卡片脚部 ⓘ 左边
      stack.close();
      await tick(60);
      FAKE.samples = true;
      FAKE.extra = false;
      FAKE.user = { tags: [], note: "", cover: null, favorite: true };
      FAKE.userName = "Mine/mytagged.safetensors";   // 让它一开始就显示成已收藏
      T.META_CACHE.clear();
      T.Store.invalidate();
      // ① 堆面板：两行，第一行为已收藏（★ 高亮），第二行未收藏（☆）
      const starNode = makeNode(14, [
        { lora: "Mine/mytagged.safetensors", weight: 1 },
        { lora: "B/two.safetensors", weight: 1 },
      ]);
      const starStack = T.openStackManager(starNode);
      await tick(200);
      starStack._applyGeomSize({ left: 120, top: 40, width: 1120, height: 520 });
      // ② 选择器卡片：卡片脚部 ⓘ 左边那颗星
      const starPicker = T.openPicker(makeNode(15, []), () => {});
      await tick(200);
      starPicker.setView("grid");
      await tick(80);
      starPicker._applyGeomSize({ left: 210, top: 210, width: 900, height: 700 });
    } else if (SHOT === "restored") {
      // v2.13 视觉证据：节点面板上的「已从本机备份恢复」横幅 + 右下角**堆叠**的全局 toast。
      // 构造路径（v2.13b 起与真实加载路径一致）：写好堆（自动落本机备份）→ 把 widget
      // 清成空堆（模拟重启后工作流里存的是空堆）→ setupNode（只是建面板，不回填）
      // → onConfigure（= 确实是从工作流里加载出来的）→ 60ms 后回填 + 弹 toast。
      //   ⚠️ v2.13 第一版这里是「setupNode 自动回填」，恢复路径收窄后那条路已经
      //   不存在了，照旧拍只会拍到一张「Lora 堆 • 0」的空面板（QA 实测复现过）。
      stack.close();
      await tick(60);
      const mkRestored = (id, rows) => {
        const n = makeNode(id, rows);
        T.writeStack(n, T.readStack(n));   // 确保本机备份落地
        n.widgets[0].value = "[]";         // 模拟「重启后工作流里存着空堆」
        T.setupNode(n);                    // 新建面板；**故意不回填**
        return n;
      };
      // toast 4.2s 后自毁，而 headless 的虚拟时间会一路跑到快门之后；
      // 掐掉长定时器只影响这一张截图（10ms 那个是加 -show 类的，必须保留）。
      const origST34 = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms) => (Number(ms) >= 4000 ? 0 : origST34(fn, ms));
      // 三个节点都从工作流里加载出来 → 三个恢复 toast 自然堆叠（也验证不再互相盖住）
      const rstNodes = [
        mkRestored(16, [
          { lora: "A/one.safetensors", name: "one", display_name: "One", weight: 0.8, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
          { lora: "B/two.safetensors", name: "two", display_name: "Two", weight: 1, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
        ]),
        mkRestored(17, [
          { lora: "C/three.safetensors", name: "three", display_name: "Three", weight: 1.2, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
        ]),
        mkRestored(18, [
          { lora: "D/four.safetensors", name: "four", display_name: "Four", weight: 0.65, text_encoder_weight: 1, trigger_weight: 0, hidden: false },
        ]),
      ];
      for (const n of rstNodes) {
        if (typeof n.onConfigure === "function") n.onConfigure({});
        await tick(140);                   // 覆盖 onConfigure 里的 60ms 回填定时器
      }
      globalThis.setTimeout = origST34;
      const rstNode = rstNodes[0];
      const host34 = document.createElement("div");
      host34.id = "cft-shot-host";
      host34.style.cssText = "position:absolute;left:40px;top:40px;width:360px;background:#1b1727;padding:0;overflow:hidden;";
      document.body.appendChild(host34);
      if (rstNode._dom && rstNode._dom.el) host34.appendChild(rstNode._dom.el);
    } else if (SHOT === "scroll") {
      // v2.16 视觉证据：同一个堆（30 条）放进两个不同高度的容器 ——
      // 左边矮（出滚动条，只看到 6 行），右边高（看到 20+ 行）。
      // 说明「显示多少条」由节点高度决定，不是插件写死的条数。
      stack.close();
      await tick(60);
      const rows = [];
      for (let i = 0; i < 30; i++) {
        const nm = `lora${String(i + 1).padStart(2, "0")}`;
        rows.push({ lora: `X/${nm}.safetensors`, name: nm, display_name: `Lora ${i + 1}`, weight: 0.8, text_encoder_weight: 1, trigger_weight: 0, hidden: false });
      }
      const mkShot = async (label, height, left, nodeId) => {
        const n = makeNode(nodeId, rows);
        T.setupNode(n);
        await tick(80);
        T.refreshNodePanel(n);
        await tick(60);
        const wrap = document.createElement("div");
        wrap.style.cssText = `position:absolute;left:${left}px;top:32px;width:340px;`;
        const cap = document.createElement("div");
        cap.textContent = label;
        cap.style.cssText = "font:12px system-ui,sans-serif;color:#9d94bd;margin-bottom:6px;";
        const host = document.createElement("div");
        host.style.cssText = `width:340px;height:${height}px;background:#1b1727;overflow:hidden;border:1px solid rgba(255,255,255,.12);border-radius:6px;`;
        wrap.appendChild(cap);
        wrap.appendChild(host);
        document.body.appendChild(wrap);
        if (n._dom && n._dom.el) host.appendChild(n._dom.el);
      };
      await mkShot("节点拉矮（≈200px）：只看到 6 行，其余靠滚动", 200, 40, 21);
      await mkShot("节点拉高（≈560px）：同一个堆看到 21 行", 560, 420, 22);
    } else if (SHOT === "detail_thumb") {
      // v2.17 视觉证据：点完画廊缩略图之后的详情页 ——
      // 主舞台已经是那一张、「设为封面」已解锁、**没有大图盖住**。
      stack.close();
      await tick(60);
      FAKE.user = fullUser();
      FAKE.userName = "A/one.safetensors";
      T.Store.invalidate();
      const dmThumb = new T.DetailModal("A/one.safetensors", () => {});
      dmThumb.open();
      await tick(200);
      dmThumb._applyGeomSize({ left: 240, top: 40, width: 900, height: 700 });
      await tick(80);
      const pickThumb = [...dmThumb.body.querySelectorAll(".cft-gal-item")]
        .find((el) => el.querySelector("img.cft-gallery-item"));
      if (pickThumb) pickThumb.click();
      await tick(120);
    } else if (SHOT !== "narrow") {
      const detail = new T.DetailModal("A/one.safetensors", () => {});
      detail.open();
      await tick(120);
      detail._applyGeomSize({ left: 508, top: 56, width: 860, height: 740 });
      if (SHOT === "lightbox") {
        const mi = detail.body.querySelector(".cft-detail-img");
        if (mi) mi.click();
        await tick(60);
      }
    }
    } // 结束 shot !== "settings" 分支
  } catch (err) {
    console.log("[shot] 摆布局失败:", err && err.message);
  }
  document.title = "SHOT_" + SHOT;
}
