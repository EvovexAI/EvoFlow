# 微信（个人号 / iLink）依赖说明

个人微信渠道走腾讯 **iLink Bot HTTP API**（`ilinkai.weixin.qq.com`），**没有**名为 `weixin` / `wechat` 的 PyPI 包。

## Hermes 官方要求（与 `hermes-agent` 一致）

Hermes `gateway/platforms/weixin.py` 里 `check_weixin_requirements()` **只检查两个包**，缺一不可：

```python
return AIOHTTP_AVAILABLE and CRYPTO_AVAILABLE
```

文档 `website/docs/user-guide/messaging/weixin.md` 写的是：

```bash
pip install aiohttp cryptography
# 终端 ASCII 二维码（可选）：
pip install hermes-agent[messaging]   # 额外带 qrcode
```

| 包名 | Hermes 是否硬性要求 | 用途 |
|------|---------------------|------|
| **`aiohttp`** | ✅ 是 | 连 iLink：扫码、长轮询、发消息 |
| **`cryptography`** | ✅ 是 | 媒体 CDN **AES-128-ECB** 加解密；缺了渠道直接起不来 |
| **`certifi`** | ⚠️ 未写入 check，但 `_make_ssl_connector()` 强依赖 | 校验 `ilinkai.weixin.qq.com` 的 TLS（macOS/部分 Windows 系统 CA 不够时必需） |
| **`qrcode`** | ❌ 仅 `messaging` 可选 extra | CLI 里把码画成终端字符画；**不负责联网** |

名字里和「微信」无关、但 Hermes 标成**必装**的，主要是 **`cryptography`**（以及 **`aiohttp`**）。

## EvoFlow 现状

上述包均在 `backend/pyproject.toml`；桌面安装包由 `packaging/windows/gateway.spec` 的 `collect_all` 打进 PyInstaller（含 `certifi` / `aiohttp` / `cryptography` / `qrcode`）。

扫码阶段若报 `Cannot connect to host ilinkai.weixin.qq.com:443`，与 **`cryptography` 是否安装无关**（那时还没走媒体解密），应查 **`aiohttp` + `certifi` + 网络/代理**，或设 `EVOFLOW_ILINK_IPV4_ONLY=1`。

## 不是这些

- **`evopanel-weixin`**：旧版 EvoPanel 文案里的「插件」名，当前实现是内置 Gateway + iLink，无需单独 npm/Python 插件。
- **企微**：`WeCom` / `WECOM_*` 是另一套 WebSocket 协议（Hermes `wecom.py`），与本目录 `weixin.py` 无关。

## 连通性自检

```bash
cd backend && uv run python scripts/test_ilink_connectivity.py
```

若报 `Cannot connect to host ilinkai.weixin.qq.com:443`，优先查网络/代理；可试 `EVOFLOW_ILINK_IPV4_ONLY=1`。桌面 frozen 包另需确认 `certifi` 的 `cacert.pem` 已打进包（见 `gateway.spec` / `gateway_entry._apply_bundled_certifi`）。
