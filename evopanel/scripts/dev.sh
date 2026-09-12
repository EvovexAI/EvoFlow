#!/bin/bash
# EvoPanel å¼åæ¨¡å¼å¯å¨èæ?# ç¨æ³: ./scripts/dev.sh [web|tauri]
#   web   - ä»å¯å?Vite åç«¯ï¼æµè§å¨è°è¯ï¼mock æ°æ®ï¼?#   tauri - å¯å¨å®æ´ Tauri æ¡é¢åºç¨ï¼é»è®¤ï¼

set -e
cd "$(dirname "$0")/.."

MODE="${1:-tauri}"

# æ¸çæ§è¿ç¨?cleanup() {
  echo "ð§¹ æ¸çæ§è¿ç¨?.."
  pkill -f "vite.*evopanel" 2>/dev/null || true
  pkill -f "target/debug/evopanel" 2>/dev/null || true
  lsof -ti:1421 | xargs kill -9 2>/dev/null || true
  sleep 0.5
}

cleanup

case "$MODE" in
  web)
    echo "ð å¯å¨ Vite åç«¯å¼åæå¡å¨ï¼æµè§å¨æ¨¡å¼ï¼?.."
    echo "   å°å: http://localhost:1421"
    echo "   ä½¿ç¨ mock æ°æ®ï¼éåè°è¯åç«¯é»è¾"
    echo ""
    npx vite --port 1421
    ;;
  tauri)
    echo "ð¥ï¸? å¯å¨ Tauri æ¡é¢åºç¨ï¼å®æ´æ¨¡å¼ï¼..."
    echo "   Vite + Rust åç«¯"
    echo ""
    npm run tauri dev
    ;;
  *)
    echo "ç¨æ³: $0 [web|tauri]"
    echo "  web   - ä»?Vite åç«¯ï¼æµè§å¨è°è¯ï¼?
    echo "  tauri - Tauri æ¡é¢åºç¨ï¼é»è®¤ï¼"
    exit 1
    ;;
esac
