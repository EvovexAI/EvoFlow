//! EvoFlow 资源管理器：独立窗口 + 本机 CPU/内存/相关进程快照。
//! UI 复用 vendored `ResourceManagerApp`；采样在 Tauri 侧完成，避免卡主窗口。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{Manager, WebviewWindow};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const RESOURCE_MANAGER_LABEL: &str = "resource-manager";
const WINDOW_WIDTH: f64 = 920.0;
const WINDOW_HEIGHT: f64 = 640.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsageProcess {
    pub pid: u32,
    pub name: String,
    pub category: String,
    pub group_key: String,
    pub group_label: String,
    pub cpu_percent: f64,
    pub memory_bytes: u64,
    pub sampled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsageSnapshot {
    pub sampled_at: u64,
    pub logical_cpu_count: u32,
    /// 本桌面实例标记，例如 efinst-dev / efinst-default；资源面板只统计该实例树。
    pub instance_marker: String,
    pub instance_profile: String,
    pub system: SystemUsage,
    pub app: AppUsage,
    pub processes: Vec<ResourceUsageProcess>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUsage {
    pub cpu_percent: f64,
    pub memory_total_bytes: u64,
    pub memory_used_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUsage {
    pub cpu_percent: f64,
    pub memory_bytes: u64,
}

struct CpuBaseline {
    cpu_time_ms: f64,
    at: Instant,
}

struct SamplingState {
    active: bool,
    /// pid → 上一轮累计 CPU 时间（毫秒）
    baselines: HashMap<u32, CpuBaseline>,
    /// 整机 busy/total 差分基线
    system_busy: Option<(u64, u64)>,
}

impl Default for SamplingState {
    fn default() -> Self {
        Self {
            active: false,
            baselines: HashMap::new(),
            system_busy: None,
        }
    }
}

static SAMPLING: LazyLock<Mutex<SamplingState>> =
    LazyLock::new(|| Mutex::new(SamplingState::default()));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn logical_cpu_count() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
        .max(1)
}

fn classify_process(name: &str, cmdline: &str) -> (&'static str, &'static str, &'static str) {
    let lower = name.to_ascii_lowercase();
    let cmd = cmdline.to_ascii_lowercase();
    // 浏览器插件：browser-use / CDP 拉起的 Edge/Chrome（不含系统无关浏览）
    if (lower.contains("msedge") && !lower.contains("webview"))
        || lower.contains("chrome")
        || lower.contains("chromium")
        || lower.contains("playwright")
        || cmd.contains("playwright")
        || cmd.contains("puppeteer")
    {
        return ("builtin-plugin", "browser-use", "浏览器插件");
    }
    // 内嵌浏览器 / 主窗 WebView2
    if lower.contains("msedgewebview") || lower.contains("webview") {
        return ("base", "renderer", "内嵌 WebView");
    }
    if lower.contains("evoflow-gateway") || lower.contains("gateway") {
        return ("base", "host", "Gateway");
    }
    if lower.contains("evoflow") || lower.contains("evopanel") {
        return ("base", "main", "EvoFlow");
    }
    if lower.contains("python")
        || lower.contains("uvicorn")
        || lower.contains("langgraph")
        || lower.contains("gunicorn")
    {
        return ("base", "host", "Gateway / Python");
    }
    // MCP / 社区插件常见 npx node 子进程
    if lower.contains("node")
        && (cmd.contains("mcp")
            || cmd.contains("@modelcontextprotocol")
            || cmd.contains("npx")
            || cmd.contains("plugin"))
    {
        return ("community-plugin", "mcp", "MCP / 社区插件");
    }
    if lower.contains("node") || lower.contains("vite") || cmd.contains("kws") {
        return ("base", "utility", "Node / 工具");
    }
    ("base", "utility", "Related")
}

fn is_root_process_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("evoflow") || lower.contains("evopanel")
}

fn cpu_percent_from_delta(
    pid: u32,
    cpu_time_ms: f64,
    baselines: &mut HashMap<u32, CpuBaseline>,
    cpu_count: u32,
) -> f64 {
    let now = Instant::now();
    let percent = if let Some(prev) = baselines.get(&pid) {
        let wall_ms = now.duration_since(prev.at).as_secs_f64() * 1000.0;
        let delta = (cpu_time_ms - prev.cpu_time_ms).max(0.0);
        if wall_ms > 0.0 {
            ((delta / wall_ms) * 100.0 / f64::from(cpu_count.max(1))).clamp(0.0, 100.0)
        } else {
            0.0
        }
    } else {
        0.0
    };
    baselines.insert(
        pid,
        CpuBaseline {
            cpu_time_ms,
            at: now,
        },
    );
    (percent * 10.0).round() / 10.0
}

#[cfg(target_os = "windows")]
fn read_system_memory() -> (u64, u64) {
    // TotalVisibleMemorySize / FreePhysicalMemory 单位是 KB
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress)",
        ])
        .creation_flags(0x0800_0000)
        .output();
    let Ok(out) = output else {
        return (0, 0);
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return (0, 0);
    };
    let total_kb = v
        .get("TotalVisibleMemorySize")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let free_kb = v
        .get("FreePhysicalMemory")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let total = total_kb.saturating_mul(1024);
    let used = total.saturating_sub(free_kb.saturating_mul(1024));
    (total, used)
}

