/// 系统托盘模块
/// Windows / macOS / Linux 通用，Tauri v2 内置跨平台支持
use crate::commands;
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

pub const TRAY_ID: &str = "main-tray";

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 EvoFlow").build(app)?;

    let menu = if commands::panel_developer_enable_devtools() {
        let devtools = MenuItemBuilder::with_id("devtools", "打开开发者工具").build(app)?;
        let separator1 = PredefinedMenuItem::separator(app)?;
        let separator2 = PredefinedMenuItem::separator(app)?;
        MenuBuilder::new(app)
            .item(&show)
            .item(&devtools)
            .item(&separator1)
            .item(&separator2)
            .item(&quit)
            .build()?
    } else {
        let separator1 = PredefinedMenuItem::separator(app)?;
        MenuBuilder::new(app)
            .item(&show)
            .item(&separator1)
            .item(&quit)
            .build()?
    };

    // 托盘图标（使用内嵌 32x32 PNG）
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("EvoFlow · 待命（关闭窗口不退出，点此显示）")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        "devtools" => {
            let _ = toggle_devtools(app.clone());
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

/// 切换主窗口 DevTools。前端后门快捷键 Ctrl+Shift+F12 调用；不依赖 enableDevtools 开关。
#[tauri::command]
pub fn toggle_devtools(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口未找到".to_string())?;
    if window.is_devtools_open() {
        window.close_devtools();
        Ok(false)
    } else {
        window.open_devtools();
        Ok(true)
    }
}

#[tauri::command]
pub fn set_tray_tooltip(app: AppHandle, text: String) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "托盘未初始化".to_string())?;
    let tip = text.trim();
    let display = if tip.is_empty() { "EvoFlow" } else { tip };
    tray.set_tooltip(Some(display))
        .map_err(|e| format!("更新托盘提示失败: {e}"))
}
