# 技能（Skills）与 MCP 模块功能验证 Bug 报告（含提交后复验）

- 日期：2026-08-19
- 范围：从功能角度测试验证 `backend/packages/harness/evoflow/skills/`、`evoflow/mcp/`、`app/gateway/routers/skills.py|mcp.py|mcp_server.py`、`evoflow/admin/skills.py|mcp.py`
- 结论：**共发现 22 项缺陷**（8 项运行时实证 + 14 项代码级确认），均给出文件/函数与复现路径

---

## 一、运行时实证缺陷（已执行探针确认）

### B1.【测试基建】pytest-asyncio 未声明 → 2 个用例必失败
- **位置**：`backend/pyproject.toml`（dev 依赖缺 `pytest-asyncio`）+ `tests/test_mcp_fixes.py:91,121`
- **现象**：`pytest` 运行 `test_mcp_fixes.py` 报 `async def functions are not natively supported`，`PytestUnknownMarkWarning`。实测 `39 passed / 2 failed`。
- **影响**：纯净环境/CI 跑测试套件必然红 2 个 OAuth 并发用例。
- **复验（已修复）**：`pyproject.toml` dev 依赖现含 `pytest-asyncio>=0.24.0`，完整套件 12 文件 100 passed / 8 文件 60 passed。

### B2.【技能】UTF-8 BOM 使 SKILL.md 被静默跳过
- **位置**：`evoflow/skills/frontmatter.py` `split_skill_frontmatter`
- **现象**：内容以 `\ufeff---` 开头时不走 `---\n`/`---\r\n` 分支返回 None。实测 `split_skill_frontmatter('\ufeff---...') is None`。
- **影响**：带 BOM 的技能不出现在 `/api/skills`、无法被加载/安装，无任何日志提示。
- **复验（已修复）**：`B2 PASS`——`split_skill_frontmatter('\ufeff---...')` 解析成功且 `load_skills` 含 `bom-skill`。

### B3.【技能】安全扫描误报文档中提及的 curl
- **位置**：`evoflow/skills/security.py` `_UNIVERSAL_PATTERNS` 含 `curl\s+https?://`
- **现象**：SKILL.md 正文写「输入 `curl https://example.com/install.sh`」作为说明步骤也被拦截（is_code=False 时通用模式仍生效）。实测确认。
- **影响**：大量合法安装教程型技能创建/安装被误拒。
- **复验（已修复，但见 NEW-FETCH）**：`curl`/`wget` 已移入 `_CODE_PATTERNS`（仅代码文件扫描）。文档 `.md` 提及 curl 不再误报（`B3 PASS`），代码文件仍拦截。

### B4.【MCP】`_install_cmd_to_config("npx")` 生成无效配置
- **位置**：`evoflow/mcp/market.py` `_install_cmd_to_config`
- **现象**：包名缺失时仍产出 `{"command":"npx","args":["-y"]}`，启动时 npx 无目标包直接失败。实测确认。
- **影响**：热门市场条目 install_cmd 为空/仅 `npx` 时一键安装必坏。
- **复验（已修复）**：`B4 PASS`——裸 `npx`/`npx -y` 现返回 `enabled=False, command=''`；`npx -y <pkg>` 正常。

### B5.【MCP】状态快照 transport 误标（http 显示为 sse）
- **位置**：`evoflow/mcp/status.py` `build_mcp_status_snapshot`
- **现象**：`type=http` 的服务器 transport 显示 `sse`（仅按 `cfg.get("url")` 判断）。实测 `{'srv-http':'sse','srv-sse':'sse'}`。
- **影响**：前端/监控展示的传输类型错误，误导排障。
- **复验（已修复）**：`B5/B5b/B5c/B5d PASS`——type=http→http、type=sse→sse、url 以 `/sse` 结尾→sse、无 url→stdio 均正确。

