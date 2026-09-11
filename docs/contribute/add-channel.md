# 添加 IM 渠道

用户怎么**配置**现有渠道：见教程 [接入飞书 / Telegram](../user/tutorials/setup-im-channel.md) 与 [IM 渠道总览](../user/guides/integration/im-channels.md)。

本页面向**要在源码里加一种新渠道**的贡献者。

## 先读

1. [仓库地图](repo-map.md) — 渠道代码在 `backend/app/channels/`  
2. [RFC](rfc.md) — 新渠道通常要先提案（鉴权、事件模型、安全边界）  
3. 现有实现参考：`feishu.py` / `weixin.py` / `telegram.py` / `slack.py` 与对应 `*_registration.py`

## 建议落点

```text
backend/app/channels/
├── base.py              # 渠道抽象
├── manager.py / service.py / store.py
├── <name>.py            # 收发与协议适配
├── <name>_registration.py   # 若需要 OAuth / 凭证登记
└── … 
```

面板侧若需配置页，再改 `evopanel/`（单独说明 UI 改动与截图）。用户文档补：`docs/user/guides/integration/` 与教程链接。

## 设计检查清单

- [ ] **鉴权**：Token / 应用凭证存在哪？是否进 git？  
- [ ] **入站**：Webhook 还是长连接？本地开发如何调试？  
- [ ] **出站**：文本 / 卡片 / 文件；失败重试与限流  
- [ ] **身份映射**：IM 用户 ↔ EvoFlow 会话 / Agent  
- [ ] **安全**：默认最小权限；不在日志打出密钥与用户隐私  
- [ ] **测试**：至少有可离线跑的单元测试或录制夹具  
- [ ] **文档**：用户教程 + 本仓库 `FEISHU`/`WEIXIN` 类依赖说明若有新增依赖  

## PR 期望

- 分支：`feat/channel-<name>`  
- 链接 RFC Discussion/Issue  
- `cd backend && make format && uv run pytest`（含你加的测试）  
- 不要在 PR 里提交真实企业凭证或群聊记录  

维护者会优先看：**能否在无公网环境下开发调试**、**是否污染 harness 核心**（渠道应留在 `app` 层）。