#[cfg(target_os = "windows")]
fn read_system_cpu_percent(state: &mut SamplingState) -> f64 {
    // Win32_Processor.LoadPercentage 是瞬时值，作整机展示够用。
    let _ = state;
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
        ])
        .creation_flags(0x0800_0000)
        .output();
    let Ok(out) = output else {
        return 0.0;
    };
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(0.0)
        .clamp(0.0, 100.0)
}

#[cfg(target_os = "windows")]
fn read_tracked_processes(cpu_count: u32, baselines: &mut HashMap<u32, CpuBaseline>) -> Vec<ResourceUsageProcess> {
    // 只认「本桌面实例」：本进程 + 本进程拉起的 Gateway/LG 子树。
    // 生产客户端与开发客户端并存时，互不统计对方。
    let roots = crate::commands::backend::owned_resource_root_pids();
    let marker = crate::commands::backend::instance_resource_marker();
    let marker_ps = marker.replace('\'', "''");
    let roots_ps = roots
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$rootIds = @({roots_ps})
$marker = '{marker_ps}'
$rows = Get-CimInstance Win32_Process | ForEach-Object {{
  [pscustomobject]@{{
    Id = $_.ProcessId
    PPid = $_.ParentProcessId
    Name = if ($_.Name) {{ $_.Name -replace '\.exe$','' }} else {{ '' }}
    Cmd = [string]$_.CommandLine
    Mem = [int64]$_.WorkingSetSize
  }}
}}
$cpuMap = @{{}}
Get-Process | ForEach-Object {{
  try {{ $cpuMap[$_.Id] = [math]::Round(($_.CPU * 1000), 1) }} catch {{}}
}}
$roots = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($id in $rootIds) {{ if ($id -gt 0) {{ [void]$roots.Add([int]$id) }} }}
$keep = New-Object 'System.Collections.Generic.HashSet[int]'
$queue = New-Object System.Collections.Generic.Queue[int]
foreach ($id in $roots) {{ $queue.Enqueue($id); [void]$keep.Add($id) }}
$byParent = $rows | Group-Object PPid -AsHashTable -AsString
while ($queue.Count -gt 0) {{
  $pid = $queue.Dequeue()
  $children = $byParent[[string]$pid]
  if (-not $children) {{ continue }}
  foreach ($c in $children) {{
    $cid = [int]$c.Id
    if ($keep.Add($cid)) {{ $queue.Enqueue($cid) }}
  }}
}}
# 命令行显式带本实例标记的进程（少数工具会写进 argv）
if ($marker) {{
  foreach ($r in $rows) {{
    $cmd = [string]$r.Cmd
    if ($cmd -and $cmd.Contains($marker)) {{ [void]$keep.Add([int]$r.Id) }}
  }}
}}
$out = @()
foreach ($r in $rows) {{
  if (-not $keep.Contains([int]$r.Id)) {{ continue }}
  $out += [pscustomobject]@{{
    Id = $r.Id
    ProcessName = $r.Name
    Cmd = $r.Cmd
    CpuMs = $(if ($cpuMap.ContainsKey($r.Id)) {{ $cpuMap[$r.Id] }} else {{ 0 }})
    WorkingSet64 = $r.Mem
  }}
}}
$out | ConvertTo-Json -Compress
"#,
        roots_ps = roots_ps,
        marker_ps = marker_ps
    );
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .creation_flags(0x0800_0000)
        .output();
    let Ok(out) = output else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Vec::new();
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let rows = if value.is_array() {
        value.as_array().cloned().unwrap_or_default()
    } else {
        vec![value]
    };

    let mut processes = Vec::with_capacity(rows.len());
    let mut seen = std::collections::HashSet::new();
    let self_pid = std::process::id();
    for row in rows {
        let pid = row.get("Id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        if pid == 0 || !seen.insert(pid) {
            continue;
        }
        let name = row
            .get("ProcessName")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let cmdline = row.get("Cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let cpu_ms = row.get("CpuMs").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let memory = row
            .get("WorkingSet64")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let (category, group_key, group_label) = classify_process(&name, &cmdline);
        let cpu_percent = cpu_percent_from_delta(pid, cpu_ms, baselines, cpu_count);
        let display = if is_root_process_name(&name) || pid == self_pid {
            format!("evoflow-{name}")
        } else if category == "builtin-plugin" {
            format!("plugin-browser-{name}")
        } else if category == "community-plugin" {
            format!("plugin-mcp-{name}")
        } else {
            format!("evoflow-{name}")
        };
        processes.push(ResourceUsageProcess {
            pid,
            name: display,
            category: category.to_string(),
            group_key: group_key.to_string(),
            group_label: group_label.to_string(),
            cpu_percent,
            memory_bytes: memory,
            sampled: true,
        });
    }
    processes
}

