# 技能（Skills）与 MCP 模块 功能回归再验证报告

- 日期：2026-08-19
- 验证对象：`backend/packages/harness/evoflow/skills/`、`evoflow/mcp/`、`app/gateway/routers/skills.py|mcp.py|mcp_server.py`、`evoflow/admin/skills.py|mcp.py`
- 基线：HEAD=`b7fb10fe`（修复提交），**当前工作区 skills/mcp 源码无新增改动**
- 方法：**6 批隔离环境功能探针**（`EVOFLOW_HOME`/`EVOFLOW_SKILLS_PATH` 指向临时目录，真实调用函数/路由/CLI/安全扫描，观察行为而非 grep），共 **125 项断言**；另跑全量测试套件 **100 passed**
- 结论：B1–B22 大部分已修复生效（实测 PASS）；但发现 **5 项修复不彻底 + 17 项新增/遗留，合计 22 项可复现问题**

---

## 一、实测已修复（功能实证 PASS）

| 编号 | 缺陷 | 实证 |
|---|---|---|
| B1 | pytest-asyncio 缺声明 | 安装后 `test_mcp_fixes.py` 14 passed |
| B2 | UTF-8 BOM 跳过 | BOM 前缀 frontmatter 可解析，带 BOM 技能进 `load_skills` |
| B4 | `_install_cmd_to_config("npx")` 无包名 | 已禁用并置空 command |
| B5 | status transport 误标 | `_infer_mcp_transport` 正确区分 http/sse/stdio |
| B6 | skill_uri `..` 穿越 | 解析层+resolve 层均拒绝，正常相对路径仍可解析 |
| B7 | args-only 误判服务器 | `_looks_like_server_entry` 仅凭 command/url 判定（见回归 NEW-REC） |
| B8 | stdio 无 command 不拒绝 | `_normalize_mcp_server_config` 返回 None |
| B9 | async handler 被 close 丢弃 | `tools/call` 正常返回 `{"ok":"async result"}` |
| B10 | PUT 未清缓存 | `set_skill_enabled` 后 `load_skills` 即时反映 |
| B11 | install 未清缓存 | 安装后 `load_skills` 立即可见，无需重启 |
| B13 | 名称规则冲突 | `my_skill`/`a--b` 被拒，`my-skill` 通过 |
| B14 | admin install_skill 返回 dict | `skill_name` 为字符串 |
| B17 | env `$VAR` 占位符 | `resolve_env_variables` 正确解析（见 NEW-ENV 未设变量场景） |
| B18 | GET /api/mcp/config 500 | snapshot 异常时降级返回 `init_error`，不 500 |
| B19 | refresh_token 轮换不持久化 | 轮换后 `_persist_rotated_refresh_token` 落库生效 |
| B20 | cache 锁跨 loop 竞态 | 独立 loop 各建锁且绑定各自 `_evoflow_loop_id`（实测 PASS） |
| B21 | client stdio 转发 timeout/cwd | `build_server_params` stdio 不转发（tools 路径不一致见 NEW-TIMEOUT-EXTRA） |
| B22 | get_skill 大小写敏感 | admin+GET 路由 lower() 归一（PUT/DELETE 未修，见 NEW-PUT） |

---

## 二、修复不彻底（5 项）

### R1.【严重/崩溃】unwrap_mcp_servers_dict 无限递归爆栈（B7 修复引入回归）
- **位置**：`evoflow/mcp/config_io.py` `unwrap_mcp_servers_dict`（L39-48）
- **现象**：当 `{"mcpServers": {...}}` 内**任意一个条目**是 args-only（无 command/url）时，走 `return unwrap_mcp_servers_dict({"mcpServers": inner})` 分支，`inner` 里含坏条目 → 再次命中同一分支 → **无限递归 RecursionError**。全坏条目同样爆栈。
- **实测**：`RecursionError: maximum recursion depth exceeded`（混合条目 1 合法+1 坏 / 全坏均复现）。
- **影响**：`load_mcp_config` → `unwrap_mcp_servers_dict` 是 MCP 加载主路径；只要 mcp.json/SQLite 里有 1 个半写条目，**整个 MCP 加载崩溃**。这是本次最严重回归。

### R2. admin install_skill_from_market 必失败（B14/B15 修复不完整）
- **位置**：`evoflow/admin/skills.py` `install_skill_from_market`
- **现象**：下载后写临时文件用 `NamedTemporaryFile(suffix=".skill")`，而 `install_skill_from_archive` 强制要求 `.zip` 后缀 → `ValueError: File must have .zip extension`。
- **实测**：mock 网络下载合法 zip 后仍抛 `ValueError: File must have .zip extension`。
- **对照**：gateway 路由 `install_skill_from_market` 用 `suffix=".zip"` 正确，admin CLI 路径错误。

