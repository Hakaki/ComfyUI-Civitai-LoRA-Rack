// 沙盒 stub：伪装 ComfyUI 的 ../../scripts/app.js
// 只提供插件用到的最小接口：app.registerExtension
export const app = {
  registerExtension(ext) {
    globalThis.__CFT_EXT__ = ext;
  },
};
