/// OS 级语音按住说话热键（push-to-talk）
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

static CURRENT_SHORTCUT: Mutex<Option<Shortcut>> = Mutex::new(None);

fn emit_voice_event(app: &AppHandle, event: &str) {
    let _ = app.emit(event, ());
}

#[tauri::command]
pub fn sync_voice_hotkey(app: AppHandle, shortcut: Option<String>) -> Result<(), String> {
    let gs = app.global_shortcut();

    if let Ok(mut guard) = CURRENT_SHORTCUT.lock() {
        if let Some(prev) = guard.take() {
            let _ = gs.unregister(prev);
        }
    }

    let raw = shortcut.unwrap_or_default().trim().to_string();
    if raw.is_empty() {
        return Ok(());
    }

    let parsed: Shortcut = raw.parse().map_err(|e| format!("无效快捷键: {raw} ({e})"))?;
    match gs.on_shortcut(parsed.clone(), move |handle, _shortcut, event| {
        match event.state() {
            ShortcutState::Pressed => emit_voice_event(handle, "voice-push-down"),
            ShortcutState::Released => emit_voice_event(handle, "voice-push-up"),
        }
    }) {
        Ok(()) => {}
        // App reload / double sync often hits "already registered" — treat as success.
        Err(e) => {
            let msg = e.to_string();
            let lower = msg.to_ascii_lowercase();
            if !(lower.contains("already registered") || lower.contains("already exists")) {
                return Err(format!("注册全局热键失败: {msg}"));
            }
        }
    }

    if let Ok(mut guard) = CURRENT_SHORTCUT.lock() {
        *guard = Some(parsed);
    }
    Ok(())
}

pub fn init_global_shortcut_plugin(
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|_app, _shortcut, _event| {})
            .build(),
    )?;
    Ok(())
}
