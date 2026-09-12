#!/bin/bash
# EvoPanel ç¼è¯èæ¬
# ç¨æ³: ./scripts/build.sh [check|debug|release]
#   check   - ä»æ£æ?Rust ç¼è¯ï¼æå¿«ï¼ä¸çæäº§ç©ï¼
#   debug   - ç¼è¯ debug çæ¬ï¼é»è®¤ï¼
#   release - ç¼è¯æ­£å¼åå¸çæ¬ï¼å«æåï¼?
set -e
cd "$(dirname "$0")/.."

MODE="${1:-debug}"

case "$MODE" in
  check)
    echo "ð æ£æ?Rust ç¼è¯..."
    cd src-tauri && cargo check
    echo "â?ç¼è¯æ£æ¥éè¿"
    ;;
  debug)
    echo "ð¨ ç¼è¯ debug çæ¬..."
    echo "   1/2 æå»ºåç«¯..."
    npm run build
    echo "   2/2 ç¼è¯ Rust..."
    cd src-tauri && cargo build
    echo "â?Debug ç¼è¯å®æ"
    echo "   äº§ç©: src-tauri/target/debug/evopanel"
    ;;
  release)
    echo "ð¦ ç¼è¯æ­£å¼åå¸çæ¬..."
    npm run tauri build
    echo "â?Release ç¼è¯å®æ"
    echo "   äº§ç©ç®å½: src-tauri/target/release/bundle/"
    ;;
  *)
    echo "ç¨æ³: $0 [check|debug|release]"
    echo "  check   - ä»æ£æ?Rust ç¼è¯ï¼æå¿«ï¼"
    echo "  debug   - debug çæ¬ï¼é»è®¤ï¼"
    echo "  release - æ­£å¼åå¸çæ¬"
    exit 1
    ;;
esac