#[cfg(not(target_os = "windows"))]
fn read_system_memory() -> (u64, u64) {
    #[cfg(target_os = "macos")]
    {
        let total = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
            .unwrap_or(0);
        // page size * (active+wired+compressed) 近似已用；失败则 used=0
        let used = std::process::Command::new("sh")
            .args([
                "-c",
                r#"pagesize=$(pagesize); vm_stat | awk -v ps="$pagesize" '
                  /Pages active/ {a=$3}
                  /Pages wired/ {w=$4}
                  /Pages occupied by compressor/ {c=$5}
                  END {gsub("\\.","",a); gsub("\\.","",w); gsub("\\.","",c); print (a+w+c)*ps}'"#,
            ])
            .output()
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
            .unwrap_or(0);
        return (total, used.min(total));
    }
    #[cfg(target_os = "linux")]
    {
        let content = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let mut total_kb = 0u64;
        let mut avail_kb = 0u64;
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                total_kb = rest.split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                avail_kb = rest.split_whitespace().next().and_then(|s| s.parse().ok()).unwrap_or(0);
            }
        }
        let total = total_kb.saturating_mul(1024);
        let used = total.saturating_sub(avail_kb.saturating_mul(1024));
        return (total, used);
    }
    #[allow(unreachable_code)]
    (0, 0)
}

#[cfg(not(target_os = "windows"))]
fn read_system_cpu_percent(state: &mut SamplingState) -> f64 {
    #[cfg(target_os = "linux")]
    {
        let content = std::fs::read_to_string("/proc/stat").unwrap_or_default();
        let line = content.lines().next().unwrap_or("");
        let mut parts = line.split_whitespace().skip(1);
        let mut vals = [0u64; 8];
        for slot in vals.iter_mut() {
            *slot = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
        let idle = vals[3].saturating_add(vals[4]);
        let total: u64 = vals.iter().sum();
        let busy = total.saturating_sub(idle);
        let percent = if let Some((prev_busy, prev_total)) = state.system_busy {
            let db = busy.saturating_sub(prev_busy) as f64;
            let dt = total.saturating_sub(prev_total) as f64;
            if dt > 0.0 {
                (db / dt * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            }
        } else {
            0.0
        };
        state.system_busy = Some((busy, total));
        return (percent * 10.0).round() / 10.0;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = state;
        let output = std::process::Command::new("sh")
            .args([
                "-c",
                r#"top -l 1 -n 0 | awk '/CPU usage/ {gsub("%",""); print $3+$5}'"#,
            ])
            .output();
        return output
            .ok()
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().ok())
            .unwrap_or(0.0)
            .clamp(0.0, 100.0);
    }
    #[allow(unreachable_code)]
    {
        let _ = state;
        0.0
    }
}

#[cfg(not(target_os = "windows"))]
fn read_tracked_processes(cpu_count: u32, baselines: &mut HashMap<u32, CpuBaseline>) -> Vec<ResourceUsageProcess> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,pcpu=,rss=,comm="])
        .output();
    let Ok(out) = output else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    struct Row {
        pid: u32,
        ppid: u32,
        pcpu: f64,
        rss_kb: u64,
        name: String,
    }
    let mut rows = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let pid: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        let ppid: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let pcpu: f64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let rss_kb: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let name = parts.collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            continue;
        }
        rows.push(Row {
            pid,
            ppid,
            pcpu,
            rss_kb,
            name,
        });
    }

    let mut keep = std::collections::HashSet::new();
    let mut queue = crate::commands::backend::owned_resource_root_pids();
    for pid in &queue {
        keep.insert(*pid);
    }
    while let Some(pid) = queue.pop() {
        for row in &rows {
            if row.ppid == pid && keep.insert(row.pid) {
                queue.push(row.pid);
            }
        }
    }

    let mut processes = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        if !keep.contains(&row.pid) {
            continue;
        }
        if !seen.insert(row.pid) {
            continue;
        }
        let _ = cpu_percent_from_delta(row.pid, row.pcpu, baselines, cpu_count);
        let (category, group_key, group_label) = classify_process(&row.name, "");
        processes.push(ResourceUsageProcess {
            pid: row.pid,
            name: format!("evoflow-{}", row.name),
            category: category.to_string(),
            group_key: group_key.to_string(),
            group_label: group_label.to_string(),
            cpu_percent: (row.pcpu * 10.0).round() / 10.0,
            memory_bytes: row.rss_kb.saturating_mul(1024),
            sampled: true,
        });
    }
    processes
}

