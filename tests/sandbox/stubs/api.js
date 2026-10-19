// 沙盒 stub：伪装 ComfyUI 的 ../../scripts/api.js
// 记录所有调用，并交给沙盒注册的 __CFT_HANDLE__ 生成假响应。
export const api = {
  async fetchApi(url, opts) {
    globalThis.__CFT_CALLS__ = globalThis.__CFT_CALLS__ || [];
    let body = null;
    try {
      body = opts && opts.body ? JSON.parse(opts.body) : null;
    } catch {
      body = null;
    }
    globalThis.__CFT_CALLS__.push({ url, method: (opts && opts.method) || "GET", body });
    const handler = globalThis.__CFT_HANDLE__;
    if (typeof handler === "function") return handler(url, opts);
    return { ok: false, status: 404, json: async () => ({ ok: false, error: "no handler" }) };
  },
};
