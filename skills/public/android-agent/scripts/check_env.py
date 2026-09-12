#!/usr/bin/env python3
"""check_env.py - android-agent 环境一键检查

用法:
  python check_env.py

检查项目:
  1. Python 版本 >= 3.8
  2. adb 是否可用（PATH 或 ADB_CMD 环境变量）
  3. 是否有 Android 设备连接
  4. android-agent 后端是否运行（可选，增强模式）

零依赖，Python 3.8+ 即可运行。
"""
import os
import shutil
import subprocess
import sys
import urllib.request

# ── ANSI colors (Windows 10+ supports) ──
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
RESET = "\033[0m"
BOLD = "\033[1m"

# Windows: enable ANSI escape
if sys.platform == "win32":
    os.system("")  # trick to enable VT processing


def _ok(msg):   print(f"  {GREEN}✓{RESET} {msg}")
def _fail(msg): print(f"  {RED}✗{RESET} {msg}")
def _warn(msg): print(f"  {YELLOW}!{RESET} {msg}")
def _info(msg): print(f"  {CYAN}ℹ{RESET} {msg}")


def banner(title):
    print(f"\n{BOLD}{'─' * 50}{RESET}")
    print(f"{BOLD} {title}{RESET}")
    print(f"{BOLD}{'─' * 50}{RESET}")


# ── Checks ──

def check_python():
    banner("1/4  Python 运行环境")
    v = sys.version_info
    ver_str = f"{v.major}.{v.minor}.{v.micro}"
    if v >= (3, 8):
        _ok(f"Python {ver_str} ({sys.executable})")
        return True
    else:
        _fail(f"Python {ver_str} 版本过低，需要 3.8+")
        _info("下载: https://www.python.org/downloads/")
        return False


def check_adb():
    banner("2/4  ADB 工具")
    adb_cmd = os.environ.get("ADB_CMD", "adb")

    # Try direct
    if shutil.which(adb_cmd) or os.path.isfile(adb_cmd):
        try:
            ver = subprocess.run(
                [adb_cmd, "version"],
                capture_output=True, text=True, timeout=5,
            )
            ver_line = ver.stdout.strip().split("\n")[0] if ver.stdout else "unknown"
            _ok(f"adb 可用: {ver_line}")
            _info(f"路径: {shutil.which(adb_cmd) or adb_cmd}")
            return adb_cmd
        except Exception as e:
            _fail(f"adb 存在但执行失败: {e}")
    else:
        _fail(f"未找到 adb（当前 PATH 中无 '{adb_cmd}'）")

    # Provide fix hints
    print()
    _info("adb 是 Android SDK Platform Tools 的一部分，免费下载:")
    _info("  Windows:  https://dl.google.com/android/repository/platform-tools-latest-windows.zip")
    _info("  macOS:    https://dl.google.com/android/repository/platform-tools-latest-darwin.zip")
    _info("  Linux:    https://dl.google.com/android/repository/platform-tools-latest-linux.zip")
    print()
    _info("安装方法:")
    _info("  1. 下载对应系统的 ZIP，解压到任意目录（如 D:\\platform-tools）")
    _info("  2. 将解压目录加入系统 PATH 环境变量")
    _info("  3. 或者不设 PATH，直接指定路径:")
    if sys.platform == "win32":
        _info('     set ADB_CMD=D:\\platform-tools\\adb.exe')
        _info('     python scripts/check_env.py')
    else:
        _info('     export ADB_CMD=/opt/platform-tools/adb')
        _info('     python scripts/check_env.py')
    print()
    _info("  解压后即可使用，无需安装完整的 Android Studio。")
    return None


