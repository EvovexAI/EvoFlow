/// 配置读写命令
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// 安装/升级前的清理工作：停止 Gateway、清理 npm 全局 bin 下的 evoflow 残留文件
/// 解决 Windows 上 EEXIST（文件已存在）和文件被占用的问题

fn backups_dir() -> PathBuf {
    super::evoflow_dir().join("backups")
}

#[tauri::command]
pub fn read_evoflow_config() -> Result<Value, String> {
    let dir = super::evoflow_dir();
    let path = dir.join("evoflow.json");

    // 自动创建配置文件（首次使用时）
    if !path.exists() {
        // 确保目录存在
        if !dir.exists() {
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }

        let default_config = serde_json::json!({
            "models": { "providers": {} },
            "gateway": {
                "mode": "local",
                "port": 8012,
                "auth": { "mode": "none" }
            }
        });

        let content =
            serde_json::to_string_pretty(&default_config).map_err(|e| format!("序列化失败: {e}"))?;
        std::fs::write(&path, content).map_err(|e| format!("创建配置失败: {e}"))?;

        // 返回新创建的默认配置
        return Ok(default_config);
    }

    let raw = fs::read(&path).map_err(|e| format!("读取配置失败: {e}"))?;

    // 自愈：自动剥离 UTF-8 BOM（EF BB BF），防止 JSON 解析失败
    let content = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&raw[3..]).into_owned()
    } else {
        String::from_utf8_lossy(&raw).into_owned()
    };

    // 解析 JSON，失败时尝试从备份恢复
    let mut config: Value = match serde_json::from_str(&content) {
        Ok(v) => {
            // BOM 被剥离过，静默写回干净文件
            if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
                let _ = fs::write(&path, &content);
            }
            v
        }
        Err(e) => {
            // JSON 解析失败，尝试从备份恢复
            let bak = super::evoflow_dir().join("evoflow.json.bak");
            if bak.exists() {
                let bak_raw = fs::read(&bak).map_err(|e2| format!("备份也读取失败: {e2}"))?;
                let bak_content = if bak_raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
                    String::from_utf8_lossy(&bak_raw[3..]).into_owned()
                } else {
                    String::from_utf8_lossy(&bak_raw).into_owned()
                };
                let bak_config: Value = serde_json::from_str(&bak_content)
                    .map_err(|e2| format!("配置损坏且备份也无效: 原始={e}, 备份={e2}"))?;
                // 备份有效，恢复主文件
                let _ = fs::write(&path, &bak_content);
                bak_config
            } else {
                return Err(format!("配置 JSON 损坏且无备份: {e}"));
            }
        }
    };

    // 自动清理 UI 专属字段，防止污染配置导致 CLI 启动失败
    if has_ui_fields(&config) {
        config = strip_ui_fields(config);
        // 静默写回清理后的配置
        let bak = super::evoflow_dir().join("evoflow.json.bak");
        let _ = fs::copy(&path, &bak);
        let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
        let _ = fs::write(&path, json);
    }

    Ok(config)
}

#[tauri::command]
pub fn write_evoflow_config(config: Value) -> Result<(), String> {
    let path = super::evoflow_dir().join("evoflow.json");
    // 备份
    let bak = super::evoflow_dir().join("evoflow.json.bak");
    let _ = fs::copy(&path, &bak);
    // 清理 UI 专属字段
    let cleaned = strip_ui_fields(config.clone());
    // 写入
    let json = serde_json::to_string_pretty(&cleaned).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, &json).map_err(|e| format!("写入失败: {e}"))?;

    // 同步 provider 配置到所有 agent 的 models.json（运行时注册表）
    sync_providers_to_agent_models(&config);

    Ok(())
}