### B6.【技能】skill URI 放行 `..` 路径穿越
- **位置**：`evoflow/skills/skill_uri.py` `parse_skill_uri`
- **现象**：`skill:abc/../../etc/passwd` 解析为 `('abc','../../etc/passwd')`，后续 `resolve_skill_uri` 虽用 `relative_to(base)` 兜底，但解析层本应拒绝。实测确认解析层放行。
- **影响**：越权面扩大，依赖下游单一校验，属纵深防御缺陷。
- **复验（已修复）**：`B6/B6b/B6c PASS`——解析层与 resolve 层均拒绝 `..`，正常相对路径仍解析。

### B7.【MCP】`_looks_like_server_entry` 仅凭 args 误判为服务器
- **位置**：`evoflow/mcp/config_io.py`
- **现象**：`{"args":["-y"]}`（无 command/url）被判为合法服务器条目。实测确认。
- **影响**：损坏/半写配置被当作有效 MCP 服务器导入，加载时报错。
- **复验（已修复，但引入回归 NEW-REC）**：`B7/B7b/B7c PASS`——args-only 不再判为服务器、带 command 仍判定、unwrap 丢弃 args-only 条目。**但**混合/全坏条目在 `unwrap_mcp_servers_dict` 触发无限递归（见 NEW-REC）。

### B8.【MCP】stdio 无 command 配置不被拒绝
- **位置**：`evoflow/mcp/tools.py` `_normalize_mcp_server_config`
- **现象**：`{"type":"stdio"}` 返回 `{'command':'','args':[]}` 而非 None/报错。实测确认。
- **影响**：空命令服务器进入连接流程，产出无意义错误，状态面板误报。
- **复验（已修复）**：`B8/B8b PASS`——stdio 无 command 返回 None，有 command 正常。

### B9.【MCP】async handler 被 close 丢弃
- **位置**：`evoflow/capability/registry.py` `dispatch`（`mcp/server.py` 复用）
- **现象**：capability 注册 async handler 时，`dispatch` 直接 `result.close()` 并返回 `{"error":"... async handler but dispatch is synchronous"}`。实测构造 async-cap 调用返回该错误。
- **影响**：任何异步能力经 MCP `tools/call` 调用必然失败，无运行机会。
- **复验（已修复）**：`B9 PASS`——async handler 经 dispatch 正常返回 `{"ok": "async result"}`。

---

## 二、代码级确认缺陷（高置信，读码核实）

### B10.【技能】PUT /api/skills 更新后未清缓存 → 返回 stale enabled
- **位置**：`app/gateway/routers/skills.py` `update_skill`
- **现象**：写入 SQLite 后调用 `load_skills()`，但未 `clear_skills_cache()`，`load_skills` 命中 mtime 缓存返回旧 enabled。
- **影响**：API 响应与库中真实状态不一致，前端开关失效。
- **复验（已修复）**：`B10 PASS`——`set_skill_enabled` 后 `load_skills` 即时反映（清缓存生效）。

### B11.【技能】POST /api/skills/install 未清缓存 → 新技能不可见
- **位置**：`app/gateway/routers/skills.py` `install_skill`
- **现象**：`install_skill_from_archive` 落盘后未清缓存；与 `install-local`/`install-from-path`/`install-from-market` 均调用 `clear_skills_cache()` 不一致。
- **影响**：安装成功但列表/详情查不到，需重启进程。
- **复验（已修复）**：`B11 PASS`——安装后 `load_skills` 立即可见。

### B12.【技能】skill_manager delete 残留 SQLite registry
- **位置**：`evoflow/tools/builtins/skill_manager_tool.py` `_delete_skill`
- **现象**：只 `shutil.rmtree`，未删 `cfg_repo.delete_skill_registry(name)` / extensions_config 条目（对比 `admin/skills.py delete_skill` 有清理）。
- **影响**：删除后 registry 残留脏数据，重启后可能复活/状态错乱。
- **复验（已修复）**：`B12 PASS`——delete 后 SQLite registry 无残留（现 `_delete_skill` 调 `cfg_repo.delete_skill_registry(name)` + 清理 extensions_config）。

