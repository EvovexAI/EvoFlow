# Makefile 命令参考

## 概述

项目根目录的 `Makefile` 提供统一的项目管理命令。Windows 下通过 Git Bash 自动桥接。

## 开发命令

| 命令 | 说明 |
|------|------|
| `make config` | 生成本地配置文件（config.yaml + .env） |
| `make config-upgrade` | 从 config.example.yaml 合并新字段到 config.yaml |
| `make check` | 检查前置条件（Python、Node.js、uv 等） |
| `make install` | 安装所有依赖（后端 + 前端） |
| `make setup-sandbox` | 预拉取沙箱容器镜像 |
| `make dev` | 启动所有服务（开发模式，热重载） |
| `make start` | 启动所有服务（生产模式，无热重载） |
| `make dev-daemon` | 后台启动所有服务 |
| `make stop` | 停止所有服务 |
| `make clean` | 停止服务并清理临时文件 |

## Docker 开发命令

| 命令 | 说明 |
|------|------|
| `make docker-init` | 初始化 Docker 环境（拉取沙箱镜像） |
| `make docker-start` | 启动 Docker 开发环境 |
| `make docker-stop` | 停止 Docker 开发环境 |
| `make docker-logs` | 查看 Docker 开发日志 |
| `make docker-logs-frontend` | 查看 Docker 前端日志 |
| `make docker-logs-gateway` | 查看 Docker Gateway 日志 |

## 生产 Docker 命令

| 命令 | 说明 |
|------|------|
| `make up` | 构建镜像并启动生产服务 |
| `make down` | 停止并移除生产容器 |

## 后端独立命令

在 `backend/` 目录下运行：

| 命令 | 说明 |
|------|------|
| `make install` | 安装后端依赖（uv sync） |
| `make dev` | 启动 LangGraph Server |
| `make gateway` | 启动 Gateway API |
| `make test` | 运行所有测试 |
| `make lint` | 代码检查（ruff） |
| `make format` | 代码格式化（ruff） |

## 相关参考

- [config.yaml 配置参考](config-reference.md)
- [安装指南](../../user/getting-started/installation.md)
