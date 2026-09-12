#!/usr/bin/env python3
"""android_ctl.py - Android device control, zero-dependency CLI.

Two modes (auto-detected):
  1. Rich mode: android-agent backend running at :5055 → REST API (UI elements, OCR, screen tree)
  2. ADB mode: no backend → direct adb commands (devices, tap, type, swipe, screenshot, etc.)

Usage:
  python android_ctl.py devices
  python android_ctl.py screenshot <device> [--save <path>]
  python android_ctl.py elements <device>
  python android_ctl.py tap <device> <x> <y>
  python android_ctl.py type <device> <text>
  python android_ctl.py swipe <device> <x1> <y1> <x2> <y2>
  python android_ctl.py back <device>
  python android_ctl.py home <device>
  python android_ctl.py key <device> <keycode>
  python android_ctl.py launch <device> <package>
  python android_ctl.py stop <device> <package>
  python android_ctl.py packages <device>
  python android_ctl.py screenshot <device> --save shot.jpg

No third-party dependencies. Works with Python 3.8+ and adb in PATH.
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

# ── Config (override via env vars) ──
BACKEND_URL = os.environ.get("ANDROID_AGENT_URL", "http://127.0.0.1:5055")
ADB_CMD = os.environ.get("ADB_CMD", "adb")  # allow custom adb path


# ── Backend detection ──

def _backend_ok() -> bool:
    """Check if android-agent backend is reachable (1s timeout)."""
    try:
        with urllib.request.urlopen(f"{BACKEND_URL}/api/health", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def _api(method: str, path: str, body=None):
    """Call android-agent REST API."""
    url = f"{BACKEND_URL}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


# ── ADB direct ──

def _adb(*args, timeout=15) -> str:
    """Run adb command, return stdout."""
    cmd = [ADB_CMD] + [str(a) for a in args]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"adb {args[0]} failed (exit {r.returncode})")
    return r.stdout.strip()


def _adb_device(device: str, *args, timeout=15) -> str:
    """Run adb -s <device> command."""
    return _adb("-s", device, *args, timeout=timeout)


# ── Commands ──

def cmd_devices():
    if _backend_ok():
        return _api("GET", "/api/phone/devices")
    # ADB fallback
    out = _adb("devices", "-l")
    devices = []
    for line in out.split("\n")[1:]:
        line = line.strip()
        if not line or "List of devices" in line:
            continue
        parts = line.split()
        if len(parts) < 2 or parts[1] != "device":
            continue
        serial = parts[0]
        model = ""
        if "model:" in line:
            model = line.split("model:")[1].split()[0].replace("_", " ")
        devices.append({"serial": serial, "model": model or serial, "connection": "wifi" if ":" in serial else "usb"})
    return {"devices": devices}


def cmd_screenshot(device: str, save_path: str = None):
    if _backend_ok():
        result = _api("GET", f"/api/phone/screenshot/{device}")
        if save_path and result.get("image"):
            import base64
            with open(save_path, "wb") as f:
                f.write(base64.b64decode(result["image"]))
            return {"ok": True, "saved_to": save_path, "format": result.get("format", "jpeg")}
        # Truncate base64 for terminal
        if result.get("image"):
            img = result["image"]
            result["image"] = img[:80] + f"...({len(img)} chars, use --save to file)"
        return result
    # ADB fallback: exec-out screencap
    raw = subprocess.run(
        [ADB_CMD, "-s", device, "exec-out", "screencap", "-p"],
        capture_output=True, timeout=15,
    ).stdout
    if not raw:
        return {"error": "screenshot failed (no data)"}
    if save_path:
        with open(save_path, "wb") as f:
            f.write(raw)
        return {"ok": True, "saved_to": save_path, "format": "png", "size_bytes": len(raw)}
    import base64
    b64 = base64.b64encode(raw).decode()
    return {"ok": True, "format": "png", "image": b64[:80] + f"...({len(b64)} chars, use --save to file)"}


def _adb_dump_ui(device: str) -> str:
    """Dump UI hierarchy via uiautomator to a temp file on device, then cat it back.
    Using /dev/tty doesn't reliably output XML on all devices."""
    _adb_device(device, "shell", "uiautomator", "dump", "/sdcard/ui_dump.xml", timeout=10)
    return _adb_device(device, "shell", "cat", "/sdcard/ui_dump.xml", timeout=10)


