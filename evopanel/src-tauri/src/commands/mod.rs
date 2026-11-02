use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

pub mod app_server;
pub mod assistant;
pub mod backend;
pub mod boot_cycle;
pub mod browser_embed;
pub mod browser_embed_bridge;
#[cfg(target_os = "windows")]
pub mod browser_cdp;
#[cfg(target_os = "windows")]
pub mod browser_cdp_server;
pub mod config;
pub mod ui_extensions;
pub mod gateway;
pub mod log_files;
pub mod logs;
pub mod mcp_market;
pub mod update;
pub mod cua_glow_overlay;
pub mod voice_overlay;
pub mod wake_kws;

/// Per-profile subdirectory under `evoflow_dir()`. Lives next to the per-profile
/// `evopanel.json`, `backend-runtime.json`, and EVOFLOW_HOME. Multiple profiles may
/// coexist (installed client + dev client) without trampling each other.
pub const PROFILES_SUBDIR: &str = "profiles";

/// Default profile id used when neither `EVOFLOW_PROFILE` env nor
/// `evopanel.json::defaultProfile` is set.
pub const DEFAULT_PROFILE_ID: &str = "default";

/// Stable default for the dev tree when no explicit profile is requested.
pub const DEV_PROFILE_ID: &str = "dev";

/// Returns the active profile id for this process. Resolution order:
/// 1. `EVOFLOW_PROFILE` env (always wins — explicit operator override).
/// 2. `~/.evoflow/profiles/<id>/profile.json` discovery: if exactly one profile
///    exists, pick it; else fall back to `default`.
/// 3. `default` for installed client, `dev` for debug builds (or when
///    `EVOFLOW_CONFIG_DIR` is set to a `*-dev` style path).
pub fn current_profile_id() -> String {
    if let Ok(raw) = std::env::var("EVOFLOW_PROFILE") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && is_safe_profile_id(trimmed) {
            return trimmed.to_string();
        }
    }

    // 1) Persistent hint written by previous launches (lets a profile survive across restarts).
    if let Some(stored) = read_persisted_profile_id() {
        if is_safe_profile_id(&stored) {
            return stored;
        }
    }

    // 2) Auto-discover if there is exactly one profile on disk.
    if let Some(existing) = discover_single_profile() {
        return existing;
    }

    // 3) Built-in default per build flavour.
    if cfg!(debug_assertions) {
        DEV_PROFILE_ID.to_string()
    } else {
        DEFAULT_PROFILE_ID.to_string()
    }
}

