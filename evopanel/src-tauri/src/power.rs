/// 电源管理模块
/// 在 Windows 上阻止系统进入睡眠状态，确保锁屏后客户端仍能正常运行。
/// macOS / Linux 暂未实现（可用 caffeitate / systemd-inhibit）。

#[cfg(target_os = "windows")]
mod ffi {
    // Windows kernel32 API：控制线程的执行状态，阻止/恢复系统睡眠。
    // https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate
    #[link(name = "kernel32")]
    extern "system" {
        pub fn SetThreadExecutionState(es_flags: u32) -> u32;
    }
}

/// 阻止系统进入睡眠状态。
///
/// Windows: 调用 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`
/// - `ES_CONTINUOUS`     — 状态持续生效直到下次调用
/// - `ES_SYSTEM_REQUIRED` — 阻止系统睡眠（但允许关闭显示器）
///
/// 调用时机：应用启动时调用一次即可，线程存活期间持续生效。
pub fn prevent_system_sleep() {
    #[cfg(target_os = "windows")]
    {
        const ES_CONTINUOUS: u32 = 0x80000000;
        const ES_SYSTEM_REQUIRED: u32 = 0x00000001;
        unsafe {
            let result = ffi::SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            if result == 0 {
                eprintln!("[power] SetThreadExecutionState failed — system may sleep on lock screen");
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // macOS / Linux：可后续通过 caffeinate / systemd-inhibit 实现
    }
}

/// 退出时恢复系统默认睡眠策略。
pub fn restore_system_sleep() {
    #[cfg(target_os = "windows")]
    {
        const ES_CONTINUOUS: u32 = 0x80000000;
        unsafe {
            let _ = ffi::SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}
