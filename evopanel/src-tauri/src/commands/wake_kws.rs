//! Wake-word KWS sidecar.
//!
//! Spawns `kws-sidecar/kws-process.cjs` under system Node, feeds 16 kHz Float32 PCM
//! from the WebView mic, and emits `wake-kws-hit` to the main window.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{enhanced_path, apply_windows_stdio_env};

const HIT_EVENT: &str = "wake-kws-hit";
const READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct WakeKwsState {
  inner: Mutex<Option<WakeKwsSession>>,
}

struct WakeKwsSession {
  child: Child,
  stdin: ChildStdin,
  ready: bool,
}

#[derive(Clone, Serialize)]
struct WakeHitPayload {
  keyword: String,
  backend: String,
}

fn bundled_node_candidates(sidecar_dir: &Path) -> Vec<PathBuf> {
  #[cfg(target_os = "windows")]
  {
    vec![
      sidecar_dir.join("runtime").join("node.exe"),
      sidecar_dir.join("runtime").join("node").join("node.exe"),
    ]
  }
  #[cfg(not(target_os = "windows"))]
  {
    vec![
      sidecar_dir.join("runtime").join("node"),
      sidecar_dir.join("runtime").join("bin").join("node"),
      sidecar_dir.join("runtime").join("node").join("bin").join("node"),
    ]
  }
}

fn which_node(sidecar_dir: Option<&Path>) -> Option<PathBuf> {
  // Prefer packaged portable Node next to kws-process (installers without system Node).
  if let Some(dir) = sidecar_dir {
    for p in bundled_node_candidates(dir) {
      if p.is_file() {
        return Some(p);
      }
    }
  }

  let path_env = enhanced_path();
  #[cfg(target_os = "windows")]
  let sep = ';';
  #[cfg(not(target_os = "windows"))]
  let sep = ':';

  for dir in path_env.split(sep) {
    if dir.is_empty() {
      continue;
    }
    #[cfg(target_os = "windows")]
    {
      let exe = Path::new(dir).join("node.exe");
      if exe.is_file() {
        return Some(exe);
      }
    }
    #[cfg(not(target_os = "windows"))]
    {
      let exe = Path::new(dir).join("node");
      if exe.is_file() {
        return Some(exe);
      }
    }
  }
  None
}

fn candidate_sidecar_dirs(app: &AppHandle) -> Vec<PathBuf> {
  let mut out = Vec::new();

  // Compile-time path: src-tauri/../kws-sidecar (tauri dev + local builds)
  out.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../kws-sidecar"));

  // Packaged resources
  if let Ok(resource) = app.path().resource_dir() {
    out.push(resource.join("kws-sidecar"));
    out.push(resource.join("resources/kws-sidecar"));
  }

  // Dev fallback: cwd-relative
  if let Ok(cwd) = std::env::current_dir() {
    out.push(cwd.join("kws-sidecar"));
    out.push(cwd.join("evopanel/kws-sidecar"));
  }

  out
}

fn candidate_model_dirs(app: &AppHandle) -> Vec<PathBuf> {
  let mut out = Vec::new();

  out.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/kws"));

  if let Ok(resource) = app.path().resource_dir() {
    out.push(resource.join("kws"));
    out.push(resource.join("public/kws"));
    out.push(resource.join("resources/kws"));
  }

  if let Ok(cwd) = std::env::current_dir() {
    out.push(cwd.join("public/kws"));
    out.push(cwd.join("evopanel/public/kws"));
  }

  out
}

fn first_existing(paths: &[PathBuf], marker: &str) -> Option<PathBuf> {
  for p in paths {
    let marker_path = p.join(marker);
    if marker_path.is_file() {
      return Some(p.canonicalize().unwrap_or_else(|_| p.clone()));
    }
  }
  None
}

fn write_line(stdin: &mut ChildStdin, value: &serde_json::Value) -> Result<(), String> {
  let mut line = value.to_string();
  line.push('\n');
  stdin
    .write_all(line.as_bytes())
    .map_err(|e| format!("kws stdin write failed: {e}"))?;
  stdin.flush().map_err(|e| format!("kws stdin flush failed: {e}"))
}

fn spawn_reader(app: AppHandle, stdout: std::process::ChildStdout, ready_tx: std::sync::mpsc::Sender<Result<(), String>>) {
  thread::Builder::new()
    .name("wake-kws-stdout".into())
    .spawn(move || {
      let reader = BufReader::new(stdout);
      let mut ready_sent = false;
      for line in reader.lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_string();
        if line.is_empty() {
          continue;
        }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
          eprintln!("[wake-kws] bad json from sidecar: {line}");
          continue;
        };
        let ty = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ty {
          "ready" => {
            if !ready_sent {
              ready_sent = true;
              let _ = ready_tx.send(Ok(()));
            }
          }
          "error" => {
            let err = msg
              .get("error")
              .and_then(|v| v.as_str())
              .unwrap_or("kws sidecar error")
              .to_string();
            eprintln!("[wake-kws] sidecar error: {err}");
            if !ready_sent {
              ready_sent = true;
              let _ = ready_tx.send(Err(err));
            }
          }
          "hit" => {
            let keyword = msg
              .get("keyword")
              .and_then(|v| v.as_str())
              .unwrap_or("小V小V")
              .to_string();
            let payload = WakeHitPayload {
              keyword,
              backend: "native-kws".into(),
            };
            if let Err(e) = app.emit(HIT_EVENT, payload) {
              eprintln!("[wake-kws] emit hit failed: {e}");
            }
            // Also nudge main window forward when possible.
            if let Some(win) = app.get_webview_window("main") {
              let _ = win.unminimize();
              let _ = win.set_focus();
              let _ = win.show();
            }
          }
          "stopped" => break,
          _ => {}
        }
      }
      if !ready_sent {
        let _ = ready_tx.send(Err("kws sidecar exited before ready".into()));
      }
    })
    .ok();
}