### R3. Windows shell_quote 对 JSON 载荷双引号加倍（B16 修复不彻底）
- **位置**：`evoflow/mcp/prompt_section.py` `_shell_quote` Windows 分支
- **现象**：`text.replace('"', '""')` 把 `{"jsonrpc":"2.0"...}` 变成 `"{""jsonrpc"":""2.0""...}"`；cmd `echo "{""jsonrpc""...}" | npx ...` 实测还原为 `\"{\"\"jsonrpc\"\"...}\"`（反斜杠转义），**JSON 载荷损坏**，`tools/list` 管道在 Windows 不可用。
- **实测**：`cmd /c echo {q} | findstr jsonrpc` 输出 `\\"{\\"\\"jsonrpc\\"...` 而非原始 JSON。

### R4. 路由 PUT/DELETE 大小写仍敏感（B22 只修 GET/admin）
- **位置**：`app/gateway/routers/skills.py` `update_skill`/`delete_skill`
- **现象**：`s.name == skill_name` 精确匹配；`GET /api/skills/BOM-SKILL` 200，但 `PUT/DELETE /api/skills/BOM-SKILL` 404 `Skill 'BOM-SKILL' not found`。
- **实测**：PUT 大写 404，GET 大写 200，行为不一致。

### R5. security 文档仍误拦 fetch（B3 只移了 curl/wget）
- **位置**：`evoflow/skills/security.py` `_UNIVERSAL_PATTERNS`
- **现象**：`fetch\s*\(\s*["']https?://` 仍在 universal 列表；SKILL.md 写「调用 fetch('https://api...')」即被误拦（is_code=False）。
- **实测**：`scan_for_security_issues(doc, is_code=False)` 命中 `fetch\s*\(...https?://`。

---

## 三、新增/遗留（17 项）

### N1. 只改 DB enabled 不清缓存 → load_skills 返回 stale
- **位置**：`evoflow/skills/loader.py`（mtime 缓存只感知文件变化）
- **实测**：`cfg_repo.set_skill_enabled("x", False)`（不改文件、不清缓存）后 `load_skills` 仍返回旧 enabled=True。mtime 缓存不感知 SQLite 变化。

### N2. resolve_env_variables 未设环境变量 → 空串静默丢失
- **位置**：`evoflow/config/extensions_config.py` `resolve_env_variables`
- **实测**：`{"K": "$NOT_SET_VAR_XYZ"}` → `{"K": ""}`（非保持字面 `$VAR`）。密钥占位符未注入时静默变空串，难以排查。

### N3. \bon\w+\s*= 误报普通文本
- **位置**：`evoflow/skills/security.py` `_UNIVERSAL_PATTERNS`
- **实测**：文档「once=true 时执行；on=1 表示开」被报 `\bon\w+\s*=`。

### N4. admin set_mcp_config 不 unwrap Cursor 格式
- **位置**：`evoflow/admin/mcp.py` `set_mcp_config`
- **实测**：传 `{"mcpServers": {"gh": {...}}}` → 存为名为 `mcpServers` 的单服务器（names=`['mcpServers']`）。gateway 路由有 `unwrap_mcp_servers_dict`，admin 无。

### N5. MCP 工具名归一与 dict 顺序相关
- **位置**：`evoflow/mcp/tools.py` `_normalize_mcp_tool_names`
- **实测**：server `my` 与 `my_server` 共存时，`my_server_read_file` 在 `{"my":{}, "my_server":{}}` 顺序下归为 `my__server_read_file`，反序则为 `my_server__read_file`。前缀匹配不按最长前缀。

### N6. http 与 stdio 对 timeout 处理不一致
- **位置**：`evoflow/mcp/tools.py` `_normalize_mcp_server_config`
- **实测**：`type=http` 转发 `timeout=12`，`type=stdio` 丢弃 timeout（注释仅说 stdio 不传）。两条构建路径行为不一致（client 分支注释 vs tools 分支逻辑）。

### N7. 重复 reset 重复调度 warmup
- **位置**：`evoflow/mcp/cache.py` `reset_mcp_tools_cache` → `schedule_mcp_tools_warmup()`
- **实测**：连续 3 次 `reset_mcp_tools_cache()` → 创建 3 个 warmup 任务。配置热更新频繁时任务堆积。