/// Sanitize profile ids: short, alnum / dash / underscore only. Avoids any path
/// injection from a maliciously-set `EVOFLOW_PROFILE`.
pub fn is_safe_profile_id(id: &str) -> bool {
    let len = id.chars().count();
    if !(1..=64).contains(&len) {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn persisted_profile_id_path() -> PathBuf {
    evoflow_dir().join("current-profile")
}

fn read_persisted_profile_id() -> Option<String> {
    let p = persisted_profile_id_path();
    let raw = std::fs::read_to_string(&p).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn write_persisted_profile_id(id: &str) {
    let _ = std::fs::create_dir_all(evoflow_dir());
    let _ = std::fs::write(persisted_profile_id_path(), id);
}

#[allow(dead_code)]
fn discover_single_profile() -> Option<String> {
    let dir = evoflow_dir().join(PROFILES_SUBDIR);
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|n| is_safe_profile_id(n) && !n.starts_with('.'))
        .collect();
    names.sort();
    if names.len() == 1 {
        Some(names.remove(0))
    } else {
        None
    }
}

/// Returns the on-disk directory for the active profile. Created lazily on first use.
pub fn profile_dir() -> PathBuf {
    let id = current_profile_id();
    let dir = evoflow_dir().join(PROFILES_SUBDIR).join(&id);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Persist `EVOFLOW_PROFILE` for subsequent launches in the same home (when the user
/// sets a custom profile via env on first boot, subsequent boots without env still
/// land in the same profile dir).
#[allow(dead_code)]
pub fn pin_profile_for_future_launches(id: &str) {
    if is_safe_profile_id(id) {
        write_persisted_profile_id(id);
    }
}

/// Stable per-profile gateway port, derived from a FNV-1a hash of the profile id.
/// Range `8100..9000` keeps installed/dev profiles away from common dev ports
/// (8012/8070/1521) so a stray host on those ports cannot be mistaken as ours.
pub fn gateway_port_for_profile(id: &str) -> u16 {
    // FNV-1a 64-bit
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in id.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let range: u64 = 900; // 8100..8999
    let offset = (hash % range) as u16;
    8100u16 + offset
}

/// 获取 EvoFlow 配置目录。
/// 优先读取 `EVOFLOW_CONFIG_DIR` 环境变量（支持 dev/prod 隔离）；
/// 未设置时：
///   - debug 构建自动使用 `~/.evoflow-dev`（开发隔离）
///   - release 构建回退到 `~/.evoflow`
///
/// 多个 profile 共存时此目录是共享根；profile 自己的数据落在 `<evoflow_dir>/profiles/<id>/`。
pub fn evoflow_dir() -> PathBuf {
    if let Ok(config_dir) = std::env::var("EVOFLOW_CONFIG_DIR") {
        return PathBuf::from(config_dir);
    }
    let home = dirs::home_dir().unwrap_or_default();
    #[cfg(debug_assertions)]
    {
        home.join(".evoflow-dev")
    }
    #[cfg(not(debug_assertions))]
    {
        home.join(".evoflow")
    }
}

/// 读取用户设置的数据工作空间根目录（基础目录）。
/// 配置示例：{"userWorkspaceRoot":"D:/xxx"}
///
/// 注：root 仍来自 `evopanel.json`（共享根），profile 隔离在 `runtime_data_dir`
/// 这一层完成，避免每个 profile 都要复制一份 workspace 路径配置。
pub fn configured_user_workspace_root() -> Option<PathBuf> {
    let value = read_panel_config_value()?;
    let raw = value
        .get("userWorkspaceRoot")
        .or_else(|| value.get("dataWorkspaceRoot"))
        .and_then(|v| v.as_str())?
        .trim()
        .to_string();
    if raw.is_empty() {
        None
    } else {
        Some(PathBuf::from(raw))
    }
}

/// 运行时数据目录（用于 EVOFLOW_HOME）。
/// 当配置了 userWorkspaceRoot 时，使用：
///   <userWorkspaceRoot>/data/profiles/<id>
/// 否则回退到 `<evoflow_dir>/profiles/<id>`
///
/// 这保证两个 profile 各自拥有独立的 SQLite / checkpoints / logs，物理隔离，
/// 不再共享 `~/.evoflow/evoflow.db`。
pub fn runtime_data_dir() -> PathBuf {
    runtime_data_dir_for_root(configured_user_workspace_root(), current_profile_id())
}

/// Resolve EVOFLOW_HOME for an optional configured user workspace root + profile id.
pub fn runtime_data_dir_for_root(root: Option<PathBuf>, profile_id: String) -> PathBuf {
    let safe_id = if is_safe_profile_id(&profile_id) {
        profile_id
    } else {
        DEFAULT_PROFILE_ID.to_string()
    };
    if let Some(root) = root {
        let mut s = root.to_string_lossy().replace('\\', "/");
        while s.ends_with('/') {
            s.pop();
        }
        let lower = s.to_ascii_lowercase();
        let base = if lower.ends_with("/data") {
            root
        } else if lower.ends_with("/workspace/data") {
            root
        } else if lower.ends_with("/workspace") {
            if let Some(parent) = root.parent() {
                parent.join("data")
            } else {
                root.join("data")
            }
        } else {
            root.join("data")
        };
        return base.join(PROFILES_SUBDIR).join(&safe_id);
    }
    evoflow_dir().join(PROFILES_SUBDIR).join(&safe_id)
}

/// 面板主配置文件（写入/读取都使用此文件）
pub const PANEL_CONFIG_FILE: &str = "evopanel.json";

/// 面板数据目录名（热更新、助手数据等）
pub const PANEL_DATA_DIR_NAME: &str = "evopanel";

/// Per-profile panel config: each profile owns its own `evopanel.json` so flags
/// like `enableDevtools` and `userWorkspaceRoot` can diverge between installed
/// and dev clients.
pub fn panel_config_primary_path() -> PathBuf {
    profile_dir().join(PANEL_CONFIG_FILE)
}

/// 面板配置文件路径（仅使用 `evopanel.json`）
pub fn panel_config_existing_path() -> Option<PathBuf> {
    let primary = panel_config_primary_path();
    if primary.exists() {
        return Some(primary);
    }
    None
}

pub fn app_user_agent() -> String {
    format!("EvoFlow/{}", env!("CARGO_PKG_VERSION"))
}

fn read_panel_config_value() -> Option<serde_json::Value> {
    let path = panel_config_existing_path()?;
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn parse_positive_concurrency(raw: &serde_json::Value) -> Option<u32> {
    let n = if let Some(u) = raw.as_u64() {
        u
    } else if let Some(i) = raw.as_i64() {
        if i <= 0 {
            return None;
        }
        i as u64
    } else if let Some(s) = raw.as_str() {
        s.trim().parse::<u64>().ok()?
    } else {
        return None;
    };
    if (1..=64).contains(&n) {
        Some(n as u32)
    } else {
        None
    }
}

/// LangGraph `N_JOBS_PER_WORKER`: process env → `evopanel.json` `langgraphMaxConcurrent` → 10.
pub fn configured_n_jobs_per_worker() -> String {
    if let Ok(v) = std::env::var("N_JOBS_PER_WORKER") {
        let t = v.trim();
        if !t.is_empty() {
            if let Ok(n) = t.parse::<u32>() {
                if (1..=64).contains(&n) {
                    return n.to_string();
                }
            }
        }
    }
    if let Some(n) = read_panel_config_value()
        .as_ref()
        .and_then(|v| v.get("langgraphMaxConcurrent"))
        .and_then(parse_positive_concurrency)
    {
        return n.to_string();
    }
    "10".into()
}

/// `developer.enableDevtools` in ~/.evoflow/evopanel.json — 托盘「开发者工具」与调试构建自动开 DevTools。
/// 未设置时：debug 构建默认开启，release 默认关闭（安装包不暴露调试入口）。
pub fn panel_developer_enable_devtools() -> bool {
    match read_panel_config_value()
        .as_ref()
        .and_then(|v| v.get("developer"))
        .and_then(|d| d.get("enableDevtools"))
        .and_then(|x| x.as_bool())
    {
        Some(b) => b,
        None => cfg!(debug_assertions),
    }
}

/// `developer.showSessionDebug` — 侧栏「会话调试」入口与页面。
/// 未设置时：与 enableDevtools 相同规则（debug 开 / release 关）。
pub fn panel_developer_show_session_debug() -> bool {
    match read_panel_config_value()
        .as_ref()
        .and_then(|v| v.get("developer"))
        .and_then(|d| d.get("showSessionDebug"))
        .and_then(|x| x.as_bool())
    {
        Some(b) => b,
        None => cfg!(debug_assertions),
    }
}

pub fn configured_proxy_url() -> Option<String> {
    let value = read_panel_config_value()?;
    let raw = value
        .get("networkProxy")
        .and_then(|entry| {
            if let Some(obj) = entry.as_object() {
                obj.get("url").and_then(|v| v.as_str())
            } else {
                entry.as_str()
            }
        })?
        .trim()
        .to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

fn should_bypass_proxy_host(host: &str) -> bool {
    let lower = host.trim().to_ascii_lowercase();
    if lower.is_empty() || lower == "localhost" || lower.ends_with(".local") {
        return true;
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
            IpAddr::V6(v6) => {
                v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local()
            }
        };
    }
    false
}

/// 构建 HTTP 客户端，use_proxy=true 时走用户配置的代理
pub fn build_http_client(
    timeout: Duration,
    user_agent: Option<&str>,
) -> Result<reqwest::Client, String> {
    build_http_client_opt(timeout, user_agent, true, true)
}

fn build_http_client_opt(
    timeout: Duration,
    user_agent: Option<&str>,
    use_proxy: bool,
    use_gzip: bool,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(timeout);
    builder = if use_gzip {
        builder.gzip(true)
    } else {
        builder.no_gzip()
    };
    if let Some(ua) = user_agent {
        builder = builder.user_agent(ua);
    }
    if use_proxy {
        if let Some(proxy_url) = configured_proxy_url() {
            let proxy_value = proxy_url.clone();
            builder = builder.proxy(reqwest::Proxy::custom(move |url| {
                let host = url.host_str().unwrap_or("");
                if should_bypass_proxy_host(host) {
                    None
                } else {
                    Some(proxy_value.clone())
                }
            }));
        }
    }
    builder.build().map_err(|e| e.to_string())
}

pub fn apply_proxy_env(cmd: &mut std::process::Command) {
    if let Some(proxy_url) = configured_proxy_url() {
        cmd.env("HTTP_PROXY", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env("http_proxy", &proxy_url)
            .env("https_proxy", &proxy_url)
            .env("NO_PROXY", "localhost,127.0.0.1,::1")
            .env("no_proxy", "localhost,127.0.0.1,::1");
    }
}

/// Avoid GBK ``UnicodeEncodeError`` when LangGraph logs emoji on zh-CN Windows installs.
/// Also disable colorama (``COLORAMA_DISABLE``) so ``--noconsole`` PyInstaller builds
/// do not crash when colorama wraps a closed console handle (``ValueError: I/O operation on closed file``).
pub fn apply_windows_stdio_env(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .env("COLORAMA_DISABLE", "1");
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

/// 缓存 enhanced_path 结果，避免每次调用都扫描文件系统
/// 使用 RwLock 替代 OnceLock，支持运行时刷新缓存
static ENHANCED_PATH_CACHE: RwLock<Option<String>> = RwLock::new(None);

/// Tauri 应用启动时 PATH 可能不完整：
/// - macOS 从 Finder 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin
/// - Windows 上安装 Node.js 到非默认路径、或安装后未重启进程
///
/// 补充 Node.js / npm 常见安装路径
pub fn enhanced_path() -> String {
    // 先尝试读缓存
    if let Ok(guard) = ENHANCED_PATH_CACHE.read() {
        if let Some(ref cached) = *guard {
            return cached.clone();
        }
    }
    // 缓存为空，重新构建
    let path = build_enhanced_path();
    if let Ok(mut guard) = ENHANCED_PATH_CACHE.write() {
        *guard = Some(path.clone());
    }
    path
}

fn build_enhanced_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();

    // 读取用户保存的自定义 Node.js 路径（新版 evopanel.json 或旧版 evopanel.json）
    let custom_path = read_panel_config_value()
        .and_then(|v| v.get("nodePath")?.as_str().map(String::from));

    #[cfg(target_os = "macos")]
    {
        let mut extra: Vec<String> = vec![
            "/usr/local/bin".into(),
            "/opt/homebrew/bin".into(),
            format!("{}/.nvm/current/bin", home.display()),
            format!("{}/.volta/bin", home.display()),
            format!("{}/.nodenv/shims", home.display()),
            format!("{}/n/bin", home.display()),
            format!("{}/.npm-global/bin", home.display()),
        ];
        // NPM_CONFIG_PREFIX: 用户通过 npm config set prefix 自定义的全局安装路径
        if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
            extra.push(format!("{}/bin", prefix));
        }
        // 扫描 nvm 实际安装的版本目录（兼容无 current 符号链接的情况）
        let nvm_versions = home.join(".nvm/versions/node");
        if nvm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        // fnm: 扫描 $FNM_DIR 或默认 ~/.local/share/fnm 下的版本目录
        let fnm_dir = std::env::var("FNM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share/fnm"));
        let fnm_versions = fnm_dir.join("node-versions");
        if fnm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("installation/bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        let mut parts: Vec<&str> = vec![];
        if let Some(ref cp) = custom_path {
            parts.push(cp.as_str());
        }
        parts.extend(extra.iter().map(|s| s.as_str()));
        if !current.is_empty() {
            parts.push(&current);
        }
        parts.join(":")
    }

    #[cfg(target_os = "linux")]
    {
        let mut extra: Vec<String> = vec![
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/snap/bin".into(),
            format!("{}/.local/bin", home.display()),
            format!("{}/.nvm/current/bin", home.display()),
            format!("{}/.volta/bin", home.display()),
            format!("{}/.nodenv/shims", home.display()),
            format!("{}/n/bin", home.display()),
            format!("{}/.npm-global/bin", home.display()),
        ];
        // NPM_CONFIG_PREFIX: 用户通过 npm config set prefix 自定义的全局安装路径
        if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
            extra.push(format!("{}/bin", prefix));
        }
        // NVM_DIR 环境变量（用户可能自定义了 nvm 安装目录）
        let nvm_dir = std::env::var("NVM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".nvm"));
        let nvm_versions = nvm_dir.join("versions/node");
        if nvm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        // fnm: 扫描 $FNM_DIR 或默认 ~/.local/share/fnm 下的版本目录
        let fnm_dir = std::env::var("FNM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share/fnm"));
        let fnm_versions = fnm_dir.join("node-versions");
        if fnm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("installation/bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        // nodesource / 手动安装的 Node.js 可能在 /usr/local/lib/nodejs/ 下
        let nodejs_lib = std::path::Path::new("/usr/local/lib/nodejs");
        if nodejs_lib.is_dir() {
            if let Ok(entries) = std::fs::read_dir(nodejs_lib) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extra.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        let mut parts: Vec<&str> = vec![];
        if let Some(ref cp) = custom_path {
            parts.push(cp.as_str());
        }
        parts.extend(extra.iter().map(|s| s.as_str()));
        if !current.is_empty() {
            parts.push(&current);
        }
        parts.join(":")
    }

    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        let pf86 =
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();

        let mut extra: Vec<String> = vec![format!(r"{}\nodejs", pf), format!(r"{}\nodejs", pf86)];
        if !localappdata.is_empty() {
            extra.push(format!(r"{}\Programs\nodejs", localappdata));
            extra.push(format!(r"{}\fnm_multishells", localappdata));
        }
        if !appdata.is_empty() {
            extra.push(format!(r"{}\npm", appdata));
            extra.push(format!(r"{}\nvm", appdata));
            // 扫描 nvm-windows 实际安装的版本目录
            let nvm_dir = std::path::Path::new(&appdata).join("nvm");
            if nvm_dir.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() && p.join("node.exe").exists() {
                            extra.push(p.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        // NVM_SYMLINK 环境变量（nvm-windows 的活跃版本符号链接，如 D:\nodejs）
        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            let symlink_path = std::path::Path::new(&nvm_symlink);
            if symlink_path.is_dir() {
                extra.push(nvm_symlink.clone());
            }
        }
        // NVM_HOME 环境变量（用户可能自定义了 nvm 安装目录）
        if let Ok(nvm_home) = std::env::var("NVM_HOME") {
            let nvm_path = std::path::Path::new(&nvm_home);
            if nvm_path.is_dir() {
                if let Ok(entries) = std::fs::read_dir(nvm_path) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_dir() && p.join("node.exe").exists() {
                            extra.push(p.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        extra.push(format!(r"{}\.volta\bin", home.display()));
        // fnm: 扫描 %FNM_DIR% 或默认 %APPDATA%\fnm 下的版本目录
        let fnm_base = std::env::var("FNM_DIR")
            .ok()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::Path::new(&appdata).join("fnm"));
        let fnm_versions = fnm_base.join("node-versions");
        if fnm_versions.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
                for entry in entries.flatten() {
                    let inst = entry.path().join("installation");
                    if inst.is_dir() && inst.join("node.exe").exists() {
                        extra.push(inst.to_string_lossy().to_string());
                    }
                }
            }
        }

        // 扫描常见盘符下的 Node 安装（用户可能装在 D:\、F:\ 等）
        for drive in &["C", "D", "E", "F"] {
            extra.push(format!(r"{}:\nodejs", drive));
            extra.push(format!(r"{}:\Node", drive));
            extra.push(format!(r"{}:\Program Files\nodejs", drive));
        }

        let mut parts: Vec<&str> = vec![];
        // 用户自定义路径优先级最高
        if let Some(ref cp) = custom_path {
            parts.push(cp.as_str());
        }
        // 然后是默认扫描到的路径
        for p in &extra {
            if std::path::Path::new(p).exists() {
                parts.push(p.as_str());
            }
        }
        // 最后是系统 PATH
        if !current.is_empty() {
            parts.push(&current);
        }
        parts.join(";")
    }
}
