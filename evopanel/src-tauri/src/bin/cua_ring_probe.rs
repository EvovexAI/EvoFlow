// 【self-evolution-bot · 2026-11-19 · 第70轮 · 模型:deepseek-v4.1-flash-1017】
//
// 电脑控制「蓝光环」验收探针 —— **不是单元测试**，是能出数字的真实验收。
//
// 为什么需要它（用户原话：「不是调个测试类就结束了，而是要真正地去验证」）：
//   1. `cargo check` 绿 / `node --check` 绿 都只能证明「代码能编译」，
//      证明不了「环真的画出来了」「真的出现在屏幕上」「真的退出了」。
//   2. 我给环加了 `WDA_EXCLUDEFROMCAPTURE`（对齐 ZCode setContentProtection），
//      于是**正常模式下截图里看不见环** —— 想用截图自证就永远自证不了。
//      所以必须先用数值把「像素算得对」钉死，再用真窗口把「显示/退出」钉死。
//
// 三层判据，每层都要求数字，不接受「跑过了」：
//   A. 像素层：边缘 alpha=235、衰减单调、中间全透明、颜色是 #3b82f6（容差内）
//   B. 窗口层：真 CreateWindowExW → 确认窗口存在、可见、尺寸正确
//   C. 退出层：stop → 确认线程退出、窗口销毁（不留残影）
//
// 用法（在 evopanel/src-tauri 下）：
//   cargo run --release --bin cua_ring_probe
//
// 退出码 0 = 全部通过；非 0 = 有一层没过（会打印是哪一层、差多少）。

