# 更新厂商套餐目录（Agent Plan / Token Plan）

绑定套餐后写入的对话模型、媒体默认值、档位权益，都以 **Catalog + adapter** 为 SSOT。官方改了模型表时，按本文改仓库，再让用户「按套餐目录补齐」即可。

## 文件地图

| 厂商 | Catalog 条目 | 模型 / 能力表 | Adapter | 前端入口 |
|------|--------------|---------------|---------|----------|
| 火山方舟 Agent Plan | `plans/catalog.py` → `volcengine.agent_plan` | `plans/volc_agent_plan_models.py` | `plans/adapters/volc_agent_plan.py` | `evopanel/src/lib/plan-bundle.js`、`pages/settings/plans.js`、`pages/models.js` |
| 阿里云百炼 Token Plan | `plans/catalog.py` → `aliyun.token_plan` | `plans/aliyun_token_plan_models.py` | `plans/adapters/aliyun_token_plan.py` | 同上（按 `catalogId` 区分） |

公共：

- 注册适配器：`plans/adapters/__init__.py`
- 探测：`plans/verify.py`（按 `catalog.vendor` 分支）
- `GET /models` 404 回退：`admin/models.py` → `openai_compat_fallback_models`
- 预设快捷模型：`evopanel/src/lib/model-presets.js`

## 官方文档（核对时打开）

- 火山 Agent Plan 套餐概览：https://www.volcengine.com/docs/82379/2366394  
  （聊天 Base：`https://ark.cn-beijing.volces.com/api/plan/v3`，Key：`ark-`）
- 百炼 Token Plan 个人版：https://help.aliyun.com/zh/model-studio/token-plan-personal-overview  
  快速接入：https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start  
  （聊天 Base：`https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，Key：`sk-sp-`；媒体：`…/api/v1`）

## 更新清单（照抄改）

1. **对官方表**：增删改 `*_CHAT_MODELS`（只放对话/推理模型；图/视频/语音进 `*_CAPABILITIES.items`）。
2. **字段**：`id`（官方 Model ID）、`label`、`context_window`、`max_output`、`vision`、`reasoning`、`min_tier`、可选 `notes` / `preferred_primary` / `thinking_always_on`。
3. **能力门禁**：`*_CAPABILITIES` 里 `video` / `image` / `tts` / `asr` / `web_search` 的 `min_tier` 与 `excluded_hint`；档位权益在 `catalog.py` 的 `tiers[].entitlements`。
4. **文案**：`catalog.py` 的 `description` / `promo_hint` / `models_hint` / `price_hint` 写明同步日期。
5. **前端预设**（可选）：`model-presets.js` 里对应厂商的「推荐」列表与 `desc`。
6. **测一下**：
   - `cd backend && python -m pytest tests/test_aliyun_token_plan.py tests/test_agent_plan_vision_defaults.py -q`
   - 面板：套餐 Tab → 更换 Key / 按套餐目录补齐 → 对话模型列表是否出现新 ID。

## 约定

- **不要**在绑定向导里再让用户选手动档位；materialize 默认按目录最高档写全量模型，真实额度以控制台为准。
- 百炼个人版各档**模型表相同**（只差 Credits）：`catalog.ui.hide_tiers: true`，套餐 Tab 也不展示档位列 / 门禁。
- Key 前缀硬校验：火山 `ark-`，百炼 `sk-sp-`（勿与按量 Key 混用）。
- Token Plan 联网搜索是**模型内置工具**，不要写豆包搜索 Key；Agent Plan 仍可自动接通豆包搜索。
- 下线模型：从 chat 表删除即可；用户本地旧行不会自动删，可提示「补齐」后手动删多余卡。

## 百炼 Token Plan 速查

| 项 | 值 |
|----|-----|
| catalog_id | `aliyun.token_plan` |
| plan_family | `token_plan` |
| vendor connection key | `aliyun` |
| OpenAI Base | `…/compatible-mode/v1` |
| Anthropic Base | `…/apps/anthropic` |
| Media / TTS Base | `…/api/v1`（写入 `dashscopeBaseUrl`） |
| 个人档 | `lite` / `essential` / `standard` / `pro` |

改完后更新本文件顶部「上次核对」日期（建议在 PR 描述里写官方 changelog 链接）。

上次核对：2026-11-08
