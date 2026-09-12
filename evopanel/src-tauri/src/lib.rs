mod commands;
mod models;
mod power;
mod tray;
mod utils;
mod voice_hotkey;

use commands::{
    app_server, assistant, backend, boot_cycle, browser_embed, config, gateway, logs, mcp_market,
    ui_extensions, update, voice_overlay,
};
use tauri::{Manager, WindowEvent};

pub fn run() {
    let evoflow_home = commands::evoflow_dir();
    let hot_update_dir = evoflow_home
        .join(commands::PANEL_DATA_DIR_NAME)
        .join("web-update");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(browser_embed::BrowserEmbedState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                // Product (release): hide to tray, keep Gateway hot for near-instant reopen.
                // Dev (debug): quit fully so isolated ports (8070/1521) are freed on restart.
                #[cfg(not(debug_assertions))]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                #[cfg(debug_assertions)]
                {
                    let _ = api;
                    window.app_handle().exit(0);
                }
            }
        })
        .register_uri_scheme_protocol("tauri", move |ctx, request| {
            let looks_like_dev_hot_update = |path: &str, data: &[u8]| -> bool {
                if !path.ends_with(".html") {
                    return false;
                }
                let text = String::from_utf8_lossy(data).to_lowercase();
                text.contains("http://localhost")
                    || text.contains("https://localhost")
                    || text.contains("127.0.0.1:")
                    || text.contains("localhost:1420")
                    || text.contains("localhost:1421")
            };

            let uri_path = request.uri().path();
            let path = if uri_path == "/" || uri_path.is_empty() {
                "index.html"
            } else {
                uri_path.strip_prefix('/').unwrap_or(uri_path)
            };

            // 1. 优先检查热更新目录（evopanel）
            let update_file = hot_update_dir.join(path);
            if update_file.is_file() {
                if let Ok(data) = std::fs::read(&update_file) {
                    if looks_like_dev_hot_update(path, &data) {
                        // Ignore broken/dev hot-update artifacts that point to localhost.
                    } else {
                        return tauri::http::Response::builder()
                            .header(
                                tauri::http::header::CONTENT_TYPE,
                                update::mime_from_path(path),
                            )
                            .body(data)
                            .unwrap();
                    }
                }
            }

            // 2. 回退到内嵌资源
            if let Some(asset) = ctx.app_handle().asset_resolver().get(path.to_string()) {
                let builder = tauri::http::Response::builder()
                    .header(tauri::http::header::CONTENT_TYPE, &asset.mime_type);
                // Tauri 内嵌资源可能带 CSP header
                let builder = if let Some(csp) = asset.csp_header {
                    builder.header("Content-Security-Policy", csp)
                } else {
                    builder
                };
                builder.body(asset.bytes).unwrap()
            } else {
                tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::NOT_FOUND)
                    .body(b"Not Found".to_vec())
                    .unwrap()
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())
                    .map_err(|e| format!("初始化应用更新插件失败: {e}"))?;
            }
            commands::boot_cycle::init_boot_cycle();
            commands::boot_cycle::mark("desktop", "sidecar.ensure.begin", None);
            backend::ensure_backend_sidecar(app.handle())
                .map_err(|e| format!("启动内置后端失败: {e}"))?;
            commands::boot_cycle::mark("desktop", "sidecar.ensure.returned", None);
            voice_hotkey::init_global_shortcut_plugin(app.handle())?;
            tray::setup_tray(app.handle())?;
            commands::boot_cycle::mark("desktop", "app.setup.done", None);

            // 阻止系统进入睡眠状态，确保锁屏后客户端仍能正常运行
            power::prevent_system_sleep();

            // 调试构建且 evopanel.json developer.enableDevtools 未显式关时自动打开 DevTools
            #[cfg(debug_assertions)]
            {
                if commands::panel_developer_enable_devtools() {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.open_devtools();
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 配置
            config::read_evoflow_config,
            config::write_evoflow_config,
            config::read_mcp_config,
            config::write_mcp_config,
            config::write_env_file,
            config::list_backups,
            config::create_backup,
            config::restore_backup,
            config::delete_backup,
            config::check_panel_update,
            config::read_panel_config,
            config::write_panel_config,
            config::get_developer_ui_flags,
            config::test_proxy,
            backend::apply_workspace_settings,
            backend::reload_gateway,
            backend::workspace_runtime_info,
            backend::get_gateway_base_url,
            // 网关代理
            gateway::gateway_proxy,
            gateway::gateway_proxy_stream,
            gateway::gateway_health,
            gateway::gateway_health_probe,
            // 桌面 app-server 管道（对话）
            app_server::app_server_ensure,
            app_server::app_server_request,
            app_server::app_server_notify,
            app_server::app_server_is_warm,
            // 日志
            logs::read_log_tail,
            logs::search_log,
            logs::append_frontend_log,
            logs::append_stream_compare_log,
            boot_cycle::boot_cycle_mark,
            boot_cycle::boot_cycle_info,
            mcp_market::mcp_market_search,
            // 扩展工具
            // UI 扩展（嵌页面 + 可选侧车）
            ui_extensions::ui_extension_list,
            ui_extensions::ui_extension_install_manifest,
            ui_extensions::ui_extension_install_folder,
            ui_extensions::ui_extension_install_zip,
            ui_extensions::ui_extension_install_suite,
            ui_extensions::ui_extension_install_content_creator,
            ui_extensions::ui_extension_set_enabled,
            ui_extensions::ui_extension_uninstall,
            ui_extensions::ui_extension_reveal,
            ui_extensions::ui_extension_service_status,
            ui_extensions::ui_extension_service_start,
            ui_extensions::ui_extension_service_stop,
            ui_extensions::ui_extension_service_logs,
            // AI 助手工具
            assistant::assistant_exec,
            assistant::assistant_read_file,
            assistant::assistant_write_file,
            assistant::assistant_list_dir,
            assistant::assistant_system_info,
            assistant::assistant_list_processes,
            assistant::assistant_check_port,
            assistant::assistant_web_search,
            assistant::assistant_fetch_url,
            // 数据目录 & 图片存储
            assistant::assistant_ensure_data_dir,
            assistant::assistant_save_image,
            assistant::assistant_load_image,
            assistant::assistant_delete_image,
            assistant::read_clipboard_text,
            assistant::read_clipboard_image,
            assistant::copy_image_to_clipboard,
            assistant::reveal_path_in_file_manager,
            // 前端热更新
            update::check_frontend_update,
            update::download_frontend_update,
            update::rollback_frontend_update,
            update::get_update_status,
            voice_hotkey::sync_voice_hotkey,
            tray::set_tray_tooltip,
            tray::toggle_devtools,
            voice_overlay::voice_overlay_show,
            voice_overlay::voice_overlay_update_text,
            voice_overlay::voice_overlay_update_levels,
            voice_overlay::voice_overlay_processing,
            voice_overlay::voice_overlay_hide,
            voice_overlay::voice_overlay_set_complete,
            browser_embed::browser_embed_supported,
            browser_embed::browser_embed_upsert,
            browser_embed::browser_embed_set_bounds,
            browser_embed::browser_embed_close,
        ])
        .build(tauri::generate_context!())
        .expect("启动 EvoFlow 失败")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                ui_extensions::stop_all_ui_extension_services();
                // native-style: kill owned app-server child before Gateway sidecar.
                app_server::stop_app_server_child();
                let _ = backend::stop_backend_sidecar();
                power::restore_system_sleep();
            }
        });
}
