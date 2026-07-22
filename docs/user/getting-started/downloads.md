# 下载与安装

> **想开始用？按你的情况选一种方式**：
>
> - **桌面客户端**（推荐）：去 GitHub Releases 下载安装包，Windows/macOS/Linux 都支持，双击安装即可
> - **开发者自托管**：有 Python 3.12+ 和 Node.js 22+？用 `make config && make install && make dev` 启动
>
> 下载完推荐先看[5 分钟快速上手](quick-start.md)开始体验。

## 桌面客户端

**桌面客户端** 的安装包与 EvoFlow 本体一并发布在 **[EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases)**。

### 下载哪个文件？

在 Releases 页找到最新版本，展开底部的 **Assets** 列表，按你的系统选：

| 系统 | 文件名示例 | 说明 |
|------|-----------|------|
| **Windows** | `EvoFlow_Setup_x.x.x_x64.exe` | 安装程序，双击运行 |
| **macOS** | `EvoFlow_x.x.x_x64.dmg` | 磁盘映像，安装后拖到 Applications 文件夹 |
| **Linux** | `EvoFlow_x.x.x_x64.AppImage` | 下载后 `chmod +x` 即可运行 |

> 如果系统提示"无法验证开发者"，macOS 用户去「系统设置 → 隐私与安全性」中允许运行；Windows 用户点击"更多信息"后再点"仍要运行"即可。

### 安装后做什么

打开应用，在 **设置 → 模型** 中配置 API 密钥即可开始使用。详细界面说明见 [桌面端使用指南](../guides/configuration/evopanel-guide.md)。

## 开发者自托管

如果需要从源码部署后端，请参考 [安装说明](installation.md)。