def check_devices(adb_cmd):
    banner("3/4  Android 设备连接")
    if not adb_cmd:
        _warn("跳过（adb 不可用）")
        return False

    try:
        out = subprocess.run(
            [adb_cmd, "devices", "-l"],
            capture_output=True, text=True, timeout=5,
        )
        lines = out.stdout.strip().split("\n")
        devices = []
        for line in lines[1:]:
            line = line.strip()
            if not line or "List of devices" in line:
                continue
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "device":
                serial = parts[0]
                model = ""
                if "model:" in line:
                    model = line.split("model:")[1].split()[0].replace("_", " ")
                devices.append((serial, model))

        if devices:
            _ok(f"检测到 {len(devices)} 台设备:")
            for serial, model in devices:
                _info(f"  {serial}  {model}")
            return True
        else:
            _fail("没有检测到已连接的 Android 设备")
            print()
            _info("连接设备的方法:")
            _info("  ▸ 真机: 设置 -> 开发者选项 -> 开启 USB 调试 -> 用数据线连接电脑")
            _info("  ▸ 模拟器: 安装 Android Studio 后创建 AVD，或使用其他模拟器（夜神/雷电等）")
            _info("  ▸ 模拟器通常自动连接，如不显示试试: adb kill-server && adb start-server")
            return False
    except Exception as e:
        _fail(f"检测设备失败: {e}")
        return False


def check_backend():
    banner("4/4  android-agent 后端（可选，增强模式）")
    url = os.environ.get("ANDROID_AGENT_URL", "http://127.0.0.1:5055")
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=1) as r:
            if r.status == 200:
                _ok(f"后端运行中: {url}")
                _info("增强模式已就绪（UI 元素解析、OCR、屏幕树等）")
                return True
    except Exception:
        pass

    _warn(f"后端未运行（{url}）")
    _info("不影响基础模式使用，设备列表/点击/输入/截图等全部可用。")
    _info("如需增强功能（OCR、完整 UI 树），请启动 android-agent 后端。")
    return False


# ── Main ──

def main():
    print(f"\n{BOLD}╔══════════════════════════════════════════════╗{RESET}")
    print(f"{BOLD}║   android-agent 环境检查                     ║{RESET}")
    print(f"{BOLD}╚══════════════════════════════════════════════╝{RESET}")
    print(f"  操作系统: {sys.platform}")
    print(f"  检查脚本: {os.path.abspath(__file__)}")

    py_ok = check_python()
    adb_cmd = check_adb() if py_ok else None
    dev_ok = check_devices(adb_cmd) if adb_cmd else False
    backend_ok = check_backend()

    # ── Summary ──
    banner("检查结果汇总")
    results = [
        ("Python 3.8+",     py_ok),
        ("adb 工具",          bool(adb_cmd)),
        ("Android 设备",      dev_ok),
        ("增强后端（可选）",   backend_ok),
    ]
    for name, ok in results:
        if ok:
            print(f"  {GREEN}✓{RESET} {name}")
        elif name.endswith("（可选）"):
            print(f"  {YELLOW}!{RESET} {name}（未启用）")
        else:
            print(f"  {RED}✗{RESET} {name}")

    print()
    if py_ok and adb_cmd and dev_ok:
        print(f"{GREEN}{BOLD}  🎉 基础模式就绪！可以开始使用了。{RESET}")
        print()
        _info("快速测试:")
        script_dir = os.path.dirname(os.path.abspath(__file__))
        ctl = os.path.join(script_dir, "android_ctl.py")
        _info(f'  python "{ctl}" devices')
        _info(f'  python "{ctl}" elements <your-device-serial>')
        if not backend_ok:
            print()
            _info("增强后端未运行，基础模式功能已足够日常使用。")
    elif not py_ok:
        print(f"{RED}{BOLD}  ⚠ 请先安装 Python 3.8+{RESET}")
    elif not adb_cmd:
        print(f"{RED}{BOLD}  ⚠ 请先安装 adb（Platform Tools）{RESET}")
    elif not dev_ok:
        print(f"{YELLOW}{BOLD}  ⚠ adb 已就绪，请连接 Android 设备{RESET}")

    print()


if __name__ == "__main__":
    main()
