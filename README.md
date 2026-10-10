# CleanDub — Windows 重复文件清理工具

基于文件**内容**（SHA-256）识别重复文件，安全预览、隔离或清理。桌面应用。

![CleanDub 界面](docs/CleanDub重复文件清理工具界面展板.png)

## 功能

- **内容级判重**：三段流水线（枚举 → 按文件大小分组 → 头部 32KB prehash 淘汰 → 全量 SHA-256 流式哈希），跨目录、跨改名、多层 `(N)` 后缀都能命中
- **安全优先**：默认推荐移入隔离区（可随时恢复）而非永久删除；清理前强制二次确认；保留文件受保护
- **批量保留策略**：一键按规则（名字最干净 / 最新修改 / 原件优先 / 最大 N）为所有重复组选定保留文件
- **扫描选项**：校验级别、递归子目录、检测硬链接（跟随符号链接）、排除目录、最小文件大小
- **隔离区**：位置可自定义；manifest 格式跨版本兼容；恢复时冲突自动加 `.restored` 后缀
- **扫描历史**：SQLite 持久化，重启不丢
- **检查更新**：对接 GitHub Releases

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面容器 | Electron 33 |
| 前端 | React 19 + TypeScript + Vite 8 |
| 界面 | 浅色 GitHub 风格设计系统（自定义 CSS Token，Lucide 图标） |
| 主进程 | Node.js（扫描引擎 / SQLite / 文件安全操作） |
| 数据 | better-sqlite3（自动回退 node:sqlite 内置模块） |
| 打包 | electron-builder（NSIS） |

## 快速开始

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（Vite 热更新 + Electron 窗口）
npm test           # 冒烟测试（无需 GUI）
npm run build      # 生产构建（dist-renderer + NSIS 安装包）
```

> 开发模式首次启动若报 `spawn electron.exe ENOENT`，是 npm 拦截 postinstall 导致
> `node_modules/electron/path.txt` 末尾多出换行，重写该文件即可（内容：`electron.exe`，无换行）。

## 项目结构

```
electron/            主进程
  main.js            窗口生命周期 + IPC 注册
  scanner.js         扫描引擎（三段流水线 + 进度/取消）
  quarantine.js      隔离区（manifest 与历史版本兼容）
  db.js              SQLite（6 表：scan_sessions / scanned_files / duplicate_groups / quarantine_items / …）
  ipc.js             IPC 适配层（含检查更新、批量保留策略）
  settings.js        设置持久化（原子写）
  preload.js         contextIsolation 桥接
  smoke*.test.js     冒烟测试 ×3（无需 GUI）
src/                 React 渲染层
  pages/             首页 / 清理页 / 个人中心 / 设置页
  components/        20 个组件（AppShell / Card / ConfirmDialog / Toast / …）
  bridge.ts          IPC 封装（浏览器演示模式自动回退）
  global.css         设计 Token（#F6F8FA / #0969DA / 8px 圆角）
docs/cleandub-ui/     UI 规格分片 ×18（设计权威依据）
```

## 安全设计

1. 默认不自动删除文件；永久删除需强确认且展示文件清单
2. 保留文件始终受保护，不参与清理/隔离
3. 所有文件操作前重新验证路径在扫描根内 + 文件仍存在（防路径遍历）
4. 跨磁盘移动采用「复制 → 校验 → 提交 → 删源」流程，校验失败保留源文件
5. 隔离区目录不参与扫描，防止自引用

## 版本

v1.0.0 · [GitHub](https://github.com/XLcode5/CleanDub)