### B13.【技能】名称校验两套规则冲突
- **位置**：`skill_manager_tool._validate_skill_name`（允许 `_`/`.`/连续`--`）vs `validation._validate_skill_frontmatter`（仅 `[a-z0-9-]+`）
- **现象**：实测 `my_skill`、`my.skill` 在 skill_manager 通过，frontmatter 校验拒绝。
- **影响**：用 skill_manager 创建 `my_skill` 后，重新加载/市场重装校验失败，技能可能写一半。
- **复验（已修复）**：`B13/B13b/B13c PASS`——`my_skill` 被拒、`my-skill` 通过、连续 `--` 被拒。

### B14.【技能】admin `install_skill` 把 dict 当 skill_name 返回
- **位置**：`evoflow/admin/skills.py` `install_skill`
- **现象**：`skill_name = install_skill_from_archive(archive)` 实为 dict `{success,skill_name,message}`，返回值 `"skill_name": skill_name` 存的是整个 dict。
- **影响**：CLI `evoflow skills install` 返回结构损坏，下游读取 skill_name 出错。
- **复验（已修复）**：`B14 PASS`——admin install_skill 返回 skill_name 为字符串。

### B15.【技能】admin `install_skill_from_market` 同样返回 dict（提交后复验：仍存在新形态 bug）
- **位置**：`evoflow/admin/skills.py` `install_skill_from_market`
- **现象（旧）**：同 B14，`skill_name` 字段存 dict。
- **复验（部分修复 + 新实锤）**：返回 dict 结构已修，但 `install_skill_from_market` 用 `tempfile.NamedTemporaryFile(suffix=".skill")` 写临时文件，而 `install_skill_from_archive` 强制要求 `.zip` 后缀 → **必抛 `ValueError: File must have .zip extension`**。实测 `B15 FAIL`、`NEW-B15A FAIL`、`NEW-ADMIN-ERR FAIL`（admin 非 zip 抛原始 ValueError 而非归一 ValidationError）。
- **影响**：CLI/admin 市场安装路径 100% 失败（gateway 路由用 `.zip` 正常，admin 路径不一致）。

### B16.【MCP】Windows 下 shell 提示用 POSIX 单引号，cmd 无法执行
- **位置**：`evoflow/mcp/prompt_section.py` `_shell_quote`（`shlex.quote`）
- **现象**：Windows 返回 `'npx'`（单引号），cmd 不识别单引号引用的命令。
- **影响**：mcp-terminal 提示的 `tools/list` 管道命令在 Windows 直接失败。
- **复验（部分修复 + 新实锤）**：Windows 分支改用双引号且对内部引号**加倍**（`"` → `""`）。但 JSON 载荷中所有双引号被加倍后经 `echo ... | <cmd>` 管道实测还原失败（`NEW-16 FAIL`，输出 `\\"…\\"`）。POSIX 分支 `shlex.quote` 正常（`B16b-fix PASS`）。

### B17.【MCP】市场配置 env 占位符 `$VAR` 不被后端解析
- **位置**：`evoflow/mcp/market.py` `_env_from_glama_schema`/`_env_from_package` 产出 `$KEY`，`tools.py`/`client.py` 未做 `resolve_env_variables`
- **现象**：仅前端做替换；直接走 CLI/admin 导入时 env 保持字面 `$VAR`。
- **影响**：非 UI 通道配置的密钥占位符不生效。
- **复验（已修复）**：`B17/B17b PASS`——`resolve_env_variables` 解析 `$VAR`，`_normalize_mcp_server_config` 解析 env 占位符（但见 ENV-UNSET）。

### B18.【MCP】GET /api/mcp/config 配置损坏时无兜底 500
- **位置**：`app/gateway/routers/mcp.py` `get_mcp_configuration` / `status.build_mcp_status_snapshot` 无 try/except
- **现象**：SQLite/文件配置损坏时 `asyncio.to_thread` 抛异常 → 500。
- **影响**：配置页打不开且无降级信息。
- **复验（已修复）**：`B18 PASS`——status 快照异常时路由降级而非 500（`init_error=Failed to build MCP status snapshot`）。

