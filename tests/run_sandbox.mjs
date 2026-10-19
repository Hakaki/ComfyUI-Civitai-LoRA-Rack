/**
 * DOM 沙盒运行器：把真实前端资源 + ComfyUI stub 拷到临时目录，
 * 起一个本地静态服务，用真实 Chromium（headless）执行，最后解析报告。
 *
 * 用法：node tests/run_sandbox.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB = join(ROOT, "web");
const SANDBOX = join(__dirname, "sandbox");

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/* ------------------------------------------------------------ 静态源码检查 */

const failures = [];
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "[OK]  " : "[FAIL]"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label);
}

const src = readFileSync(join(WEB, "cft_lora_stack.js"), "utf8");
const cssSrc = readFileSync(join(WEB, "cft_lora_stack.css"), "utf8");
console.log("=".repeat(68));
console.log("A. 源码静态检查（R4：权重滑块已彻底移除）");
console.log("=".repeat(68));
check("JS 不含 syncRangeBounds", !src.includes("syncRangeBounds"));
check("JS 不含 DEFAULT_WEIGHT_", !src.includes("DEFAULT_WEIGHT_"));
check("JS 不含 type: \"range\"", !/["']range["']/.test(src), (src.match(/type:\s*["']range["']/g) || []).join(","));
check("CSS 不含 .cft-range", !cssSrc.includes(".cft-range"));
check("CSS 不含 .cft-np-range", !cssSrc.includes(".cft-np-range"));
// 报障 5：自定义标签混排进标签行，不再单挂「✦ 自定义」徽标 —— 全文件不得再出现 cft-chip-user
check("JS 全文件不含 cft-chip-user（已删除独立徽标）", !src.includes("cft-chip-user"));
check("CSS 全文件不含 cft-chip-user（已删除死样式）", !cssSrc.includes("cft-chip-user"));
// 报障 3：视频链接不得加 crossorigin
check("videos 不挂 crossorigin", !/crossorigin/i.test(src));
// 报障 2：预览图 URL 必须带版本号
check("previewUrl 带 &v= 版本号", /preview\?name=\$\{q\}&v=\$\{v\}/.test(src));

/* i18n 覆盖率：所有 T("…") 字面键都必须在 I18N.en 里有翻译。
   漏一条 → 英文模式下那处文案回落中文（v2.23 用户报障即此类）。 */
function i18nBlock(s) {
  const at = s.indexOf("const I18N = {");
  if (at < 0) return "";
  let i = s.indexOf("{", at), depth = 0, inStr = null, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(i, j + 1);
  }
  return "";
}
const decodeKey = (raw) => { try { return JSON.parse('"' + raw + '"'); } catch { return raw; } };
const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const enKeys = new Set([...i18nBlock(src).matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => decodeKey(m[1])));
const tKeys = new Set([...noComments.matchAll(/\bT\("((?:[^"\\]|\\.)*)"/g)].map((m) => decodeKey(m[1])));
const missingKeys = [...tKeys].filter((k) => !enKeys.has(k));
check("i18n：所有 T() 字面键都有英文翻译", missingKeys.length === 0, missingKeys.slice(0, 8).join(" | "));

/* ------------------------------------------------------------- 构建沙盒 */

const work = join(tmpdir(), `cft_sandbox_${Date.now()}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "web"), { recursive: true });
mkdirSync(join(work, "scripts"), { recursive: true });

copyFileSync(join(WEB, "cft_lora_stack.js"), join(work, "web", "cft_lora_stack.js"));
copyFileSync(join(WEB, "cft_lora_stack.css"), join(work, "web", "cft_lora_stack.css"));
copyFileSync(join(SANDBOX, "index.html"), join(work, "index.html"));
copyFileSync(join(SANDBOX, "sandbox.js"), join(work, "sandbox.js"));
copyFileSync(join(SANDBOX, "stubs", "app.js"), join(work, "scripts", "app.js"));
copyFileSync(join(SANDBOX, "stubs", "api.js"), join(work, "scripts", "api.js"));

function serve(dir, sink) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      // 报告回传通道：新版 Chrome（>= 13x）在 Windows 上不再把 --dump-dom
      // 写进 stdout 管道（实测 Chrome 155 输出恒为 0 字节），因此改成
      // 页面把报告 POST 回来，run() 优先用这份内容，dump-dom 仅作兜底。
      if (urlPath === "/__report") {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (d) => { body += d; });
        req.on("end", () => {
          sink.report = body;
          res.writeHead(204, { "Cache-Control": "no-store" });
          res.end();
        });
        return;
      }
      // 假图片：让 <img src="/cft_lora/preview|/image?..."> 真的拿到图，
      // 这样截图能验证「详情图/画廊图/缩略图」真实渲染路径，而不是占位破图。
      if (urlPath === "/cft_lora/preview" || urlPath === "/cft_lora/image") {
        const q = new URLSearchParams((req.url || "").split("?")[1] || "");
        const label = q.get("name") || q.get("url") || "lora";
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b2d63"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><text x="256" y="245" font-size="26" fill="#fff" text-anchor="middle" font-family="sans-serif">${label.replace(/[<>&]/g, "").slice(0, 22)}</text><text x="256" y="290" font-size="18" fill="#e9e6f5" text-anchor="middle" font-family="sans-serif">512 x 512</text></svg>`;
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
        res.end(svg);
        return;
      }
      const rel = urlPath === "/" ? "/index.html" : urlPath;
      const file = join(dir, rel);
      try {
        const buf = readFileSync(file);
        const ext = rel.slice(rel.lastIndexOf("."));
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(buf);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      readFileSync(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

function unescapeHTML(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 异步启动 Chrome 并收集 stdout。
 * 注意：必须用异步 spawn —— execFileSync 会阻塞事件循环，
 * 导致同进程内的静态服务无法响应 Chrome 的请求（页面根本加载不了）。
 */
function runChrome(chrome, args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const child = spawn(chrome, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    child.on("error", () => { clearTimeout(timer); resolve(out); });
  });
}

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("\n未找到 Chrome，跳过 DOM 沙盒（如实报告未验证项）");
    return { skipped: true };
  }
  const sink = { report: "" };
  const server = await serve(work, sink);
  const port = server.address().port;

  // 截图模式：CFT_SHOT=stack|picker|lightbox 时只截图不断言
  const shot = process.env.CFT_SHOT || "";
  if (shot) {
    const out = process.env.CFT_SHOT_OUT || join(tmpdir(), `cft_shot_${shot}.png`);
    const url = `http://127.0.0.1:${port}/index.html?shot=${encodeURIComponent(shot)}${process.env.CFT_SHOT_LANG ? "&lang=" + encodeURIComponent(process.env.CFT_SHOT_LANG) : ""}${process.env.CFT_SHOT_KEY ? "&key=" + encodeURIComponent(process.env.CFT_SHOT_KEY) : ""}${process.env.CFT_SHOT_DUMP ? "&dump=1" : ""}`;
    const profile = join(work, "chrome-profile-shot");
    // 注意：必须接收 runChrome 的返回值。此前这里写成 `await runChrome(...)`，
    // 下面打印的其实是上面那个截图路径变量 out，导致 --dump-dom 输出被吞掉
    // （DUMP_LEN 恒等于路径长度）。
    const dom = await runChrome(chrome, [
      "--headless=new", "--disable-gpu", "--no-proxy-server", "--no-first-run",
      "--no-default-browser-check", "--disable-extensions",
      // 关键：本机 shell 以管理员身份运行，Chrome 检测到提权会自动「降权重启」，
      // 原进程立刻退出、stdout/截图文件全丢（实测退出码 0、输出 0 字节）。
      "--do-not-de-elevate",
      `--user-data-dir=${profile}`, `--window-size=${process.env.CFT_SHOT_SIZE || "1500,860"}`,
      "--hide-scrollbars", "--virtual-time-budget=60000",
      ...(process.env.CFT_SHOT_DUMP ? ["--dump-dom"] : [`--screenshot=${out}`]),
      url,
    ], 120000);
    if (process.env.CFT_SHOT_DUMP) {
      const limit = Number(process.env.CFT_SHOT_DUMP_LIMIT || 0) || dom.length;
      console.log("DUMP_LEN=" + dom.length);
      console.log("DUMP_BEGIN\n" + dom.slice(0, limit) + "\nDUMP_END");
    }
    server.close();
    console.log(`截图已输出：${out}`);
    return { skipped: true, shot: out };
  }

  const url = `http://127.0.0.1:${port}/index.html`;
  const profile = join(work, "chrome-profile");

  console.log();
  console.log("=".repeat(68));
  console.log(`B. 真实 Chromium DOM 沙盒：${url}`);
  console.log("=".repeat(68));

  let out = "";
  try {
    out = await runChrome(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-proxy-server",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      // 关键：本机 shell 以管理员身份运行，Chrome 检测到提权会自动「降权重启」，
      // 原进程立刻退出（退出码 0、输出 0 字节），页面根本不会加载。
      "--do-not-de-elevate",
      `--user-data-dir=${profile}`,
      "--window-size=1280,800",
      // 用例变多（R20~R25 每条都有若干 await tick），12s 虚拟时间不够会在写完报告前退出
      "--virtual-time-budget=45000",
      "--dump-dom",
      url,
    ]);
    // 给页面发完 POST /__report 留一点收尾时间
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    server.close();
  }

  const m = out.match(/id="report">([\s\S]*?)<\/pre>/);
  let report = m ? unescapeHTML(m[1]).trim() : "";
  if (!report && sink.report) report = sink.report.trim();
  const head = report.split("\n")[0] || "";

  if (process.env.CFT_DEBUG) {
    const dumpFile = join(tmpdir(), "cft_sandbox_dump.html");
    writeFileSync(dumpFile, out, "utf8");
    console.log(`[debug] dump 长度=${out.length}，已写入 ${dumpFile}`);
    console.log(`[debug] 是否含 report id：${out.includes('id="report"')}`);
    console.log(`[debug] POST 回传长度=${sink.report.length}`);
  }

  console.log("----- Chromium dump 中的报告 -----");
  console.log(report || "(未捕获到报告)");
  console.log("----------------------------------");

  const passMatch = head.match(/passed=(\d+)\s+failed=(\d+)/);
  if (!passMatch) {
    check("沙盒产出报告", false, head || "无");
    return { skipped: false };
  }
  const passed = Number(passMatch[1]);
  const failed = Number(passMatch[2]);
  console.log();
  console.log(`沙盒断言：通过 ${passed}，失败 ${failed}`);
  if (failed > 0) failures.push(`DOM 沙盒 ${failed} 项失败`);
  if (passed === 0) failures.push("DOM 沙盒 0 项通过（疑似未运行）");
  return { skipped: false, passed, failed };
}

let result = { skipped: true };
try {
  result = await run();
} finally {
  // Chrome 在 Windows 上有时还攥着 chrome-profile 句柄，首次 rmSync 会失败。
  // 静默吞掉会在临时目录里越积越多残渣，所以退避重试几次再放弃（失败也不影响结论）。
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      if (i === 2) console.log(`[warn] 临时目录未能清理（可手动删除）：${work}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

console.log();
console.log("=".repeat(68));
console.log("结果");
console.log("=".repeat(68));
if (failures.length) {
  console.log(`  [FAIL] ${failures.length} 项未通过：`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}
if (result.skipped) {
  if (result.shot) {
    console.log(`  [PASS] 截图模式完成：${result.shot}`);
    process.exit(0);
  }
  // 没跑 DOM 沙盒时【不能】报 PASS：357/0 那个期望值只有拿到报告才会校验，
  // 静默 exit 0 会让「无 Chrome 的机器」把 300+ 条断言当成通过。
  // 确实要在无 Chrome 环境下跑，请显式设置 CFT_ALLOW_NO_CHROME=1。
  if (process.env.CFT_ALLOW_NO_CHROME === "1") {
    console.log("  [SKIP] DOM 沙盒被跳过（未找到 Chrome，按 CFT_ALLOW_NO_CHROME=1 放行）");
    process.exit(0);
  }
  console.log("  [FAIL] DOM 沙盒被跳过（未找到 Chrome）—— 断言未执行，不能算通过");
  console.log("         确需在无 Chrome 环境运行，请设置 CFT_ALLOW_NO_CHROME=1");
  process.exit(2);
}
console.log("  [PASS] 静态检查 + DOM 沙盒全部通过");