/// 将 evoflow.json 的 models.providers 完整同步到每个 agent 的 models.json
/// 包括：同步 baseUrl/apiKey/api、删除已移除的 provider、删除已移除的 model、
/// 确保 Gateway 运行时不会引用 evoflow.json 中已不存在的模型
fn sync_providers_to_agent_models(config: &Value) {
    let src_providers = config
        .pointer("/models/providers")
        .and_then(|p| p.as_object());

    // 收集 evoflow.json 中所有有效的 provider/model 组合
    let mut valid_models: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(providers) = src_providers {
        for (pk, pv) in providers {
            if let Some(models) = pv.get("models").and_then(|m| m.as_array()) {
                for m in models {
                    let id = m.get("id").and_then(|v| v.as_str()).or_else(|| m.as_str());
                    if let Some(id) = id {
                        valid_models.insert(format!("{}/{}", pk, id));
                    }
                }
            }
        }
    }

    // 收集所有 agent ID
    let mut agent_ids = vec!["main".to_string()];
    if let Some(Value::Array(list)) = config.pointer("/agents/list") {
        for agent in list {
            if let Some(id) = agent.get("id").and_then(|v| v.as_str()) {
                if id != "main" {
                    agent_ids.push(id.to_string());
                }
            }
        }
    }

    let agents_dir = super::evoflow_dir().join("agents");
    for agent_id in &agent_ids {
        let models_path = agents_dir.join(agent_id).join("agent").join("models.json");
        if !models_path.exists() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&models_path) else {
            continue;
        };
        let Ok(mut models_json) = serde_json::from_str::<Value>(&content) else {
            continue;
        };

        let mut changed = false;

        if models_json
            .get("providers")
            .and_then(|p| p.as_object())
            .is_none()
        {
            if let Some(root) = models_json.as_object_mut() {
                root.insert("providers".into(), json!({}));
                changed = true;
            }
        }

        // 同步 providers
        if let Some(dst_providers) = models_json
            .get_mut("providers")
            .and_then(|p| p.as_object_mut())
        {
            // 1. 删除 evoflow.json 中已不存在的 provider
            if let Some(src) = src_providers {
                let to_remove: Vec<String> = dst_providers
                    .keys()
                    .filter(|k| !src.contains_key(k.as_str()))
                    .cloned()
                    .collect();
                for k in to_remove {
                    dst_providers.remove(&k);
                    changed = true;
                }

                for (provider_name, src_provider) in src.iter() {
                    if !dst_providers.contains_key(provider_name) {
                        dst_providers.insert(provider_name.clone(), src_provider.clone());
                        changed = true;
                    }
                }

                // 2. 同步存在的 provider 的 baseUrl/apiKey/api + 清理已删除的 models
                for (provider_name, src_provider) in src.iter() {
                    if let Some(dst_provider) = dst_providers.get_mut(provider_name) {
                        if let Some(dst_obj) = dst_provider.as_object_mut() {
                            // 同步连接信息
                            for field in ["baseUrl", "apiKey", "api"] {
                                if let Some(src_val) =
                                    src_provider.get(field).and_then(|v| v.as_str())
                                {
                                    if dst_obj.get(field).and_then(|v| v.as_str()) != Some(src_val)
                                    {
                                        dst_obj.insert(
                                            field.to_string(),
                                            Value::String(src_val.to_string()),
                                        );
                                        changed = true;
                                    }
                                }
                            }
                            // 清理已删除的 models
                            if let Some(dst_models) =
                                dst_obj.get_mut("models").and_then(|m| m.as_array_mut())
                            {
                                let src_model_ids: std::collections::HashSet<String> = src_provider
                                    .get("models")
                                    .and_then(|m| m.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|m| {
                                                m.get("id")
                                                    .and_then(|v| v.as_str())
                                                    .or_else(|| m.as_str())
                                                    .map(|s| s.to_string())
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let before = dst_models.len();
                                dst_models.retain(|m| {
                                    let id = m
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .or_else(|| m.as_str())
                                        .unwrap_or("");
                                    src_model_ids.contains(id)
                                });
                                if dst_models.len() != before {
                                    changed = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        if changed {
            if let Ok(new_json) = serde_json::to_string_pretty(&models_json) {
                let _ = fs::write(&models_path, new_json);
            }
        }
    }
}

/// 检测配置中是否包含 UI 专属字段
fn has_ui_fields(val: &Value) -> bool {
    if let Some(obj) = val.as_object() {
        if let Some(models_val) = obj.get("models") {
            if let Some(models_obj) = models_val.as_object() {
                if let Some(providers_val) = models_obj.get("providers") {
                    if let Some(providers_obj) = providers_val.as_object() {
                        for (_provider_name, provider_val) in providers_obj.iter() {
                            if let Some(provider_obj) = provider_val.as_object() {
                                if let Some(Value::Array(arr)) = provider_obj.get("models") {
                                    for model in arr.iter() {
                                        if let Some(mobj) = model.as_object() {
                                            if mobj.contains_key("lastTestAt")
                                                || mobj.contains_key("latency")
                                                || mobj.contains_key("testStatus")
                                                || mobj.contains_key("testError")
                                            {
                                                return true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    false
}

/// 清理 EvoPanel 内部字段，避免污染 evoflow.json 导致 Gateway 启动失败
/// Issue #89: version info 字段被写入 evoflow.json → Unknown config keys
fn strip_ui_fields(mut val: Value) -> Value {
    if let Some(obj) = val.as_object_mut() {
        // 清理根层级 EvoPanel 内部字段（version info 等）
        for key in &[
            "current",
            "latest",
            "recommended",
            "update_available",
            "latest_update_available",
            "is_recommended",
            "ahead_of_recommended",
            "panel_version",
            "source",
        ] {
            obj.remove(*key);
        }
        // 处理 models.providers.xxx.models 结构
        if let Some(models_val) = obj.get_mut("models") {
            if let Some(models_obj) = models_val.as_object_mut() {
                if let Some(providers_val) = models_obj.get_mut("providers") {
                    if let Some(providers_obj) = providers_val.as_object_mut() {
                        for (_provider_name, provider_val) in providers_obj.iter_mut() {
                            if let Some(provider_obj) = provider_val.as_object_mut() {
                                if let Some(Value::Array(arr)) = provider_obj.get_mut("models") {
                                    for model in arr.iter_mut() {
                                        if let Some(mobj) = model.as_object_mut() {
                                            mobj.remove("lastTestAt");
                                            mobj.remove("latency");
                                            mobj.remove("testStatus");
                                            mobj.remove("testError");
                                            if !mobj.contains_key("name") {
                                                if let Some(id) =
                                                    mobj.get("id").and_then(|v| v.as_str())
                                                {
                                                    mobj.insert(
                                                        "name".into(),
                                                        Value::String(id.to_string()),
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    val
}

#[tauri::command]
pub fn read_mcp_config() -> Result<Value, String> {
    let path = super::evoflow_dir().join("mcp.json");
    if !path.exists() {
        return Ok(Value::Object(Default::default()));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取 MCP 配置失败: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {e}"))
}

#[tauri::command]
pub fn write_mcp_config(config: Value) -> Result<(), String> {
    let path = super::evoflow_dir().join("mcp.json");
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入失败: {e}"))
}

// EvoFlow 版本列表与升级入口已移除

// EvoFlow 历史安装/卸载内部实现已移除

// EvoFlow 初始化/Node 检测旧功能已移除

#[tauri::command]
pub fn write_env_file(path: String, config: String) -> Result<(), String> {
    let expanded = if let Some(stripped) = path.strip_prefix("~/") {
        dirs::home_dir().unwrap_or_default().join(stripped)
    } else {
        PathBuf::from(&path)
    };

    // 安全限制：只允许写入 ~/.evoflow/ 目录下的文件
    let evoflow_base = super::evoflow_dir();
    if !expanded.starts_with(&evoflow_base) {
        return Err("只允许写入 ~/.evoflow/ 目录下的文件".to_string());
    }

    if let Some(parent) = expanded.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&expanded, &config).map_err(|e| format!("写入 .env 失败: {e}"))
}

// ===== 备份管理 =====

#[tauri::command]
pub fn list_backups() -> Result<Value, String> {
    let dir = backups_dir();
    if !dir.exists() {
        return Ok(Value::Array(vec![]));
    }
    let mut backups: Vec<Value> = vec![];
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取备份目录失败: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let meta = fs::metadata(&path).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        // macOS 支持 created()，fallback 到 modified()
        let created = meta
            .and_then(|m| m.created().ok().or_else(|| m.modified().ok()))
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let mut obj = serde_json::Map::new();
        obj.insert("name".into(), Value::String(name));
        obj.insert("size".into(), Value::Number(size.into()));
        obj.insert("created_at".into(), Value::Number(created.into()));
        backups.push(Value::Object(obj));
    }
    // 按时间倒序
    backups.sort_by(|a, b| {
        let ta = a.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    Ok(Value::Array(backups))
}

#[tauri::command]
pub fn create_backup() -> Result<Value, String> {
    let dir = backups_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let src = super::evoflow_dir().join("evoflow.json");
    if !src.exists() {
        return Err("evoflow.json 不存在".into());
    }

    let now = chrono::Local::now();
    let name = format!("evoflow-{}.json", now.format("%Y%m%d-%H%M%S"));
    let dest = dir.join(&name);
    fs::copy(&src, &dest).map_err(|e| format!("备份失败: {e}"))?;

    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let mut obj = serde_json::Map::new();
    obj.insert("name".into(), Value::String(name));
    obj.insert("size".into(), Value::Number(size.into()));
    Ok(Value::Object(obj))
}

/// 检查备份文件名是否安全
fn is_unsafe_backup_name(name: &str) -> bool {
    name.contains("..") || name.contains('/') || name.contains('\\')
}

#[tauri::command]
pub fn restore_backup(name: String) -> Result<(), String> {
    if is_unsafe_backup_name(&name) {
        return Err("非法文件名".into());
    }
    let backup_path = backups_dir().join(&name);
    if !backup_path.exists() {
        return Err(format!("备份文件不存在: {name}"));
    }
    let target = super::evoflow_dir().join("evoflow.json");

    // 恢复前先自动备份当前配置
    if target.exists() {
        let _ = create_backup();
    }

    fs::copy(&backup_path, &target).map_err(|e| format!("恢复失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_backup(name: String) -> Result<(), String> {
    if is_unsafe_backup_name(&name) {
        return Err("非法文件名".into());
    }
    let path = backups_dir().join(&name);
    if !path.exists() {
        return Err(format!("备份文件不存在: {name}"));
    }
    fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))
}

// Gateway 管理、模型测试等旧功能已移除

/// 检查 EvoPanel 是否有新版本（主仓库 GitHub Releases）
#[tauri::command]
pub async fn check_panel_update() -> Result<Value, String> {
    let ua = crate::commands::app_user_agent();
    let client =
        crate::commands::build_http_client(std::time::Duration::from_secs(8), Some(&ua))
            .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let sources = [(
        "https://api.github.com/repos/EvovexAI/EvoFlow/releases/latest",
        "https://github.com/EvovexAI/EvoFlow/releases",
        "github",
    )];

    let mut last_err = String::new();
    for (api_url, releases_url, source) in &sources {
        match client.get(*api_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let json: Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("解析响应失败: {e}"))?;

                let tag = json
                    .get("tag_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim_start_matches('v')
                    .to_string();

                if tag.is_empty() {
                    last_err = format!("{source}: 未找到版本号");
                    continue;
                }

                let mut result = serde_json::Map::new();
                result.insert("latest".into(), Value::String(tag));
                result.insert(
                    "url".into(),
                    json.get("html_url")
                        .cloned()
                        .unwrap_or(Value::String(releases_url.to_string())),
                );
                result.insert("source".into(), Value::String(source.to_string()));
                result.insert(
                    "downloadUrl".into(),
                    Value::String("https://www.evovexai.com".into()),
                );
                return Ok(Value::Object(result));
            }
            Ok(resp) => {
                last_err = format!("{source}: HTTP {}", resp.status());
            }
            Err(e) => {
                last_err = format!("{source}: {e}");
            }
        }
    }

    Err(last_err)
}

// === 面板配置 (evopanel.json，读取兼容 evopanel.json) ===

#[tauri::command]
pub fn read_panel_config() -> Result<Value, String> {
    let Some(path) = super::panel_config_existing_path() else {
        return Ok(serde_json::json!({}));
    };
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("解析失败: {e}"))
}

#[tauri::command]
pub fn write_panel_config(config: Value) -> Result<(), String> {
    let dir = super::evoflow_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let path = super::panel_config_primary_path();
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("写入失败: {e}"))
}

/// 前端读取：托盘 DevTools / 侧栏「会话调试」是否与 Rust 侧一致（release 默认关，debug 默认开）
#[tauri::command]
pub fn get_developer_ui_flags() -> Value {
    json!({
        "enableDevtools": super::panel_developer_enable_devtools(),
        "showSessionDebug": super::panel_developer_show_session_debug(),
    })
}

/// 测试代理连通性：通过配置的代理访问指定 URL，返回状态码和耗时
#[tauri::command]
pub async fn test_proxy(url: Option<String>) -> Result<Value, String> {
    let proxy_url = crate::commands::configured_proxy_url()
        .ok_or("未配置代理地址，请先在面板设置中保存代理地址")?;

    let target = url.unwrap_or_else(|| "https://registry.npmjs.org/-/ping".to_string());

    let ua = crate::commands::app_user_agent();
    let client =
        crate::commands::build_http_client(std::time::Duration::from_secs(10), Some(&ua))
            .map_err(|e| format!("创建代理客户端失败: {e}"))?;

    let start = std::time::Instant::now();
    let resp = client.get(&target).send().await.map_err(|e| {
        let elapsed = start.elapsed().as_millis();
        format!("代理连接失败 ({elapsed}ms): {e}")
    })?;

    let elapsed = start.elapsed().as_millis();
    let status = resp.status().as_u16();

    Ok(json!({
        "ok": status < 500,
        "status": status,
        "elapsed_ms": elapsed,
        "proxy": proxy_url,
        "target": target,
    }))
}