### B19.【MCP】OAuth refresh_token 刷新后不更新持久 refresh_token
- **位置**：`evoflow/mcp/oauth.py` `_fetch_token`
- **现象**：刷新返回的新 `refresh_token` 仅缓存 access_token，持久配置不更新。
- **影响**：refresh_token 轮换制服务（如部分 OIDC）下次刷新必然失败。
- **复验（已修复）**：`B19 PASS`——refresh_token 轮换后持久化到配置（`_persist_rotated_refresh_token` 落库）。

### B20.【MCP】`reset_mcp_tools_cache` 重置 `_async_init_lock` 存在跨 loop 竞态
- **位置**：`evoflow/mcp/cache.py` `reset_mcp_tools_cache` 把 `_async_init_lock=None`
- **现象**：旧锁绑定已关闭 loop，新 loop 下重新 create 时若存在并发 `initialize_mcp_tools` 调用，可能在旧 loop 上 await 卡死。
- **影响**：配置更新+热重载场景偶发 MCP 初始化挂起。
- **复验（已修复）**：`B20-fix PASS`——两个独立 loop 各建锁且绑定各自 loop_id（`_get_async_init_lock` 惰性重建）。早期 B20 FAIL 为探针误报（同线程 asyncio.run 复用 loop id）。

### B21.【MCP】`build_server_params` 转发 timeout/cwd 与 tools.py 注释矛盾
- **位置**：`evoflow/mcp/client.py`（转发 `timeout`/`cwd`）vs `tools.py _normalize_mcp_server_config`（注释称 stdio 不传 timeout 避免 adapter 报错）
- **现象**：两条构建路径对 stdio 的 timeout/cwd 处理不一致。
- **影响**：经 client.py 路径构建的 stdio 服务器可能因 adapter 版本差异在创建 session 时抛 `unexpected keyword argument 'timeout'`。
- **复验（已修复一半，见 NEW-21/NEW-TIMEOUT-EXTRA）**：`B21 PASS`——`client.build_server_params` stdio 分支已不转发 timeout/cwd。但 `tools._normalize_mcp_server_config` stdio 分支仍转发 `cwd`（`NEW-21 FAIL`），http/stdio 对 timeout 处理不一致（`NEW-TIMEOUT-EXTRA FAIL`）。

### B22.【技能】GET /api/skills 大小写敏感与 find_skill_directory 不一致
- **位置**：`app/gateway/routers/skills.py` `get_skill`（`s.name == skill_name` 精确匹配）vs `loader.find_skill_directory`（lower() 不敏感）
- **现象**：前端/调用方传大写名时 get 404，但 skill_uri 能找到。
- **影响**：同名字不同大小写时行为不一致，GET 详情 404。
- **复验（部分修复，见 NEW-PUT）**：`B22 PASS`——`admin get_skill` 大写名可查到；GET /api/skills/BOM-SKILL 200。**但** PUT/DELETE 路由仍精确匹配 `s.name == skill_name` → 大写 404（`NEW-PUT FAIL`）。

---

## 三、验证方法与证据

- 运行 `pytest tests/test_skill_fixes.py test_mcp_fixes.py test_skill_uri.py ...` → 完整套件 12 文件 **100 passed**、另一批 8 文件 **60 passed**（B1 已修复）
- 运行时探针脚本 6 批（`backend/_functional_reverify*.py`，隔离 EVOFLOW_HOME/SKILLS_PATH）实证 B2–B22 状态
- 网关 `/api/skills` 实测 198 技能、enabled_only 197 正常（该点无缺陷）
- MCP `/mcp` `tools/list`/`tools/call` 基础路由正常（未知工具返回结构化错误，无缺陷）
- 所有缺陷均定位到文件+函数，可复现

---

## 四、修复优先级建议