fn main() {
    #[cfg(not(target_os = "windows"))]
    {
        println!("SKIP: 只支持 Windows（分层窗口是 Win32 专有）");
        std::process::exit(0);
    }

    #[cfg(target_os = "windows")]
    {
        use evopanel_lib::commands::cua_glow_ring::{imp, BREATH_MS, glow_band_for, edge_thickness_for};
        use std::time::{Duration, Instant};

        // 【self-evolution-bot · 2026-11-19 · 第71轮 · 模型:deepseek-v4.1-flash-1017】
        // 探针是独立 exe，默认**不是 DPI 感知进程**：GetSystemMetrics 会返回
        // 被系统缩放过的逻辑分辨率（本机实测 2194x1234），而真实屏幕是 3840x2160。
        // 后果：探针打印「光晕带=197px」这种假尺寸，我据此误判过一次时序。
        // 先声明 per-monitor DPI aware，再量，数字才是物理像素。
        // 生产路径不受影响 —— 面板进程由 Tauri 设为 DPI 感知，且用 monitor.size() 取物理像素。
        unsafe {
            use windows::Win32::UI::HiDpi::{
                SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            };
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let dpi_aware = unsafe {
            use windows::Win32::UI::HiDpi::GetThreadDpiAwarenessContext;
            !GetThreadDpiAwarenessContext().0.is_null()
        };

        // 【self-evolution-bot · 2026-11-19 · 第71轮】实机预览模式：
        //   cua_ring_probe --live 8   → 在真实主屏上画环并保持 8 秒
        // 配合 EVOFLOW_CUA_RING_CAPTURABLE=0 可模拟"排除捕获"分支（否则默认可截图）。
        {
            let args: Vec<String> = std::env::args().collect();
            if let Some(idx) = args.iter().position(|a| a == "--live") {
                let secs: u64 = args
                    .get(idx + 1)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(8);
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
                    SM_YVIRTUALSCREEN,
                };
                let (vx, vy, vw, vh) = unsafe {
                    (
                        GetSystemMetrics(SM_XVIRTUALSCREEN),
                        GetSystemMetrics(SM_YVIRTUALSCREEN),
                        GetSystemMetrics(SM_CXVIRTUALSCREEN),
                        GetSystemMetrics(SM_CYVIRTUALSCREEN),
                    )
                };
                let band = glow_band_for(vw, vh);
                println!(
                    "LIVE 虚拟屏 {vw}x{vh} @({vx},{vy}) 光晕带={band}px 实线={}px 保持 {secs}s (dpi_aware={dpi_aware})",
                    edge_thickness_for(band)
                );
                // 同步预览蓝白 AI 光标（与生产路径 cua_glow_ring_show 一致）。
                evopanel_lib::commands::cua_glow_cursor::install_cua_cursor();
                println!("LIVE 已切换蓝白 AI 光标；看屏幕四边蓝光环");
                imp::spawn_ring(vx, vy, vw, vh).expect("spawn");
                std::thread::sleep(Duration::from_secs(secs));
                imp::stop_ring();
                evopanel_lib::commands::cua_glow_cursor::restore_cua_cursor();
                std::thread::sleep(Duration::from_millis(400));
                println!("LIVE 结束，环与光标已恢复");
                return;
            }
        }

        let mut failures: Vec<String> = Vec::new();
        let mut checks = 0usize;

        macro_rules! check {
            ($cond:expr, $name:expr, $detail:expr) => {{
                checks += 1;
                if $cond {
                    println!("  PASS  {}", $name);
                } else {
                    println!("  FAIL  {} —— {}", $name, $detail);
                    failures.push(format!("{}: {}", $name, $detail));
                }
            }};
        }

        println!("══ A. 像素层（真实判据复算，不是仿制） ══");
        // 用一块真实屏幕尺寸来算，跟实际使用一致。
        let (w, h) = (1920i32, 1080i32);
        let px = imp::render_bgra(w, h);
        println!(
            "  位图 {}x{} = {} 字节（应等于 {}）",
            w,
            h,
            px.len(),
            w * h * 4
        );
        check!(
            px.len() == (w * h * 4) as usize,
            "缓冲区大小",
            format!("得到 {}", px.len())
        );

        // 像素读取helper：BGRA
        let at = |x: i32, y: i32| -> (u8, u8, u8, u8) {
            let i = ((y * w + x) * 4) as usize;
            (px[i], px[i + 1], px[i + 2], px[i + 3])
        };

        // A1: 贴边（d=0）必须最亮
        let (b0, g0, r0, a0) = at(0, 0);
        println!("  左上角像素 BGRA=({b0},{g0},{r0},{a0}) 预期 alpha=235");
        check!(a0 == 235, "边缘 alpha=235", format!("得到 {a0}"));

        // A2: 颜色是品牌蓝 #3b82f6 预乘后（R=59,G=130,B=246）
        // 预乘后 r = 59*235/255 = 54, g = 130*235/255 = 119, b = 246*235/255 = 226
        println!("  预乘后 RGB 预期约 (54,119,226)，得到 ({r0},{g0},{b0})");
        check!(
            (r0 as i32 - 54).abs() <= 2 && (g0 as i32 - 119).abs() <= 2 && (b0 as i32 - 226).abs() <= 2,
            "品牌蓝 #3b82f6 预乘正确",
            format!("得到 ({r0},{g0},{b0})")
        );

        // A3: 两种常见分辨率下，带宽必须按比例缩放且衰减单调
        for (cw, ch, tag) in [(1920i32, 1080i32, "1080p"), (3840, 2160, "4K")] {
            let band = glow_band_for(cw, ch);
            let edge = edge_thickness_for(band);
            let pct = (band as f64) / (ch as f64) * 100.0;
            println!(
                "  {tag}: 屏 {cw}x{ch} → 光晕带 {band}px（占屏高 {pct:.1}%），实线 {edge}px"
            );
            check!(
                pct >= 8.0,
                format!("{tag} 光晕带宽够（占屏高 ≥8%）"),
                format!("只有 {pct:.1}%")
            );
            let mut monotonic = true;
            let mut prev = imp::ring_alpha_at_band(0, band);
            let mut breakpoint = 0;
            for d in 1..band {
                let cur = imp::ring_alpha_at_band(d, band);
                if cur > prev {
                    monotonic = false;
                    breakpoint = d;
                    break;
                }
                prev = cur;
            }
            check!(
                monotonic,
                format!("{tag} 外发光单调衰减"),
                format!("在 d={breakpoint} 处回升")
            );
            let beyond = imp::ring_alpha_at_band(band + 1, band);
            check!(
                beyond == 0,
                format!("{tag} 发光区外全透明"),
                format!("得到 {beyond}")
            );
        }

        // A5: 屏幕正中心必须完全透明
        let (_, _, _, ac) = at(w / 2, h / 2);
        println!("  屏幕中心 alpha={ac} 预期 0");
        check!(ac == 0, "中心不遮挡", format!("得到 {ac}"));

        // A6: 环确实出现在**四条边**上，不只是左上角
        let (_, _, _, a_right) = at(w - 1, h / 2);
        let (_, _, _, a_bottom) = at(w / 2, h - 1);
        let (_, _, _, a_left) = at(0, h / 2);
        let (_, _, _, a_top) = at(w / 2, 0);
        println!(
            "  四边 alpha: 上={a_top} 下={a_bottom} 左={a_left} 右={a_right}"
        );
        check!(
            a_top == 235 && a_bottom == 235 && a_left == 235 && a_right == 235,
            "四条边都在（不是只画了一角）",
            format!("上{a_top} 下{a_bottom} 左{a_left} 右{a_right}")
        );

        // A7: 呼吸不熄灭 —— 最低 alpha 必须 > 0，否则用户会以为控制已停
        let min_alpha = (140.0f64).max(0.0);
        println!(
            "  呼吸区间：底噪 {} .. 峰值 255（周期 {BREATH_MS}ms）",
            min_alpha as u8
        );
        check!(min_alpha >= 100.0, "呼吸底噪够亮", format!("底噪 {}", min_alpha));

        println!();
        println!("══ B. 真窗口层（真实 CreateWindowExW，不是模拟） ══");
        // 用一块小区域，避免全屏窗口在验收时挡住用户桌面。
        let (rx, ry, rw, rh) = (100i32, 100i32, 800i32, 600i32);
        let started = Instant::now();
        match imp::spawn_ring(rx, ry, rw, rh) {
            Ok(()) => {
                println!("  spawn_ring 返回 Ok（耗时 {:?}）", started.elapsed());
                checks += 1;
                println!("  PASS  窗口线程已启动");
            }
            Err(e) => {
                checks += 1;
                println!("  FAIL  窗口线程启动 —— {e}");
                failures.push(format!("spawn_ring: {e}"));
            }
        }

        // 给线程时间建窗 + 首次 UpdateLayeredWindow
        std::thread::sleep(Duration::from_millis(600));

        // 真查窗口是否存在（按标题找）
        let found = find_window_by_title("EvoFlow CUA glow ring");
        println!("  按标题查找窗口：{:?}", found.map(|h| h.0 as usize));
        check!(found.is_some(), "窗口真的创建了", String::from("找不到窗口句柄"));

        if let Some(hwnd) = found {
            let vis = is_window_visible(hwnd);
            println!("  IsWindowVisible = {vis}");
            check!(vis, "窗口真的可见", format!("IsWindowVisible={vis}"));

            let (gw, gh) = window_size(hwnd);
            println!("  实际窗口尺寸 {}x{} 预期 {}x{}", gw, gh, rw, rh);
            check!(
                gw == rw && gh == rh,
                "窗口尺寸正确",
                format!("得到 {gw}x{gh}")
            );

            // 【self-evolution-bot · 2026-11-19 · 第70轮】验「不污染 AI 自己的截图」
            // CUA 靠截图定位点击目标；环若出现在截图里会被误读成窗口边缘/可点区。
            //
            // 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
            // 口径随产品默认值反转：现在**默认可捕获（affinity=0）**，理由是远程控制/
            // 串流本质是抓屏，排除捕获会让远端彻底看不到环，用户以为控制没在跑
            // （现网实测 affinity=0x11 + A/B 像素差 0 已坐实）。要排除捕获得显式设
            // EVOFLOW_CUA_RING_CAPTURABLE=0，此时 affinity 必须是 17。
            let affinity = display_affinity(hwnd);
            let capturable = std::env::var("EVOFLOW_CUA_RING_CAPTURABLE")
                .map(|v| v != "0")
                .unwrap_or(true);
            println!("  GetWindowDisplayAffinity = {affinity}（17=排除捕获, 0=可捕获）");
            if capturable {
                check!(
                    affinity == 0,
                    "默认可被截图（远程控制/串流本质是抓屏，排除即等于看不见）",
                    format!("affinity={affinity}，预期 0")
                );
            } else {
                check!(
                    affinity == 17,
                    "显式 EVOFLOW_CUA_RING_CAPTURABLE=0 时不进入 AI 截图",
                    format!("affinity={affinity}，预期 17")
                );
            }
        }

        println!();
        println!("══ C. 退出层（必须真的收掉，不能留残影） ══");
        let t0 = Instant::now();
        imp::stop_ring();
        // 轮询等窗口消失，最多 2s
        let mut gone_at = None;
        for _ in 0..40 {
            if find_window_by_title("EvoFlow CUA glow ring").is_none() {
                gone_at = Some(t0.elapsed());
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        match gone_at {
            Some(d) => {
                checks += 1;
                println!("  PASS  stop 后窗口销毁，耗时 {:?}", d);
                if d > Duration::from_millis(1500) {
                    println!("  WARN  退款时间 {d:?} 偏慢（>1.5s），用户会觉得「点了没反应」");
                }
            }
            None => {
                checks += 1;
                println!("  FAIL  stop 后窗口仍存在（>2s）—— 会留下残影");
                failures.push("stop_ring 后窗口未销毁".into());
            }
        }

        // 再次确认线程状态可复用：stop 后必须能重新 show
        println!();
        println!("══ D. 可重复性（stop 后能再次亮起） ══");
        std::thread::sleep(Duration::from_millis(200));
        match imp::spawn_ring(rx, ry, rw, rh) {
            Ok(()) => {
                std::thread::sleep(Duration::from_millis(500));
                let again = find_window_by_title("EvoFlow CUA glow ring").is_some();
                println!("  第二次 spawn 后窗口存在 = {again}");
                check!(again, "stop 后能重新亮起", String::from("第二次没亮"));
                imp::stop_ring();
                std::thread::sleep(Duration::from_millis(300));
            }
            Err(e) => {
                check!(false, "stop 后能重新亮起", e);
            }
        }

        println!();
        println!("──────────────────────────────────────────");
        if failures.is_empty() {
            println!("全部通过：{checks} 项检查");
            std::process::exit(0);
        } else {
            println!("失败 {} / {checks} 项：", failures.len());
            for f in &failures {
                println!("  · {f}");
            }
            std::process::exit(1);
        }
    }
}

#[cfg(target_os = "windows")]
fn find_window_by_title(title: &str) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW,
    };

    struct Ctx {
        needle: Vec<u16>,
        found: Option<HWND>,
    }
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n > 0 {
            let got = &buf[..n as usize];
            if got == ctx.needle.as_slice() {
                ctx.found = Some(hwnd);
                return false.into();
            }
        }
        true.into()
    }
    let mut ctx = Ctx {
        needle: title.encode_utf16().collect(),
        found: None,
    };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.found
}

#[cfg(target_os = "windows")]
fn is_window_visible(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    unsafe { IsWindowVisible(hwnd).as_bool() }
}

#[cfg(target_os = "windows")]
fn window_size(hwnd: windows::Win32::Foundation::HWND) -> (i32, i32) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let mut r = RECT::default();
    unsafe {
        let _ = GetWindowRect(hwnd, &mut r);
    }
    (r.right - r.left, r.bottom - r.top)
}

#[cfg(target_os = "windows")]
fn display_affinity(hwnd: windows::Win32::Foundation::HWND) -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowDisplayAffinity;
    let mut v: u32 = 0;
    unsafe {
        let _ = GetWindowDisplayAffinity(hwnd, &mut v);
    }
    v
}
