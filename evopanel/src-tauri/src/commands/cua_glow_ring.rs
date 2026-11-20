//! 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
//!
//! Computer Use 全屏蓝光环 —— 原生分层窗口（GDI 绘制），**不经过 WebView2**。
//!
//! ## 为什么不用 WebView2
//! 现有顶部卡片窗口是**不透明**的，原因写在 `cua_glow_overlay.rs` 里：
//! 透明的 WebView2 在本机常常整片画不出来（不是配置问题，是渲染进程与合成器的时序）。
//! 用户要的是「整屏四周一圈蓝光」，那必须是一个**透明、点击穿透、全屏覆盖**的窗口 ——
//! 这正是 WebView2 画不出来的形态。所以这里换成 Win32 分层窗口 + 32bpp DIB 直接画像素。
//!
//! ## 绘制方案
//! - `WS_EX_LAYERED | WS_EX_TRANSPARENT`：透明 + 鼠标完全穿透（用户仍能正常点桌面）。
//! - `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_POPUP`：不进任务栏、不抢焦点。
//! - 只画边框：距屏幕边缘 `d` 像素处的 alpha 由两段决定 ——
//!   前 `EDGE_PX` 内侧是实心亮线，之后 `GLOW_PX` 距离内二次衰减到 0。
//! - 呼吸效果**不重画像素**：预生成一张 DIB，靠 `UpdateLayeredWindow` 的
//!   `SourceConstantAlpha` 做整体明暗调制（每帧只改一个字节，不是 8MB 重绘）。
//!
//! ## 边界
//! 只覆盖光标所在的**那一块屏幕**（多屏时不糊到别的屏上）；单条命令幂等，
//! 重复 show 不会叠出第二个环。任何一步失败都回退成「没有蓝光」，绝不影响面板主功能。

#[cfg(target_os = "windows")]
use std::sync::atomic::AtomicBool;

#[cfg(target_os = "windows")]
static RING_RUNNING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static RING_STOP: AtomicBool = AtomicBool::new(false);

// 【self-evolution-bot · 2026-11-19 · 第71轮 · 模型:deepseek-v4.1-flash-1017】
// 缺陷：原来是固定 3px 实线 + 56px 衰减 = 59px。在 3840×2160 的屏上
// 只占屏高 2.7% —— 用户反馈「边缘太小」。4K 下 59px 几乎贴着边框，看不出是光环。
// 改成**按屏幕短边等比例**：光晕带 = 短边 × GLOW_BAND_RATIO（现 16%），
// 实线 = 带宽/24（有夹取）。
//   1080p(1920×1080) → 带 173px、实线 7px
//   4K(3840×2160)    → 带 346px、实线 10px
// 运行时可用 EVOFLOW_CUA_RING_BAND_PCT 覆盖（见 glow_band_for）。
// 这样 1080p 和 4K 上「视觉占比」一致，不会大屏看着反而更细。
#[cfg(target_os = "windows")]
pub const GLOW_BAND_RATIO: f64 = 0.16;
/// 兼容旧测试的最小实线（band 很小时不至于消失）。
#[cfg(target_os = "windows")]
pub const EDGE_PX_MIN: i32 = 2;

/// 光晕带总宽度（含实线）—— 按屏幕短边等比例。
#[cfg(target_os = "windows")]
pub fn glow_band_for(w: i32, h: i32) -> i32 {
    let short = w.min(h).max(1);
    // 【self-evolution-bot · 2026-11-19 · 第71轮】允许运行时调粗细，不用重编：
    //   EVOFLOW_CUA_RING_BAND_PCT=25  → 带占短边 25%
    // 用户觉得粗细不合适时，改这个数重启面板即可试，避免每轮都要我改代码。
    let ratio = std::env::var("EVOFLOW_CUA_RING_BAND_PCT")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .map(|pct| (pct / 100.0).clamp(0.03, 0.45))
        .unwrap_or(GLOW_BAND_RATIO);
    ((short as f64) * ratio).round().max(64.0) as i32
}

/// 实线厚度 —— 跟着带宽缩放，避免大屏上实线变成看不见的一根线。
#[cfg(target_os = "windows")]
pub fn edge_thickness_for(band: i32) -> i32 {
    (band / 24).clamp(EDGE_PX_MIN, 10)
}
/// 呼吸周期（毫秒）与每帧间隔。
#[cfg(target_os = "windows")]
pub const BREATH_MS: f64 = 2400.0;

