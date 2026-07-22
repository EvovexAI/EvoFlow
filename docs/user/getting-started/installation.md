# 安装指南

> **安装 EvoFlow 有两种方式，选一种就行**：
>
> - **桌面客户端**（推荐）：下载安装包，双击安装，跟装微信/QQ 一样简单。Windows/macOS/Linux 都支持
> - **自托管**：适合开发者，需要 Python 3.12+、Node.js 22+、uv，然后 `make config && make install && make dev`
>
> 安装完成后，下一步是[配置模型](../tutorials/configure-models.md)让 AI 能聊天。

## 适用场景

在本地机器上安装 EvoFlow。有两种方式：

| 方式 | 适合谁 | 操作 |
|------|--------|------|
| **桌面客户端**（推荐） | 日常使用，只想快速上手 | 下载安装包，下一步→下一步 |
| **源码构建** | 开发者、需要修改源码 | 克隆仓库 + 安装依赖 |

---

## 方式一：桌面客户端（推荐）

1. 打开 [EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases)
2. 下载对应平台的最新安装包（`.exe` / `.dmg` / `.AppImage`）
3. 安装后启动，在「设置 → 模型」配置一个对话模型即可开始使用

> 如果你需要调试源码或自定义 Gateway，请用方式二。

---

## 方式二：源码构建

### 前置条件

| 软件 | 版本要求 | 用途 | 必须 |
|------|----------|------|------|
| Python | 3.12+ | 后端运行时 | 是 |
| Node.js | 22+ | 构建工具 | 是 |
| uv | 最新 | Python 包管理器 | 是 |
| Docker | 最新 | 沙箱 / Docker 模式 | 可选 |
| Rust | stable | EvoFlow 桌面开发 | 可选 |

### 安装 uv

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

### 步骤

#### 1. 克隆仓库

```bash
git clone https://github.com/EvovexAI/EvoFlow.git
cd EvoFlow
```

#### 2. 生成配置文件

```bash
make config
```

这会创建 `config.yaml` 和 `.env` 文件。

#### 3. 安装依赖

```bash
make install
```

此命令会安装：
- 后端依赖（通过 `uv sync`）
- 前端依赖（通过 `pnpm install`）

#### 4. （可选）预拉取沙箱镜像

```bash
make setup-sandbox
```

仅 Docker 沙箱模式需要。

### 验证是否生效

```bash
make check
```

所有检查项通过后即可开始配置模型。

---

## 常见问题

### uv sync 失败

确保你的 Python 版本 >= 3.12。可以用 `python --version` 检查。

### pnpm 未找到

```bash
npm install -g pnpm
```

## 相关文档

- [5 分钟快速上手](quick-start.md)
- [配置参考](../../system/reference/config-reference.md)
