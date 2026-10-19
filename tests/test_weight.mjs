/**
 * 前端权重逻辑单元测试（原生 Node，无第三方依赖）。
 *
 * 做法：把 web/cft_lora_stack.js 的 ESM import 行剥掉、注入最小 DOM / ComfyUI stub，
 * 再把纯函数导出后动态 import 进来断言。这样测的是「真实源码」，不是复制品。
 *
 * 用法：node tests/test_weight.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "web", "cft_lora_stack.js");

const failures = [];
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "[OK]  " : "[FAIL]"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label);
}

// --- 读取源码并剥离 import 语句 ---------------------------------------------
let code = readFileSync(SRC, "utf8");
code = code.replace(/^import .*$/gm, "");

// --- 注入 stub：document / app / api / localStorage -------------------------
const stub = `
const app = { registerExtension() {} };
const api = { fetchApi() {} };
const _el = () => ({
  style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
  setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {}, removeEventListener() {},
});
const document = {
  querySelector() { return null; },
  createElement() { return _el(); },
  createTextNode(t) { return { t }; },
  head: { appendChild() {} },
  body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {},
  documentElement: { clientWidth: 1280, clientHeight: 800 },
};
const window = {
  innerWidth: 1280, innerHeight: 800,
  addEventListener() {}, removeEventListener() {},
  matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
};
const localStorage = {
  _m: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
  setItem(k, v) { this._m[k] = String(v); },
  removeItem(k) { delete this._m[k]; },
};
`;
const exports = `
export {
  parseWeight, finiteOr, normalizeEntry, serializeEntry,
  clampGeom, parseViewMode, parseCardSize, isMissingMeta, previewUrl,
  mergeMeta, metaFromCivitai, hasCivitaiDetail, needsCivitaiLookup,
};
`;

const tmpFile = join(tmpdir(), `cft_weight_test_${Date.now()}.mjs`);
writeFileSync(tmpFile, stub + code + exports, "utf8");
const mod = await import(pathToFileURL(tmpFile).href);

console.log("=".repeat(64));
console.log("1. parseWeight：不做上下限钳制");
console.log("=".repeat(64));
check("-5 原样保留", mod.parseWeight(-5) === -5, String(mod.parseWeight(-5)));
check("-3.5 原样保留", mod.parseWeight(-3.5) === -3.5, String(mod.parseWeight(-3.5)));
check("7.25 原样保留", mod.parseWeight(7.25) === 7.25, String(mod.parseWeight(7.25)));
check("100 原样保留", mod.parseWeight(100) === 100, String(mod.parseWeight(100)));
check("0 原样保留", mod.parseWeight(0) === 0, String(mod.parseWeight(0)));
check("边界 3 不受影响", mod.parseWeight(3) === 3, String(mod.parseWeight(3)));
check("超多小数位保留", mod.parseWeight(1.23456789) === 1.23456789, String(mod.parseWeight(1.23456789)));
check("字符串 '-5' 转数字", mod.parseWeight("-5") === -5, String(mod.parseWeight("-5")));
check("空串回退到 fallback", mod.parseWeight("", 2) === 2, String(mod.parseWeight("", 2)));
check("NaN 回退到 fallback", mod.parseWeight(NaN, 2) === 2, String(mod.parseWeight(NaN, 2)));
check("非法字符串回退到 fallback", mod.parseWeight("abc", 1) === 1, String(mod.parseWeight("abc", 1)));
check("fallback 默认 1", mod.parseWeight(undefined) === 1, String(mod.parseWeight(undefined)));

console.log();
console.log("=".repeat(64));
console.log("2. normalizeEntry / serializeEntry：不截断、可往返");
console.log("=".repeat(64));
const e1 = mod.normalizeEntry({ lora: "a/b.safetensors", weight: -5, text_encoder_weight: 7.25, trigger_weight: -3.5 });
check("normalizeEntry weight=-5 不截断", e1.weight === -5, String(e1.weight));
check("normalizeEntry clip=7.25 不截断", e1.text_encoder_weight === 7.25, String(e1.text_encoder_weight));
check("normalizeEntry trigger=-3.5 不截断", e1.trigger_weight === -3.5, String(e1.trigger_weight));

const e2 = mod.normalizeEntry({ lora: "x.safetensors" });
check("缺省 weight 默认 1", e2.weight === 1, String(e2.weight));
check("缺省 trigger_weight 默认 0", e2.trigger_weight === 0, String(e2.trigger_weight));

const e3 = mod.normalizeEntry({ lora: "y.safetensors", weight: "abc" });
check("非法 weight 回退默认 1", e3.weight === 1, String(e3.weight));

const e4 = mod.normalizeEntry({ path: "z/p.safetensors", clip_weight: 4.5, hidden: true });
check("别名 path/clip_weight 兼容", e4.lora === "z/p.safetensors" && e4.text_encoder_weight === 4.5 && e4.hidden === true);

const round = mod.normalizeEntry(mod.serializeEntry(e1));
check("序列化往返一致(weight)", round.weight === -5, String(round.weight));
check("序列化往返一致(clip)", round.text_encoder_weight === 7.25, String(round.text_encoder_weight));
check("序列化往返一致(trigger)", round.trigger_weight === -3.5, String(round.trigger_weight));

const s0 = mod.serializeEntry({ lora: "a", name: "a", weight: 0, text_encoder_weight: 0, trigger_weight: 0, hidden: false });
check("合法 0 不被吞成默认", s0.weight === 0 && s0.text_encoder_weight === 0, JSON.stringify(s0));

const sBad = mod.serializeEntry({ lora: "a", name: "a", weight: NaN, text_encoder_weight: undefined, trigger_weight: "abc" });
check("非法值序列化为 0", sBad.weight === 0 && sBad.text_encoder_weight === 0 && sBad.trigger_weight === 0, JSON.stringify(sBad));

console.log();
console.log("=".repeat(64));
console.log("3. clampGeom：窗口几何夹紧到视口内");
console.log("=".repeat(64));
const vp = { width: 1280, height: 800 };

const g1 = mod.clampGeom({ left: 100, top: 100, width: 600, height: 400 }, vp);
check("正常值不变", g1.left === 100 && g1.top === 100 && g1.width === 600 && g1.height === 400, JSON.stringify(g1));

const g2 = mod.clampGeom({ left: 5000, top: 5000, width: 600, height: 400 }, vp);
check("越界 left/top 夹回视口", g2.left + g2.width <= vp.width && g2.top + g2.height <= vp.height, JSON.stringify(g2));
check("left/top 不为负", g2.left >= 0 && g2.top >= 0, JSON.stringify(g2));

const g3 = mod.clampGeom({ left: -300, top: -300, width: 600, height: 400 }, vp);
check("负 left/top 夹回 0", g3.left === 0 && g3.top === 0, JSON.stringify(g3));

const g4 = mod.clampGeom({ left: 0, top: 0, width: 10, height: 10 }, vp);
check("过小尺寸抬到最小值 360x240", g4.width === 360 && g4.height === 240, JSON.stringify(g4));

const g5 = mod.clampGeom({ left: 0, top: 0, width: 99999, height: 99999 }, vp);
check("超大尺寸夹到视口-16 内", g5.width <= vp.width - 15 && g5.height <= vp.height - 15, JSON.stringify(g5));

const g6 = mod.clampGeom({ left: 0, top: 0, width: 500, height: 400, minimized: true }, vp);
check("minimized 透传", g6.minimized === true);

const g7 = mod.clampGeom({}, vp);
check("空对象回退默认尺寸", g7.width === 360 && g7.height === 240, JSON.stringify(g7));

const g8 = mod.clampGeom({ left: 50, top: 50, width: Number.NaN, height: Number.NaN }, vp);
check("NaN 尺寸回退默认", g8.width === 360 && g8.height === 240, JSON.stringify(g8));

console.log();
console.log("=".repeat(64));
console.log("4. parseViewMode / parseCardSize：选择器视图与尺寸");
console.log("=".repeat(64));
check("view 'list' → list", mod.parseViewMode("list") === "list");
check("view 'grid' → grid", mod.parseViewMode("grid") === "grid");
check("view 非法 → grid", mod.parseViewMode("weird") === "grid");
check("view undefined → grid", mod.parseViewMode(undefined) === "grid");

check("cardSize 168 保留", mod.parseCardSize(168) === 168, String(mod.parseCardSize(168)));
check("cardSize 100 → 夹到 120", mod.parseCardSize(100) === 120, String(mod.parseCardSize(100)));
check("cardSize 999 → 夹到 320", mod.parseCardSize(999) === 320, String(mod.parseCardSize(999)));
check("cardSize 小数取整", mod.parseCardSize(200.6) === 201, String(mod.parseCardSize(200.6)));
check("cardSize 非法 → 默认 168", mod.parseCardSize("abc") === 168, String(mod.parseCardSize("abc")));
check("cardSize undefined → 默认 168", mod.parseCardSize(undefined) === 168, String(mod.parseCardSize(undefined)));

console.log();
console.log("=".repeat(64));
console.log("5. previewUrl：本地预览优先，回退远程代理");
console.log("=".repeat(64));
check("有本地预览 → /preview",
  mod.previewUrl({ lora: "a/b.safetensors", preview: "a/b.preview.png" }).startsWith("/cft_lora/preview"),
  mod.previewUrl({ lora: "a/b.safetensors", preview: "a/b.preview.png" }));
check("无本地预览但远端有图 → /image",
  mod.previewUrl({ lora: "c.safetensors", remote_images: [{ url: "https://image.civitai.com/x.jpeg" }] }).startsWith("/cft_lora/image"),
  mod.previewUrl({ lora: "c.safetensors", remote_images: [{ url: "https://image.civitai.com/x.jpeg" }] }));
check("都没有 → 仍回退 /preview",
  mod.previewUrl({ lora: "d.safetensors" }).startsWith("/cft_lora/preview"));

console.log();
console.log("=".repeat(64));
console.log("6. isMissingMeta / needsCivitaiLookup：黄标与批量名单的两套判据");
console.log("=".repeat(64));
const imm = mod.isMissingMeta;
check("creator 有值 → 不缺", imm({ creator: "alice" }) === false);
check("只有 tags → 不缺", imm({ creator: "", tags: ["t"] }) === false);
check("只有 trained_words → 不缺", imm({ creator: "", trained_words: ["w"] }) === false);
check("creator 空 + tags 空 → 缺", imm({ creator: "", tags: [] }) === true);
check("creator 空 + tags 空 + trained_words 空 → 缺", imm({ creator: "", tags: [], trained_words: [] }) === true);
check("空对象 → 缺", imm({}) === true);
check("null / undefined → 缺", imm(null) === true && imm(undefined) === true);
check("tags 是空字符串（非数组）→ 仍算缺", imm({ creator: "", tags: "" }) === true);
// ↓ 用户真实截图：侧车存在但没有 creator/tags，早先被误挂「无C站信息」黄标
check("source=civitai 但无 creator/tags → 不缺（不得误挂黄标）",
  imm({ source: "civitai", has_meta: true, creator: "", tags: [], trained_words: [], base_model: "Anima", downloads: 2178 }) === false);
check("source=civitai + 有 creator → 不缺", imm({ source: "civitai", creator: "bob" }) === false);
// ↓ 但只有 safetensors 头部的 lora 确实没有 C 站信息，必须继续挂黄标
check("source=safetensors → 仍算缺（has_meta 不作数）",
  imm({ source: "safetensors", has_meta: true, creator: "", tags: [], trained_words: [] }) === true);
check("source=safetensors 且无细节 → 缺", imm({ source: "safetensors", creator: "", tags: [] }) === true);

const ncl = mod.needsCivitaiLookup;
check("批量名单：有作者 → 不查", ncl({ creator: "alice", tags: ["t"] }) === false);
check("批量名单：缺作者 → 要查", ncl({ creator: "", tags: [], trained_words: [] }) === true);
check("批量名单：侧车在但缺作者 → 仍要查（可尝试补全）",
  ncl({ source: "civitai", has_meta: true, creator: "", tags: [], trained_words: [] }) === true);
const hcd = mod.hasCivitaiDetail;
check("hasCivitaiDetail 只看作者/标签/触发词",
  hcd({ creator: "a", tags: [], trained_words: [] }) === true
  && hcd({ creator: "", tags: ["t"], trained_words: [] }) === true
  && hcd({ creator: "", tags: [], trained_words: [] }) === false
  && hcd(null) === false);

console.log();
console.log("=".repeat(64));
console.log("7. mergeMeta：元数据只前进不后退（修「刷新后黄标又回来」）");
console.log("=".repeat(64));
const mm = mod.mergeMeta;
check("无 prev → 原样返回 next", mm(null, { creator: "a" }).creator === "a");
check("next 有信息 → 以 next 为准", mm({ creator: "old" }, { creator: "new" }).creator === "new");
check("next 缺信息 + prev 有 → 用 prev 的 creator 补回",
  mm({ creator: "cached", tags: ["t"] }, { creator: "", tags: [] }).creator === "cached");
check("next 缺信息 + prev 有 → 数组字段也补回",
  JSON.stringify(mm({ creator: "c", tags: ["t1"], trained_words: ["w1"] }, { creator: "", tags: [], trained_words: [] }).tags) === '["t1"]'
  && mm({ creator: "c", tags: [], trained_words: ["w1"] }, { creator: "", tags: [], trained_words: [] }).trained_words[0] === "w1");
check("next 缺信息 + prev 也缺 → 不编造数据",
  mm({ creator: "", tags: [] }, { creator: "", tags: [] }).creator === "");
check("next 的非元数据字段不被 prev 覆盖",
  mm({ folder: "X", creator: "c" }, { folder: "Y", creator: "" }).folder === "Y");
check("next 的 base_model/url 缺时用 prev",
  mm({ creator: "c", base_model: "SDXL", url: "u1" }, { creator: "", base_model: "", url: "" }).base_model === "SDXL"
  && mm({ creator: "c", base_model: "SDXL", url: "u1" }, { creator: "", base_model: "", url: "" }).url === "u1");
check("合并后不再是「缺信息」", imm(mm({ creator: "c", tags: ["t"] }, { creator: "", tags: [] })) === false);

console.log();
console.log("=".repeat(64));
console.log("8. metaFromCivitai：把 /refresh 响应归一化（不依赖 /list 重扫）");
console.log("=".repeat(64));
const mfc = mod.metaFromCivitai;
const flat = mfc({ modelId: 123, name: "Cool Lora", creator: "bob", baseModel: "SDXL", trainedWords: ["tr"], tags: ["style"], images: [{ url: "https://img/1.jpeg" }], stats: { downloadCount: 42 } }, { lora: "a/b.safetensors" });
check("扁平 API 响应 → creator", flat && flat.creator === "bob", flat ? flat.creator : "null");
check("扁平 API 响应 → base_model", flat && flat.base_model === "SDXL", flat ? flat.base_model : "null");
check("扁平 API 响应 → trained_words", flat && flat.trained_words[0] === "tr", flat ? JSON.stringify(flat.trained_words) : "null");
check("扁平 API 响应 → url 由 modelId 拼出", flat && flat.url === "https://civitai.com/models/123", flat ? flat.url : "null");
check("扁平 API 响应 → downloads 取 stats", flat && flat.downloads === 42, String(flat && flat.downloads));
check("扁平 API 响应 → 保留 lora 键", flat && flat.lora === "a/b.safetensors", flat ? flat.lora : "null");
check("username 别名 → creator", (mfc({ username: "carol", tags: ["t"] }, {}) || {}).creator === "carol");
const nested = mfc({ version: { name: "v2", baseModel: "SD1.5" }, username: "dave", trainedWords: ["z"] }, {});
check("嵌套 version 形状 → version_name", nested && nested.version_name === "v2", nested ? nested.version_name : "null");
check("嵌套 version 形状 → base_model 回退", nested && nested.base_model === "SD1.5", nested ? nested.base_model : "null");
check("无实质信息 → 返回 null（不覆盖旧数据）", mfc({ description: "x" }, {}) === null && mfc({}, {}) === null && mfc(null, {}) === null);
check("结果标记 source=civitai（黄标判据依赖它）", flat && flat.source === "civitai" && flat.has_meta === true, flat ? `${flat.source}/${flat.has_meta}` : "null");
check("metaFromCivitai 的结果判为「不缺」", flat && imm(flat) === false, "");

console.log();
console.log("=".repeat(64));
console.log("结果");
console.log("=".repeat(64));
if (failures.length) {
  console.log(`  [FAIL] ${failures.length} 项未通过：`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
console.log("  [PASS] 全部检查通过");