#[cfg(target_os = "windows")]
pub mod imp {
    use super::{edge_thickness_for, glow_band_for, BREATH_MS, RING_RUNNING, RING_STOP};
    use std::sync::atomic::Ordering;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, POINT, SIZE};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, RegisterClassW,
        ShowWindow, TranslateMessage, UpdateLayeredWindow, MSG, PM_REMOVE, SW_SHOWNOACTIVATE,
        WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
        WS_EX_TRANSPARENT, WS_POPUP,
    };

    // 常量用字面量，避免再为几个 u32 打开 Gdi 的常量模块。
    const AC_SRC_OVER: u8 = 0;
    const AC_SRC_ALPHA: u8 = 1;
    const ULW_ALPHA: u32 = 2;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // 【self-evolution-bot · 2026-11-19 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
    // 把「某个距边距离该多亮」抽成纯函数。
    // 为什么要抽：验收时必须能**独立复算**像素，而不是「跑过了就算对」。
    // 探针调这个函数，和 build_border_dib 里写进去的是同一份判据，
    // 这样验的是真实现，不是另抄一遍的仿制品。
    pub fn ring_alpha_at(d: i32) -> u32 {
        ring_alpha_at_band(d, glow_band_for(3840, 2160))
    }

    /// 按指定带宽算 alpha：`d` 是距边距离，`band` 是光晕带总宽（含实线）。
    ///
    /// 【self-evolution-bot · 2026-11-19 · 第71轮 · 模型:deepseek-v4.1-flash-1017】
    /// 为什么带参数：带宽容随屏幕尺寸变化，不能写死。4K 上 59px 只占屏高 2.7%，
    /// 用户看不出是光环；现在按短边 GLOW_BAND_RATIO（16%）走（4K=346px）。
    pub fn ring_alpha_at_band(d: i32, band: i32) -> u32 {
        if d < 0 || band <= 0 {
            return 0;
        }
        let edge = edge_thickness_for(band);
        if d < edge {
            235
        } else if d < band {
            // 二次衰减：贴边亮，往外迅速淡掉，不会变成一整块雾。
            let span = (band - edge).max(1) as f64;
            let t = (d - edge) as f64 / span;
            let falloff = (1.0 - t) * (1.0 - t);
            (205.0 * falloff) as u32
        } else {
            0
        }
    }

    /// 纯计算版：不碰 GDI，按真实判据生成 `w×h` 的 BGRA 像素。
    ///
    /// 验收用：可以在没有窗口系统的情况下断言「边缘亮、中间全透明、颜色是品牌蓝」。
    pub fn render_bgra(w: i32, h: i32) -> Vec<u8> {
        let mut buf = vec![0u8; (w * h * 4).max(0) as usize];
        if w <= 0 || h <= 0 {
            return buf;
        }
        let (br, bg, bb) = (59u32, 130u32, 246u32);
        let band = glow_band_for(w, h);
        for y in 0..h {
            for x in 0..w {
                let d = x.min(y).min(w - 1 - x).min(h - 1 - y);
                let a = ring_alpha_at_band(d, band);
                let i = ((y * w + x) * 4) as usize;
                buf[i] = ((bb * a) / 255) as u8;
                buf[i + 1] = ((bg * a) / 255) as u8;
                buf[i + 2] = ((br * a) / 255) as u8;
                buf[i + 3] = a as u8;
            }
        }
        buf
    }

    /// 生成边框位图：预乘 alpha 的 BGRA，尺寸 `w × h`。
    ///
    /// 预乘是 `ULW_ALPHA` 的硬要求 —— 不预乘会让亮线变成一圈发白的脏边。
    fn build_border_dib(w: i32, h: i32) -> Result<(isize, isize, *mut u8), String> {
        let hdc_screen = unsafe { CreateCompatibleDC(None) };
        if hdc_screen.is_invalid() {
            return Err("CreateCompatibleDC failed".into());
        }
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            // 负高度 = top-down，行序与直觉一致，省掉翻转。
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbmp = unsafe {
            CreateDIBSection(Some(hdc_screen), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
        }
        .map_err(|e| format!("CreateDIBSection failed: {e}"))?;
        if bits.is_null() {
            unsafe {
                let _ = DeleteDC(hdc_screen);
            }
            return Err("CreateDIBSection returned null bits".into());
        }
        let px = unsafe { SelectObject(hdc_screen, HGDIOBJ(hbmp.0)) };
        if px.0.is_null() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(hbmp.0));
                let _ = DeleteDC(hdc_screen);
            };
            return Err("SelectObject failed".into());
        }

        // ---- 画像素 ----
        let buf = unsafe { std::slice::from_raw_parts_mut(bits as *mut u8, (w * h * 4) as usize) };
        // 品牌蓝 #3b82f6
        let (br, bg, bb) = (59u32, 130u32, 246u32);
        let band = glow_band_for(w, h);
        for y in 0..h {
            for x in 0..w {
                let d = x.min(y).min(w - 1 - x).min(h - 1 - y);
                // 判据与 `ring_alpha_at_band` 同源 —— 探针验的就是这份。
                let a: u32 = ring_alpha_at_band(d, band);
                let i = ((y * w + x) * 4) as usize;
                // BGRA + 预乘
                buf[i] = ((bb * a) / 255) as u8;
                buf[i + 1] = ((bg * a) / 255) as u8;
                buf[i + 2] = ((br * a) / 255) as u8;
                buf[i + 3] = a as u8;
            }
        }
        Ok((hbmp.0 as isize, hdc_screen.0 as isize, bits as *mut u8))
    }

    /// 在独立线程里创建全屏环并跑呼吸动画。`rect` 为物理像素 (x, y, w, h)。
    pub fn spawn_ring(x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
        if w <= 0 || h <= 0 {
            return Err(format!("invalid ring size {w}x{h}"));
        }
        if RING_RUNNING.swap(true, Ordering::SeqCst) {
            return Ok(()); // 已在跑，幂等
        }
        RING_STOP.store(false, Ordering::SeqCst);
        let spawned = std::thread::Builder::new()
            .name("cua-glow-ring".into())
            .spawn(move || {
                if let Err(e) = run_ring(x, y, w, h) {
                    eprintln!("[cua-glow-ring] {e}");
                }
                RING_RUNNING.store(false, Ordering::SeqCst);
            });
        if spawned.is_err() {
            RING_RUNNING.store(false, Ordering::SeqCst);
            return Err("spawn cua-glow-ring thread failed".into());
        }
        Ok(())
    }

    pub fn stop_ring() {
        RING_STOP.store(true, Ordering::SeqCst);
    }

    fn run_ring(x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
        let class_name = wide("EvoFlowCuaGlowRing");
        let hinst = unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandleW: {e}"))?;

        // WNDCLASSW 里有函数指针，Default 不安全可读，逐字段填。
        let wc = WNDCLASSW {
            style: windows::Win32::UI::WindowsAndMessaging::WNDCLASS_STYLES(0),
            lpfnWndProc: Some(def_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst.into(),
            hIcon: Default::default(),
            hCursor: Default::default(),
            hbrBackground: Default::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
        };
        // 重复注册返回 0（已存在），不算错。
        unsafe {
            RegisterClassW(&wc);
        }

        let ex_style = WS_EX_LAYERED
            | WS_EX_TRANSPARENT // 鼠标穿透：用户照常点桌面
            | WS_EX_TOOLWINDOW // 不进任务栏
            | WS_EX_NOACTIVATE // 不抢焦点
            | WS_EX_TOPMOST;

        let window_title = wide("EvoFlow CUA glow ring");
        let hwnd = unsafe {
            CreateWindowExW(
                ex_style,
                PCWSTR(class_name.as_ptr()),
                PCWSTR(window_title.as_ptr()),
                WS_POPUP,
                x,
                y,
                w,
                h,
                None,
                None,
                Some(hinst.into()),
                None,
            )
        }
        .map_err(|e| format!("CreateWindowExW failed: {e}"))?;

        let (hbmp, hdc_mem, _bits) = match build_border_dib(w, h) {
            Ok(v) => v,
            Err(e) => {
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
                return Err(e);
            }
        };

        let pt_dst = POINT { x, y };
        let size = SIZE { cx: w, cy: h };
        let pt_src = POINT { x: 0, y: 0 };
        let started = std::time::Instant::now();

        let push = |alpha: u8| -> bool {
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER,
                BlendFlags: 0,
                // 整体明暗就靠这一个字节 —— 不重画 8MB 像素。
                SourceConstantAlpha: alpha,
                AlphaFormat: AC_SRC_ALPHA,
            };
            let ok = unsafe {
                UpdateLayeredWindow(
                    hwnd,
                    None,
                    Some(&pt_dst),
                    Some(&size),
                    Some(windows::Win32::Graphics::Gdi::HDC(hdc_mem as *mut _)),
                    Some(&pt_src),
                    Default::default(),
                    Some(&blend),
                    windows::Win32::UI::WindowsAndMessaging::UPDATE_LAYERED_WINDOW_FLAGS(ULW_ALPHA),
                )
            };
            ok.is_ok()
        };
        if !push(220) {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(hbmp as *mut core::ffi::c_void));
                let _ = DeleteDC(windows::Win32::Graphics::Gdi::HDC(hdc_mem as *mut _));
                let _ = DestroyWindow(hwnd);
            }
            return Err("initial UpdateLayeredWindow failed".into());
        }
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }

        // 【self-evolution-bot · 2026-11-19 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
        // 对齐 ZCode `setContentProtection(true)`：让本环对截屏不可见。
        // CUA 靠截图判断该点哪里 —— 全屏蓝光出现在它自己的截图里会污染判断
        // （亮线被误读成窗口边缘/可点目标）。人眼仍可见，只是不进捕获。
        //
        // 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
        // 默认值反转（与 cua_glow_overlay.rs 同一改动、同一理由）：远程控制/远程串流
        // 本质是抓屏，`WDA_EXCLUDEFROMCAPTURE` 会让远端**完全看不到**蓝环 →
        // 用户以为控制没在跑。实测 affinity=0x11、A/B 像素差 0、自建双窗口对照坐实；
        // 且第三方远程（网易UU = GameViewerServer）不会置 SM_REMOTESESSION，无从自动检测。
        // 现在：**默认可见**（不设排除）；`EVOFLOW_CUA_RING_CAPTURABLE=0` 才恢复排除捕获，
        // 供需要纯净截图的自动化场景使用。
        let capturable = std::env::var("EVOFLOW_CUA_RING_CAPTURABLE")
            .map(|v| v != "0")
            .unwrap_or(true);
        if capturable {
            eprintln!("[cua-glow-ring] capturable (default: visible to screen capture)");
        } else {
            unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
                };
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            }
        }

        // 呼吸：60ms 一帧；同时抽空消息队列（DestroyWindow 需要）。
        let mut msg = MSG::default();
        while !RING_STOP.load(Ordering::SeqCst) {
            let t = started.elapsed().as_secs_f64() * 1000.0;
            let phase = (t / BREATH_MS * std::f64::consts::TAU).sin();
            // 150..=255 之间呼吸，底噪不熄灭（熄灭会让人以为控制已停）
            let alpha = (202.0 + 53.0 * phase).clamp(140.0, 255.0) as u8;
            push(alpha);
            unsafe {
                while PeekMessageW(&mut msg, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(60));
        }

        unsafe {
            let _ = DestroyWindow(hwnd);
            let _ = DeleteObject(HGDIOBJ(hbmp as *mut core::ffi::c_void));
            let _ = DeleteDC(windows::Win32::Graphics::Gdi::HDC(hdc_mem as *mut _));
        }
        Ok(())
    }

    unsafe extern "system" fn def_window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: windows::Win32::Foundation::WPARAM,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        unsafe { windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

/// 显示全屏蓝光环（覆盖光标所在屏幕）。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn cua_glow_ring_show(app: tauri::AppHandle) -> Result<(), String> {
    let monitor = {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT::default();
        let ok = unsafe { GetCursorPos(&mut pt).is_ok() };
        if ok {
            app.monitor_from_point(pt.x as f64, pt.y as f64).ok().flatten()
        } else {
            None
        }
    };
    let monitor = match monitor {
        Some(m) => Some(m),
        None => app.primary_monitor().ok().flatten(),
    }
    .ok_or_else(|| "no monitor available for glow ring".to_string())?;

    // Tauri 给的是物理像素；分层窗口要的就是物理像素，不换算。
    let pos = monitor.position();
    let size = monitor.size();
    // 蓝光环亮起时同步换成蓝白 AI 光标（豆包同款观感）；失败不挡环。
    crate::commands::cua_glow_cursor::install_cua_cursor();
    imp::spawn_ring(pos.x, pos.y, size.width as i32, size.height as i32)
}

/// 隐藏全屏蓝光环。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn cua_glow_ring_hide() -> Result<(), String> {
    imp::stop_ring();
    crate::commands::cua_glow_cursor::restore_cua_cursor();
    Ok(())
}

// 非 Windows：保持命令存在（前端无条件 invoke），行为是空操作。
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn cua_glow_ring_show(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn cua_glow_ring_hide() -> Result<(), String> {
    Ok(())
}
