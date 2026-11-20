//! Computer Use 蓝白自定义光标（对齐豆包「蓝色虚拟光标」观感）。
//!
//! 在蓝光环亮起时替换系统箭头光标；熄灭时 `SPI_SETCURSORS` 整表恢复。
//! 失败一律静默 —— 光标换不了不能拖死电脑控制主路径。

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
static CURSOR_ON: AtomicBool = AtomicBool::new(false);

/// 光标画布边长（物理像素）。略大于系统默认箭头，方便一眼看出「AI 在控」。
#[cfg(target_os = "windows")]
const CURSOR_SIZE: i32 = 48;
/// 热点：箭头尖端附近。
#[cfg(target_os = "windows")]
const HOTSPOT_X: i32 = 10;
#[cfg(target_os = "windows")]
const HOTSPOT_Y: i32 = 6;

/// 安装蓝白箭头光标。幂等。
#[cfg(target_os = "windows")]
pub fn install_cua_cursor() {
    if CURSOR_ON.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = install_inner() {
        CURSOR_ON.store(false, Ordering::SeqCst);
        eprintln!("[cua-glow-cursor] install failed: {e}");
    }
}

/// 恢复系统默认光标表。幂等。
#[cfg(target_os = "windows")]
pub fn restore_cua_cursor() {
    if !CURSOR_ON.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Err(e) = restore_inner() {
        eprintln!("[cua-glow-cursor] restore failed: {e}");
        // 恢复失败时把标志打回 true，下次 hide 还能再试。
        CURSOR_ON.store(true, Ordering::SeqCst);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn install_cua_cursor() {}

#[cfg(not(target_os = "windows"))]
pub fn restore_cua_cursor() {}

#[cfg(target_os = "windows")]
mod imp {
    use super::{CURSOR_SIZE, HOTSPOT_X, HOTSPOT_Y};
    use windows::core::BOOL;
    use windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, DestroyIcon, SetSystemCursor, SystemParametersInfoW, HCURSOR,
        ICONINFO, OCR_APPSTARTING, OCR_CROSS, OCR_HAND, OCR_IBEAM, OCR_NO, OCR_NORMAL, OCR_SIZEALL,
        OCR_SIZENESW, OCR_SIZENS, OCR_SIZENWSE, OCR_SIZEWE, OCR_UP, OCR_WAIT, SPI_SETCURSORS,
        SYSTEM_CURSOR_ID, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    /// 在 `size×size` BGRA 缓冲里画一支蓝白箭头（白描边 + #3b82f6 填充）。
    pub fn paint_arrow_bgra(size: i32) -> Vec<u8> {
        let mut buf = vec![0u8; (size * size * 4) as usize];
        if size < 16 {
            return buf;
        }
        // 箭头多边形（相对 48 的坐标），之后按 size/48 缩放。
        let scale = size as f64 / 48.0;
        let tip = [
            (6.0, 2.0),
            (6.0, 36.0),
            (14.0, 28.0),
            (22.0, 44.0),
            (28.0, 41.0),
            (20.0, 24.0),
            (32.0, 24.0),
        ];
        let pts: Vec<(f64, f64)> = tip
            .iter()
            .map(|(x, y)| (*x * scale, *y * scale))
            .collect();

        // 两遍：先白描边（外扩），再蓝填充。
        fill_poly(&mut buf, size, &pts, 3.2 * scale, (255, 255, 255, 255));
        fill_poly(&mut buf, size, &pts, 0.0, (59, 130, 246, 255));
        buf
    }

    fn point_in_poly(x: f64, y: f64, pts: &[(f64, f64)]) -> bool {
        let n = pts.len();
        if n < 3 {
            return false;
        }
        let mut inside = false;
        let mut j = n - 1;
        for i in 0..n {
            let (xi, yi) = pts[i];
            let (xj, yj) = pts[j];
            let denom = yj - yi;
            if denom.abs() > 1e-9
                && ((yi > y) != (yj > y))
                && (x < (xj - xi) * (y - yi) / denom + xi)
            {
                inside = !inside;
            }
            j = i;
        }
        inside
    }

    fn dist_to_edges(x: f64, y: f64, pts: &[(f64, f64)]) -> f64 {
        let n = pts.len();
        let mut best = f64::MAX;
        for i in 0..n {
            let (x1, y1) = pts[i];
            let (x2, y2) = pts[(i + 1) % n];
            let dx = x2 - x1;
            let dy = y2 - y1;
            let len2 = dx * dx + dy * dy;
            let t = if len2 <= 1e-9 {
                0.0
            } else {
                ((x - x1) * dx + (y - y1) * dy) / len2
            }
            .clamp(0.0, 1.0);
            let px = x1 + t * dx;
            let py = y1 + t * dy;
            let d = ((x - px).powi(2) + (y - py).powi(2)).sqrt();
            if d < best {
                best = d;
            }
        }
        best
    }

    fn fill_poly(buf: &mut [u8], size: i32, pts: &[(f64, f64)], outset: f64, rgba: (u8, u8, u8, u8)) {
        let (r, g, b, a) = rgba;
        for y in 0..size {
            for x in 0..size {
                let fx = x as f64 + 0.5;
                let fy = y as f64 + 0.5;
                let inside = point_in_poly(fx, fy, pts);
                let near = outset > 0.0 && dist_to_edges(fx, fy, pts) <= outset;
                if inside || near {
                    let i = ((y * size + x) * 4) as usize;
                    // BGRA
                    buf[i] = b;
                    buf[i + 1] = g;
                    buf[i + 2] = r;
                    buf[i + 3] = a;
                }
            }
        }
    }

    fn build_cursor() -> Result<HCURSOR, String> {
        let size = CURSOR_SIZE;
        let bgra = paint_arrow_bgra(size);

        let hdc = unsafe { CreateCompatibleDC(None) };
        if hdc.is_invalid() {
            return Err("CreateCompatibleDC failed".into());
        }

        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size,
            biHeight: -size, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let color = unsafe {
            CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
        }
        .map_err(|e| format!("CreateDIBSection: {e}"))?;
        if bits.is_null() {
            unsafe {
                let _ = DeleteDC(hdc);
            }
            return Err("CreateDIBSection null bits".into());
        }
        let slice =
            unsafe { std::slice::from_raw_parts_mut(bits as *mut u8, (size * size * 4) as usize) };
        // 预乘 alpha（光标合成需要）
        for i in 0..(size * size) as usize {
            let o = i * 4;
            let a = bgra[o + 3] as u32;
            slice[o] = ((bgra[o] as u32 * a) / 255) as u8;
            slice[o + 1] = ((bgra[o + 1] as u32 * a) / 255) as u8;
            slice[o + 2] = ((bgra[o + 2] as u32 * a) / 255) as u8;
            slice[o + 3] = bgra[o + 3];
        }

        // 1bpp mask：全 0 = 用彩色位图 alpha（Windows 对 32bpp 光标的惯例）
        let mask_stride = ((size + 31) / 32) * 4;
        let mask_bytes = vec![0u8; (mask_stride * size) as usize];
        let mask = unsafe { CreateBitmap(size, size, 1, 1, Some(mask_bytes.as_ptr() as *const _)) };
        if mask.is_invalid() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(color.0));
                let _ = DeleteDC(hdc);
            }
            return Err("CreateBitmap mask failed".into());
        }

        let info = ICONINFO {
            fIcon: BOOL(0), // cursor
            xHotspot: HOTSPOT_X as u32,
            yHotspot: HOTSPOT_Y as u32,
            hbmMask: mask,
            hbmColor: color,
        };
        let icon = unsafe { CreateIconIndirect(&info) }.map_err(|e| format!("CreateIconIndirect: {e}"))?;

        // CreateIconIndirect 会复制位图，原 HBITMAP 可删。
        unsafe {
            let _ = DeleteObject(HGDIOBJ(mask.0));
            let _ = DeleteObject(HGDIOBJ(color.0));
            let _ = DeleteDC(hdc);
        }
        Ok(HCURSOR(icon.0))
    }

    /// `SetSystemCursor` 会吃掉传入的 HCURSOR（调用后不可 Destroy）。
    /// 每种形状都要各自一份拷贝。
    fn replace_shape(shape: SYSTEM_CURSOR_ID) -> Result<(), String> {
        let cur = build_cursor()?;
        let ok = unsafe { SetSystemCursor(cur, shape) };
        if ok.is_err() {
            // SetSystemCursor 失败时所有权仍在我们这边
            unsafe {
                let _ = DestroyIcon(windows::Win32::UI::WindowsAndMessaging::HICON(cur.0));
            }
            return Err(format!("SetSystemCursor({shape:?}) failed"));
        }
        Ok(())
    }

    pub fn install() -> Result<(), String> {
        // 主箭头 + 常见变形，避免 AI 拖/点到输入框时突然变回系统白箭头。
        for shape in [
            OCR_NORMAL,
            OCR_HAND,
            OCR_IBEAM,
            OCR_WAIT,
            OCR_APPSTARTING,
            OCR_CROSS,
            OCR_SIZEALL,
            OCR_SIZENS,
            OCR_SIZEWE,
            OCR_SIZENESW,
            OCR_SIZENWSE,
            OCR_UP,
            OCR_NO,
        ] {
            replace_shape(shape)?;
        }
        Ok(())
    }

    pub fn restore() -> Result<(), String> {
        unsafe {
            SystemParametersInfoW(
                SPI_SETCURSORS,
                0,
                None,
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        }
        .map_err(|e| format!("SPI_SETCURSORS: {e}"))
    }
}

#[cfg(target_os = "windows")]
fn install_inner() -> Result<(), String> {
    imp::install()
}

#[cfg(target_os = "windows")]
fn restore_inner() -> Result<(), String> {
    imp::restore()
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::imp::paint_arrow_bgra;

    #[test]
    fn arrow_has_blue_and_white_pixels() {
        let buf = paint_arrow_bgra(48);
        let mut blue = 0u32;
        let mut white = 0u32;
        for i in 0..(48 * 48) {
            let o = i * 4;
            let (b, g, r, a) = (buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
            if a < 200 {
                continue;
            }
            if r > 200 && g > 200 && b > 200 {
                white += 1;
            }
            // #3b82f6 ≈ (59,130,246)
            if r < 100 && g > 100 && g < 160 && b > 200 {
                blue += 1;
            }
        }
        assert!(blue > 40, "expected blue fill pixels, got {blue}");
        assert!(white > 20, "expected white outline pixels, got {white}");
    }
}
