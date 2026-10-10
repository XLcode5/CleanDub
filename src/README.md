# CleanDub 前端 (React + TypeScript + Vite)

本目录为 CleanDub 桌面应用的**渲染进程 UI**，由 Electron 主进程加载。

## 目录结构

```
src/
  main.tsx             入口
  App.tsx              路由（侧边栏切换三页）
  global.css           设计 Token（颜色/字号/间距，对齐 docs/cleandub-ui/03）
  types.ts             与 electron/preload.js 对齐的 IPC 类型契约
  bridge.ts            window.cleandub 封装；无 Electron 时启用演示模式
  demoData.ts          演示数据（仅 demo 模式使用）
  utils.ts             字节/时间/路径格式化
  components/          可复用 UI 组件（AppShell/Card/Dialog/Toast 等）
  pages/
    HomePage.tsx       首页 —— 扫描控制台
    CleanupPage.tsx    清理页 —— 重复文件分组
    ProfilePage.tsx    个人中心 —— 历史 + 隔离区
```

## 演示模式 vs 正式模式

- 在浏览器中直接 `npm run dev:renderer` 打开 → `window.cleandub` 不存在 → **演示模式**，
  所有数据来自 `src/demoData.ts`，UI 全程叠加「演示数据」徽标。
- 通过 `npm run dev`（同时启动 Vite + Electron）→ 主进程注入 `window.cleandub` → 真实数据模式。

## 依赖（由 A 代理负责安装）

渲染进程需要：
- `react`, `react-dom`
- `lucide-react`
- 开发期：`@vitejs/plugin-react`, `typescript`, `vite`, `@types/react`, `@types/react-dom`