- **P0（立即）**：NEW-REC（unwrap 递归爆栈）、B15 新形态（admin 市场安装 .skill vs .zip 必失败）
- **P1（本周）**：NEW-PUT（PUT/DELETE 大写 404）、NEW-16（Windows 引号加倍）、NEW-T（超时下限 45s）、NEW-FETCH/NEW-ON（安全扫描误报）、NEW-ADMIN-UNWRAP、NEW-TOOLPREFIX-ORDER、NEW-TIMEOUT-EXTRA、NEW-RESET-WARMUP
- **P2（排期）**：NEW-21（cwd 转发）、NEW-NAME-DIR/NEW-NAME-DIR2（name/dir 不一致 + registry orphan）、NEW-NO-BODY（空正文校验）、NEW-BLANK-CMD（空 install_cmd）、NEW-DISABLED-TOOLS（disabled 仍显示缓存工具）、NEW-LAY（布局校验不一致）、NEW-STALE（DB 直改不清缓存）、ENV-UNSET（未设环境变量置空串）

---

## 五、提交后复验结论（HEAD=5409f62a，2026-08-19）

> 用户已用其他客户端修复并提交（工作区无未提交改动点），本复验针对**当前已提交代码**（HEAD `5409f62a`，含 `b7fb10fe` fix: harden admin/knowledge/MCP validation）。方法：6 批功能探针（真实运行时调用 + 隔离环境）+ 逐文件源码核对。

### 5.1 B1–B22 状态总表

| 编号 | 缺陷 | 复验状态 |
|---|---|---|
| B1 | pytest-asyncio 未声明 | ✅ 已修复 |
| B2 | UTF-8 BOM 技能被跳过 | ✅ 已修复 |
| B3 | 安全扫描误报文档 curl | ✅ 已修复（`fetch` 仍误报，见 NEW-FETCH） |
| B4 | 裸 npx 无效配置 | ✅ 已修复 |
| B5 | transport 误标 | ✅ 已修复 |
| B6 | skill URI `..` 穿越 | ✅ 已修复 |
| B7 | args-only 误判服务器 | ✅ 已修复（**引入 NEW-REC 回归**） |
| B8 | stdio 无 command 不拒绝 | ✅ 已修复 |
| B9 | async handler 被丢弃 | ✅ 已修复 |
| B10 | PUT 后 stale enabled | ✅ 已修复 |
| B11 | 安装后不可见 | ✅ 已修复 |
| B12 | delete 残留 registry | ✅ 已修复 |
| B13 | 名称校验冲突 | ✅ 已修复 |
| B14 | admin install 返回 dict | ✅ 已修复 |
| B15 | admin 市场安装 | ⚠️ 返回结构已修，**新形态仍坏**（.skill vs .zip 必失败） |
| B16 | Windows 单引号 | ⚠️ 双引号分支已加，**JSON 引号加倍仍破坏管道**（NEW-16） |
| B17 | env 占位符不解析 | ✅ 已修复（未设变量置空串，见 ENV-UNSET） |
| B18 | status 快照 500 | ✅ 已修复 |
| B19 | refresh_token 不持久化 | ✅ 已修复 |
| B20 | 跨 loop 锁竞态 | ✅ 已修复 |
| B21 | client/tools 路径不一致 | ⚠️ client 已修，**tools stdio 仍转发 cwd**（NEW-21/NEW-TIMEOUT-EXTRA） |
| B22 | GET 大小写敏感 | ⚠️ GET/admin 已修，**PUT/DELETE 仍精确匹配**（NEW-PUT） |

### 5.2 提交后仍存在的缺陷（探针实证 + 代码确认）