fn stop_session_locked(slot: &mut Option<WakeKwsSession>) {
  let Some(mut sess) = slot.take() else {
    return;
  };
  let _ = write_line(&mut sess.stdin, &serde_json::json!({ "type": "stop" }));
  thread::sleep(Duration::from_millis(80));
  let _ = sess.child.kill();
  let _ = sess.child.wait();
}

/// Start the KWS sidecar (idempotent). Returns true when ready.
#[tauri::command]
pub fn wake_kws_start(
  app: AppHandle,
  state: State<'_, WakeKwsState>,
  keywords_score: Option<f32>,
  keywords_threshold: Option<f32>,
) -> Result<bool, String> {
  {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = guard.as_ref() {
      if sess.ready {
        return Ok(true);
      }
    }
    // Tear down any half-open session.
    stop_session_locked(&mut guard);
  }

  let sidecar_dir = first_existing(&candidate_sidecar_dirs(&app), "kws-process.cjs")
    .ok_or_else(|| "找不到 kws-sidecar/kws-process.cjs".to_string())?;
  let node = which_node(Some(&sidecar_dir)).ok_or_else(|| {
    "未找到 Node.js：请打包时执行 npm run kws:node，或安装系统 Node 以运行 kws-sidecar"
      .to_string()
  })?;
  let script = sidecar_dir.join("kws-process.cjs");
  let model_dir = first_existing(
    &candidate_model_dirs(&app),
    "encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
  )
  .ok_or_else(|| "找不到 public/kws 模型目录".to_string())?;

  let mut cmd = Command::new(&node);
  cmd.arg(&script)
    .current_dir(&sidecar_dir)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .env("PATH", enhanced_path());
  apply_windows_stdio_env(&mut cmd);
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
  }

  let mut child = cmd
    .spawn()
    .map_err(|e| format!("启动 kws-sidecar 失败: {e}"))?;
  let mut stdin = child
    .stdin
    .take()
    .ok_or_else(|| "kws-sidecar stdin unavailable".to_string())?;
  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| "kws-sidecar stdout unavailable".to_string())?;

  let (ready_tx, ready_rx) = std::sync::mpsc::channel();
  spawn_reader(app.clone(), stdout, ready_tx);

  let mut init = serde_json::json!({
    "type": "init",
    "modelDir": model_dir.to_string_lossy(),
  });
  if let Some(score) = keywords_score {
    init["keywordsScore"] = serde_json::json!(score);
  }
  if let Some(th) = keywords_threshold {
    init["keywordsThreshold"] = serde_json::json!(th);
  }
  write_line(&mut stdin, &init)?;

  let started = Instant::now();
  let ready = loop {
    match ready_rx.recv_timeout(Duration::from_millis(200)) {
      Ok(Ok(())) => break true,
      Ok(Err(e)) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
      }
      Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
        if started.elapsed() > READY_TIMEOUT {
          let _ = child.kill();
          let _ = child.wait();
          return Err("kws-sidecar ready timeout".into());
        }
      }
      Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err("kws-sidecar reader disconnected".into());
      }
    }
  };

  let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
  *guard = Some(WakeKwsSession {
    child,
    stdin,
    ready,
  });
  eprintln!(
    "[wake-kws] started node={} script={} model={}",
    node.display(),
    script.display(),
    model_dir.display()
  );
  Ok(ready)
}

/// Feed one PCM chunk (base64 Float32 LE @ 16 kHz).
#[tauri::command]
pub fn wake_kws_feed_pcm(state: State<'_, WakeKwsState>, b64: String) -> Result<(), String> {
  if b64.is_empty() {
    return Ok(());
  }
  let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
  let Some(sess) = guard.as_mut() else {
    return Ok(());
  };
  if !sess.ready {
    return Ok(());
  }
  let msg = serde_json::json!({ "type": "pcm", "b64": b64 });
  write_line(&mut sess.stdin, &msg)
}

#[tauri::command]
pub fn wake_kws_pause(state: State<'_, WakeKwsState>) -> Result<(), String> {
  let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
  let Some(sess) = guard.as_mut() else {
    return Ok(());
  };
  write_line(&mut sess.stdin, &serde_json::json!({ "type": "pause" }))
}

#[tauri::command]
pub fn wake_kws_resume(state: State<'_, WakeKwsState>) -> Result<(), String> {
  let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
  let Some(sess) = guard.as_mut() else {
    return Ok(());
  };
  write_line(&mut sess.stdin, &serde_json::json!({ "type": "resume" }))
}

#[tauri::command]
pub fn wake_kws_stop(state: State<'_, WakeKwsState>) -> Result<bool, String> {
  let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
  let had = guard.is_some();
  stop_session_locked(&mut guard);
  Ok(had)
}

#[tauri::command]
pub fn wake_kws_is_running(state: State<'_, WakeKwsState>) -> Result<bool, String> {
  let guard = state.inner.lock().map_err(|e| e.to_string())?;
  Ok(guard.as_ref().map(|s| s.ready).unwrap_or(false))
}