### N8. skill_manager create 参数 name 与 frontmatter name 脱钩
- **位置**：`evoflow/tools/builtins/skill_manager_tool.py` `_create_skill`
- **实测**：`_create_skill("dir-name", content_with_name=front-name)` → 目录 `dir-name` 存在、frontmatter name=`front-name`；`load_skills` 只列出 `front-name`，`find_skill_directory("dir-name")` 与加载名不一致，`dir-name` 成为孤儿目录。

### N9. status 与 prompt 对同一配置 transport 显示不一致
- **位置**：`evoflow/mcp/status.py` `_infer_mcp_transport` vs `evoflow/mcp/prompt_section.py` `build_mcp_skill_prompt_section`
- **实测**：`type=http, url=https://x/mcp/sse` → status 显示 `http`，prompt 显示 `http/sse`。

### N10. frontmatter 后无正文仍判 valid
- **位置**：`evoflow/skills/validation.py` `_validate_skill_frontmatter`
- **实测**：`---\nname: x\ndescription: d\n---\n`（无正文）→ `Skill is valid!`。与 skill_manager 的 `_validate_frontmatter`（要求 body 非空）不一致。

### N11. 普通文档误报面（fetch/once=//etc/passwd）
- **位置**：`evoflow/skills/security.py`
- **实测**：文档样本 `fetch('https://...')`/`once=true`/`参见 /etc/passwd` 在 is_code=False 下全被拦。安装教程型技能误拒面大。

### N12. admin install_skill 非 zip 异常契约不一致
- **位置**：`evoflow/admin/skills.py` `install_skill`（转 `install_skill_from_archive` 抛原生 `ValueError`）
- **实测**：非 zip 抛 `ValueError: File must have .zip extension`，而非 admin 层统一的 `ValidationError`。CLI 错误处理契约破坏。

### N13. OAuthTokenManager 跨 loop 使用报错
- **位置**：`evoflow/mcp/oauth.py` `__init__` 急切创建 `asyncio.Lock`
- **实测**：manager 在 loop A 构造、loop B 使用 → `ConnectError`（锁绑定已关闭 loop）。未做惰性/按 loop 重建（对比 cache.py 已修）。

### N14. 禁用 server 的 status 仍显示残留缓存工具
- **位置**：`evoflow/mcp/status.py` `build_mcp_status_snapshot`
- **实测**：`enabled=False` 的 server 显示 `load_status=disabled` 但 `tool_count=1, tools=[...]`（残留缓存中已加载工具）。禁用后工具计数/列表不归零。

### N15. 空 install_cmd 产出坏配置（B4 只修 npx 无包名）
- **位置**：`evoflow/mcp/market.py` `_install_cmd_to_config`
- **实测**：`_install_cmd_to_config("")` → `{"enabled": True, "description": ""}`（无 command/type）。B4 只覆盖 `npx` 无包名分支，空串/None 未处理。

### N16. name/dir 不一致 → delete 后 registry 孤儿残留
- **位置**：`evoflow/tools/builtins/skill_manager_tool.py`（`_enable_skill_after_create(name)` 用参数名注册）
- **实测**：`_create_skill("param-dir", frontmatter_name=real-front)` → registry 有 `param-dir`；按加载名 `delete("real-front")` 后 registry 仍残留 `param-dir`（孤儿条目）。

### N17. _per_server_timeout_sec 无法设短超时
- **位置**：`evoflow/mcp/tools.py` `_per_server_timeout_sec`
- **实测**：配置 `timeout=5`（或 3s）被 `max(45, cfg)` 抬升为 45s，无法设置短于 45s 的超时；仅 >45s 生效。默认 45s。

---

## 四、验证方法

- 全量测试套件：`pytest tests/test_skill_fixes.py test_mcp_fixes.py test_skill_uri.py test_skill_uri_errors.py test_mcp_config_io.py test_mcp_market.py test_user_skills_install.py test_preferred_skills_allowlist.py test_mcp_skill_prompt.py test_skill_command_paths.py test_agent_mcp_binding.py test_cli_admin.py` → **100 passed**
- 功能探针：`backend/_functional_reverify.py` ~ `_functional_reverify6.py`（隔离环境，真实调用），共 125 项断言，其中 FAIL/EXC 与上述 22 项一一对应
- 探针脚本保留在工作区，可随时复现

## 五、优先级建议

- **P0（崩溃/数据损坏）**：R1 递归爆栈、N15 空 install_cmd 坏配置、N1 stale enabled
- **P1（功能断裂）**：R2 市场安装必失败、R3 Windows 管道损坏、R4 PUT/DELETE 404、R5 fetch 误拦、N5 工具名顺序相关、N14 禁用后残留
- **P2（体验/一致性）**：N2–N13、N16、N17