| 编号 | 缺陷 | 证据 | 严重度 |
|---|---|---|---|
| NEW-REC | `unwrap_mcp_servers_dict` 无限递归爆栈（混合/全坏 mcpServers 条目） | probe1/probe2 RecursionError，config_io.py L41/L46 | 🔴 严重 |
| NEW-PUT | PUT /api/skills/BOM-SKILL（大写）404；DELETE 同源 | probe1 FAIL code=404 | 🟠 高 |
| NEW-16 | Windows `_shell_quote` JSON 引号加倍 → echo 管道损坏 | probe1/probe2 FAIL，cmd 实测 `\\"` | 🟠 高 |
| NEW-T | `_per_server_timeout_sec` max(45,cfg) 抬底，3s/5s 无效 | probe1/probe2 got=45.0 | 🟠 高 |
| B15' | admin `install_skill_from_market` .skill 临时文件 vs .zip 要求 | probe3/probe4/probe6 FAIL | 🔴 严重 |
| NEW-FETCH | 文档提及 `fetch('https://…')` 被通用扫描误拦 | probe4 FAIL | 🟠 高 |
| NEW-ON | `\bon\w+\s*=` 过宽，`once=`/`on=` 误判 | probe4 FAIL | 🟠 高 |
| NEW-ADMIN-UNWRAP | admin `set_mcp_config` 不 unwrap Cursor mcpServers | probe4 FAIL names=['mcpServers'] | 🟠 高 |
| NEW-TOOLPREFIX-ORDER | my/my_server 共存归一结果依赖 dict 顺序 | probe4 FAIL orderA≠orderB | 🟡 中 |
| NEW-TIMEOUT-EXTRA | http 转发 timeout、stdio 不转发，两分支不一致 | probe4 FAIL http=12/stdio=None | 🟡 中 |
| NEW-RESET-WARMUP | 重复 reset 重复调度 warmup（created=3 无去重） | probe4 FAIL | 🟡 中 |
| NEW-NAME-DIR | create(name=dir) 与 frontmatter(name=front) 不一致 | probe5 FAIL | 🟡 中 |
| NEW-NAME-DIR2 | delete(front-name) 后 registry 残留 param-dir orphan | probe6 FAIL | 🟡 中 |
| NEW-NO-BODY | frontmatter 后无正文 validation 判定有效 | probe5 FAIL | 🟡 中 |
| NEW-BLANK-CMD | 空 install_cmd 产出 enabled=True 无 command | probe6 FAIL + probe4 MKT-BLANK×3 | 🟡 中 |
| NEW-DISABLED-TOOLS | 禁用 server 的 status 仍显示缓存工具 | probe6 FAIL load=disabled, tools=1 | 🟡 中 |
| NEW-LAY | 安装宽松布局接受 engine/ vs skill_manager 严格布局拒绝 | probe2 NEW-LAY FAIL / probe6 NEW-INSTALL-ENGINE PASS | 🟡 中 |
| NEW-STALE | 只改 DB enabled 不清缓存 → load_skills 旧值 | probe1 FAIL loaded.enabled=True | 🟡 中 |
| ENV-UNSET | `resolve_env_variables` 未设环境变量置空串（占位符丢失） | probe2 FAIL {'env':{'K':''}} | 🟡 中 |

### 5.3 探针误报 / 非产品 bug（已甄别）

- **B16b / B20 初始 FAIL**：探针断言方向问题，修正测量后 PASS（`shlex.quote` 纯 token 不加引号属正常；asyncio.run 同线程复用 loop id 属误报）。
- **ROUTER KeyError: 'enabled'**：TestClient 路由级验证的环境问题（探针直连 router 时扩展配置未初始化），GET 本身已 200。
- **NEW-PUT-ROUTE AttributeError: no attribute 'routes'**：探针误用 `app.gateway.routers.mcp.routes`（应为 router），探针自身错误。
- **probe_cache_stale AttributeError**：探针误从 `evoflow.mcp.cache` 找 `mcp_config_stale`（实际在 `status.py`）。
- **probe_scanner_code_vs_doc FileNotFoundError**：探针未创建 `scripts/` 目录，非产品问题。
- **NEW-OAUTH-LOOP ConnectError getaddrinfo**：探针触发真实网络请求（token_url 不可达），跨 loop 锁本身未报绑定错误——按 `asyncio.Lock` 惰性绑定语义不构成确认 bug。

### 5.4 复验方法记录

- 探针：`backend/_functional_reverify{1..6}.py`（隔离 `EVOFLOW_HOME`/`EVOFLOW_SKILLS_PATH` → `tempfile.mkdtemp`，真实调用 admin/MCP/路由层函数）
- 探针环境：`sys.path.insert(0, "packages/harness")` + `sys.path.insert(0, ".")`
- 汇总：1批 44=39P/5F，2批 25=21P/4F，3批 15=13P/2F，4批 20=13P/7F，5批 12=7P/5F，6批 9=4P/5F（FAIL 含上述误报与探针错误，甄别后真实残留见 5.2）
