# EvoPanel 脚本使用指南

本文档说明 EvoPanel 项目的所有脚本使用方法。

## 📁 脚本位置

所有脚本位于 `evopanel/scripts/` 目录。

## 🚀 快速开始

### 开发环境

```powershell
# 方式一: 使用 npm 命令 (推荐)
npm run dev:tauri

# 方式二: 直接运行脚本
.\scripts\dev.ps1
```

**功能**:
- 自动检查 Node.js 和 Rust 环境
- 自动安装依赖
- 启动 Tauri 桌面开发服务器
- 支持热更新

---

### 构建安装包

```powershell
# 构建 Release 安装包 (默认)
npm run build:tauri

# 或直接运行
.\scripts\build.ps1
```

**其他选项**:

```powershell
# Debug 构建 (快速,不打包安装器)
npm run build:debug
.\scripts\build.ps1 -Debug

# 清理缓存后构建
npm run build:clean
.\scripts\build.ps1 -Clean
```

**输出**:
- Release 构建生成 NSIS 安装包
- 位置: `src-tauri\target\release\bundle\nsis\`
- 文件名: `EvoPanel_x.x.x_x64-setup.exe`

---

### 打包

```powershell
# 打包安装包
npm run package

# 仅生成 EXE
npm run package:exe

# 同时生成 EXE 和安装包
npm run package:all
```

---

### Web 版 (无需 Rust)

```powershell
# 启动 Web 服务 (默认端口 1420)
npm run serve:win

# 自定义端口
.\scripts\serve.ps1 -Port 8080
```

**适用场景**:
- 纯前端开发 (无需安装 Rust)
- Linux 服务器部署
- Docker 容器运行
- ARM 开发板

---

## 📋 完整命令列表

| 命令 | 说明 | 需要 Rust |
|------|------|-----------|
| `npm run dev:tauri` | 启动桌面开发环境 | ✅ |
| `npm run dev` | 启动前端开发 (仅 Vite) | ❌ |
| `npm run build:tauri` | 构建 Release 安装包 | ✅ |
| `npm run build:debug` | Debug 构建 (快速) | ✅ |
| `npm run build:clean` | 清理缓存后构建 | ✅ |
| `npm run package` | 打包安装包 | ✅ |
| `npm run package:exe` | 仅生成 EXE | ✅ |
| `npm run package:all` | 生成 EXE + 安装包 | ✅ |
| `npm run serve:win` | 启动 Web 服务 | ❌ |
| `npm run serve` | 启动 Web 服务 (Node) | ❌ |
| `npm run build` | 构建前端 | ❌ |
| `npm run preview` | 预览构建结果 | ❌ |

---

## 🔧 环境要求

### 桌面开发 (需要 Rust)

- **Node.js** >= 18
- **Rust** (stable) - 从 https://rustup.rs 安装
- **Tauri v2** 系统依赖
- **WebView2 Runtime** (Windows 10/11 自带)

### Web 开发 (无需 Rust)

- **Node.js** >= 18
- 任意操作系统

---

## 📦 构建产物说明

### Release 构建

```
src-tauri/target/release/bundle/
└── nsis/
    └── EvoPanel_x.x.x_x64-setup.exe  ← 安装包
```

### Debug 构建

```
src-tauri/target/debug/
└── evoflow.exe  ← 可执行文件 (未打包)
```

---

## 💡 常见问题

### Q: 构建失败,提示找不到 cargo

A: 需要安装 Rust:
```powershell
# 从 https://rustup.rs 下载 rustup-init.exe
# 运行安装程序,选择默认选项即可
```

### Q: 只想开发前端,不想装 Rust

A: 使用 Web 模式:
```powershell
npm run dev          # 仅启动前端
npm run serve:win    # 启动完整 Web 服务
```

### Q: 如何生成跨平台版本?

A: 推送 tag 触发 GitHub Actions:
```bash
git tag v0.1.0
git push origin v0.1.0
```

CI 会自动构建 Windows/macOS/Linux 版本。