fn ensure_self_process(processes: &mut Vec<ResourceUsageProcess>) {
    let self_pid = std::process::id();
    if processes.iter().any(|p| p.pid == self_pid) {
        return;
    }
    processes.push(ResourceUsageProcess {
        pid: self_pid,
        name: "evoflow-main".into(),
        category: "base".into(),
        group_key: "main".into(),
        group_label: "EvoFlow".into(),
        cpu_percent: 0.0,
        memory_bytes: 0,
        sampled: false,
    });
}

fn build_snapshot() -> ResourceUsageSnapshot {
    let cpu_count = logical_cpu_count();
    let mut guard = SAMPLING.lock().unwrap_or_else(|e| e.into_inner());
    let system_cpu = read_system_cpu_percent(&mut guard);
    let (memory_total, memory_used) = read_system_memory();
    let mut processes = read_tracked_processes(cpu_count, &mut guard.baselines);
    ensure_self_process(&mut processes);
    // 丢掉长时间未见的 baseline，防 pid 复用
    let live: std::collections::HashSet<u32> = processes.iter().map(|p| p.pid).collect();
    guard.baselines.retain(|pid, base| {
        live.contains(pid) || base.at.elapsed() < Duration::from_secs(60)
    });

    let app_cpu = processes.iter().map(|p| p.cpu_percent).sum::<f64>();
    let app_mem = processes.iter().map(|p| p.memory_bytes).sum::<u64>();
    processes.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.memory_bytes.cmp(&a.memory_bytes))
            .then_with(|| a.pid.cmp(&b.pid))
    });

    ResourceUsageSnapshot {
        sampled_at: now_ms(),
        logical_cpu_count: cpu_count,
        instance_marker: crate::commands::backend::instance_resource_marker(),
        instance_profile: crate::commands::current_profile_id(),
        system: SystemUsage {
            cpu_percent: (system_cpu * 10.0).round() / 10.0,
            memory_total_bytes: memory_total,
            memory_used_bytes: memory_used,
        },
        app: AppUsage {
            cpu_percent: (app_cpu * 10.0).round() / 10.0,
            memory_bytes: app_mem,
        },
        processes,
    }
}

fn build_resource_manager_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    WebviewWindow::builder(
        app,
        RESOURCE_MANAGER_LABEL,
        tauri::WebviewUrl::App("resource-manager.html".into()),
    )
    .title("资源管理器")
    .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
    .min_inner_size(720.0, 480.0)
    .resizable(true)
    .decorations(true)
    .visible(false)
    .build()
    .map_err(|e| format!("创建资源管理器窗口失败: {e}"))
}

fn create_or_get_window(app: &tauri::AppHandle) -> Result<(WebviewWindow, bool), String> {
    if let Some(window) = app.get_webview_window(RESOURCE_MANAGER_LABEL) {
        return Ok((window, false));
    }
    Ok((build_resource_manager_window(app)?, true))
}

/// 打开（或聚焦）资源管理器独立窗口。
#[tauri::command]
pub async fn open_resource_manager(app: tauri::AppHandle) -> Result<(), String> {
    let app_create = app.clone();
    let (window, created) =
        tauri::async_runtime::spawn_blocking(move || create_or_get_window(&app_create))
            .await
            .map_err(|e| format!("resource manager create join failed: {e}"))??;

    if created {
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    window
        .show()
        .map_err(|e| format!("显示资源管理器失败: {e}"))?;
    let _ = window.unminimize();
    window
        .set_focus()
        .map_err(|e| format!("聚焦资源管理器失败: {e}"))?;
    Ok(())
}

/// UI 轮询启停：关掉窗口后停止采样状态（可选；快照本身仍可按需拉取）。
#[tauri::command]
pub fn set_resource_usage_sampling_active(active: bool) -> Result<(), String> {
    let mut guard = SAMPLING.lock().map_err(|e| e.to_string())?;
    guard.active = active;
    if !active {
        guard.baselines.clear();
        guard.system_busy = None;
    }
    Ok(())
}

/// 拉取 CPU / 内存 / EvoFlow 相关进程快照。
#[tauri::command]
pub async fn get_resource_usage_snapshot() -> Result<ResourceUsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(build_snapshot)
        .await
        .map_err(|e| format!("resource snapshot join failed: {e}"))
}

/// 供托盘等同步路径调用（当前托盘改走主窗口 eval，保留备用）。
#[allow(dead_code)]
pub fn open_resource_manager_sync(app: &tauri::AppHandle) -> Result<(), String> {
    let (window, _created) = create_or_get_window(app)?;
    window
        .show()
        .map_err(|e| format!("显示资源管理器失败: {e}"))?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}