def cmd_elements(device: str):
    if _backend_ok():
        return _api("GET", f"/api/phone/elements/{device}")
    # ADB fallback: dump UI XML to temp file, parse
    xml = _adb_dump_ui(device)
    elements = []
    import re
    for m in re.finditer(r'<node\b([^>]*)/?>', xml):
        attrs = m.group(1)
        # Extract key attributes
        def _attr(name):
            mm = re.search(rf'\b{name}="([^"]*)"', attrs)
            return mm.group(1) if mm else ""
        text = _attr("text") or _attr("content-desc")
        rid = _attr("resource-id")
        cls = _attr("class")
        bounds_m = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', attrs)
        clickable = _attr("clickable") == "true"
        if not text and not rid and not clickable:
            continue
        if bounds_m:
            x1, y1, x2, y2 = int(bounds_m.group(1)), int(bounds_m.group(2)), int(bounds_m.group(3)), int(bounds_m.group(4))
            elements.append({
                "idx": len(elements),
                "text": text,
                "resource_id": rid,
                "class": cls.split(".")[-1] if cls else "",
                "clickable": clickable,
                "bounds": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "center": {"x": (x1 + x2) // 2, "y": (y1 + y2) // 2},
            })
    return {"elements": elements, "count": len(elements), "note": "ADB fallback (parsed from uiautomator dump)"}


def cmd_tap(device: str, x: int, y: int):
    if _backend_ok():
        return _api("POST", "/api/phone/tap", {"device": device, "x": x, "y": y})
    _adb_device(device, "shell", "input", "tap", str(x), str(y))
    return {"ok": True}


def cmd_type(device: str, text: str):
    if _backend_ok():
        return _api("POST", "/api/phone/type", {"device": device, "text": text})
    # ADB: encode spaces as %s
    _adb_device(device, "shell", "input", "text", text.replace(" ", "%s"))
    return {"ok": True}


def cmd_swipe(device: str, x1: int, y1: int, x2: int, y2: int, duration: int = 300):
    if _backend_ok():
        return _api("POST", "/api/phone/swipe", {"device": device, "x1": x1, "y1": y1, "x2": x2, "y2": y2})
    _adb_device(device, "shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(duration))
    return {"ok": True}


def cmd_back(device: str):
    if _backend_ok():
        return _api("POST", "/api/phone/back", {"device": device})
    _adb_device(device, "shell", "input", "keyevent", "4")
    return {"ok": True}


def cmd_home(device: str):
    if _backend_ok():
        return _api("POST", "/api/phone/key", {"device": device, "key": "HOME"})
    _adb_device(device, "shell", "input", "keyevent", "3")
    return {"ok": True}


def cmd_key(device: str, key: str):
    keymap = {"HOME": "3", "BACK": "4", "ENTER": "66", "POWER": "26", "MENU": "1", "VOL_UP": "24", "VOL_DOWN": "25"}
    if _backend_ok():
        return _api("POST", "/api/phone/key", {"device": device, "key": key})
    code = keymap.get(key.upper(), key)
    if not code.startswith("KEYCODE_"):
        code = "KEYCODE_" + key.upper()
    _adb_device(device, "shell", "input", "keyevent", code)
    return {"ok": True}


def cmd_launch(device: str, package: str):
    if _backend_ok():
        return _api("POST", "/api/phone/launch", {"device": device, "package": package})
    _adb_device(device, "shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1")
    return {"ok": True}


def cmd_stop(device: str, package: str):
    if _backend_ok():
        return _api("POST", "/api/phone/force-stop", {"device": device, "package": package})
    _adb_device(device, "shell", "am", "force-stop", package)
    return {"ok": True}


def cmd_packages(device: str):
    if _backend_ok():
        return _api("GET", f"/api/phone/packages/{device}")
    raw = _adb_device(device, "shell", "pm", "list", "packages", "-3", timeout=15)
    pkgs = sorted([p.replace("package:", "").strip() for p in raw.splitlines() if p.startswith("package:")])
    return {"packages": pkgs, "count": len(pkgs)}


def cmd_health(device: str):
    if _backend_ok():
        return _api("GET", f"/api/phone/health/{device}")
    # ADB fallback: basic checks
    info = {"serial": device}
    try:
        info["screen_size"] = _adb_device(device, "shell", "wm", "size", timeout=3)
    except:
        info["screen_size"] = "unknown"
    try:
        battery = _adb_device(device, "shell", "dumpsys", "battery", timeout=3)
        for line in battery.split("\n"):
            if "level:" in line:
                info["battery"] = line.strip()
    except:
        pass
    info["status"] = "ok" if _adb_device(device, "get-state", timeout=3) == "device" else "error"
    return info


def cmd_tree(device: str):
    if _backend_ok():
        result = _api("GET", f"/api/phone/screen-tree/{device}")
        if result.get("tree"):
            print(result["tree"])
            return
        return result
    # ADB fallback: dump XML via temp file
    xml = _adb_dump_ui(device)
    print(xml[:5000])
    if len(xml) > 5000:
        print(f"\n... ({len(xml)} chars total)")


# ── CLI ──

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1].lower()
    mode = "rich" if _backend_ok() else "adb"
    result = None

    try:
        if cmd == "devices":
            result = cmd_devices()
        elif cmd == "screenshot":
            if len(sys.argv) < 3:
                print("Usage: screenshot <device> [--save <path>]"); sys.exit(1)
            save = None
            if "--save" in sys.argv:
                idx = sys.argv.index("--save")
                save = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None
            result = cmd_screenshot(sys.argv[2], save)
        elif cmd == "elements":
            if len(sys.argv) < 3:
                print("Usage: elements <device>"); sys.exit(1)
            result = cmd_elements(sys.argv[2])
        elif cmd == "tree":
            if len(sys.argv) < 3:
                print("Usage: tree <device>"); sys.exit(1)
            cmd_tree(sys.argv[2])
            return
        elif cmd == "tap":
            if len(sys.argv) < 5:
                print("Usage: tap <device> <x> <y>"); sys.exit(1)
            result = cmd_tap(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
        elif cmd == "type":
            if len(sys.argv) < 4:
                print("Usage: type <device> <text>"); sys.exit(1)
            result = cmd_type(sys.argv[2], sys.argv[3])
        elif cmd == "swipe":
            if len(sys.argv) < 7:
                print("Usage: swipe <device> <x1> <y1> <x2> <y2>"); sys.exit(1)
            result = cmd_swipe(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]))
        elif cmd == "back":
            if len(sys.argv) < 3:
                print("Usage: back <device>"); sys.exit(1)
            result = cmd_back(sys.argv[2])
        elif cmd == "home":
            if len(sys.argv) < 3:
                print("Usage: home <device>"); sys.exit(1)
            result = cmd_home(sys.argv[2])
        elif cmd == "key":
            if len(sys.argv) < 4:
                print("Usage: key <device> <keycode>"); sys.exit(1)
            result = cmd_key(sys.argv[2], sys.argv[3])
        elif cmd == "launch":
            if len(sys.argv) < 4:
                print("Usage: launch <device> <package>"); sys.exit(1)
            result = cmd_launch(sys.argv[2], sys.argv[3])
        elif cmd == "stop":
            if len(sys.argv) < 4:
                print("Usage: stop <device> <package>"); sys.exit(1)
            result = cmd_stop(sys.argv[2], sys.argv[3])
        elif cmd == "packages":
            if len(sys.argv) < 3:
                print("Usage: packages <device>"); sys.exit(1)
            result = cmd_packages(sys.argv[2])
        elif cmd == "health":
            if len(sys.argv) < 3:
                print("Usage: health <device>"); sys.exit(1)
            result = cmd_health(sys.argv[2])
        else:
            print(f"Unknown command: {cmd}")
            print("Commands: devices, screenshot, elements, tree, tap, type, swipe, back, home, key, launch, stop, packages, health")
            sys.exit(1)
    except Exception as e:
        result = {"error": str(e)}

    if result is not None:
        result["_mode"] = mode  # show which mode was used
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
