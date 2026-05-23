# 安装指南

## 适用场景

在本地机器上安装 EvoFlow，支持本地开发和 Docker 开发两种模式。

## 前置条件

| 软件 | 版本要求 | 用途 | 必须 |
|------|----------|------|------|
| Python | 3.12+ | 后端运行时 | 是 |
| Node.js | 22+ | 构建工具 | 是 |
| uv | 最新 | Python 包管理器 | 是 |
| Docker | 最新 | 沙箱 / Docker 模式 | 可选 |
| Rust | stable | EvoPanel 桌面开发 | 可选 |

### 安装 uv

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

## 步骤

### 1. 克隆仓库

```bash
git clone https://github.com/EvovexAI/EvoFlow.git
cd deerflow-agent
```

### 2. 生成配置文件

```bash
make config
```

这会创建 `config.yaml` 和 `.env` 文件。

### 3. 安装依赖

```bash
make install
```

此命令会安装：
- 后端依赖（通过 `uv sync`）
- 前端依赖（通过 `pnpm install`）

### 4. （可选）预拉取沙箱镜像

```bash
make setup-sandbox
```

仅 Docker 沙箱模式需要。

## 验证是否生效

```bash
make check
```

所有检查项通过后即可开始配置模型。

## 常见问题

### uv sync 失败

确保你的 Python 版本 >= 3.12。可以用 `python --version` 检查。

### pnpm 未找到

```bash
npm install -g pnpm
```

## 相关文档

- [5 分钟快速上手](quick-start.md)
- [配置参考](../reference/config-reference.md)
