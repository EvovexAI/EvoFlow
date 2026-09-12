#!/usr/bin/env bash
# EvoPanel æ¬å°æå»ºèæ¬ï¼macOS / Linuxï¼?# ç¨æ³:
#   ./build.sh                    â?æå»ºå½åå¹³å°å®è£åï¼é»è®¤ï¼?#   ./build.sh --debug            â?Debug æå»ºï¼å¿«ï¼ä¸æåï¼?#   ./build.sh --clean            â?æ¸ç Rust ç¼è¯ç¼å­åæå»?#   ./build.sh --target <triple>  â?æå® Rust targetï¼å¦ x86_64-unknown-linux-gnuï¼?set -euo pipefail

DEBUG=false
CLEAN=false
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) DEBUG=true; shift ;;
    --clean) CLEAN=true; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    *) shift ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
MAGENTA='\033[0;35m'; GRAY='\033[0;90m'; RESET='\033[0m'

step()  { echo -e "\n${CYAN}â?$1${RESET}"; }
ok()    { echo -e "  ${GREEN}â?$1${RESET}"; }
fail()  { echo -e "  ${RED}â?$1${RESET}"; exit 1; }

echo ""
ARCH=$(uname -m)
OS=$(uname)

echo -e "  ${MAGENTA}EvoPanel æå»ºå·¥å·${RESET}"
echo -e "  ${GRAY}âââââââââââââââââââââââââââââââââââââ${RESET}"
if [[ "$OS" == "Darwin" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    echo -e "  ${GRAY}å¹³å°: macOS Apple Silicon (aarch64)${RESET}"
  else
    echo -e "  ${GRAY}å¹³å°: macOS Intel (x86_64)${RESET}"
  fi
else
  echo -e "  ${GRAY}å¹³å°: Linux ${ARCH}${RESET}"
fi
if [[ -n "$TARGET" ]]; then
  echo -e "  ${CYAN}ç®æ : $TARGET${RESET}"
fi
echo -e "  ${GRAY}è·¨å¹³å°æå»?(å¶ä»å¹³å°) è¯·æ¨é?tag è§¦å GitHub Actions${RESET}"
echo ""

# ââ ç¯å¢æ£æµ?ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

step "æ£æ¥æå»ºä¾èµ?

if ! command -v node &>/dev/null; then
  fail "æªæ¾å?Node.jsï¼è¯·ä»?https://nodejs.org å®è£ v18+"
fi
ok "Node.js $(node --version)"

if ! command -v cargo &>/dev/null; then
  fail "æªæ¾å?Rust/Cargoï¼è¯·ä»?https://rustup.rs å®è£"
fi
ok "Rust $(rustc --version)"

# macOS é¢å¤æ£æµ?if [[ "$(uname)" == "Darwin" ]]; then
  if ! command -v xcode-select &>/dev/null || ! xcode-select -p &>/dev/null 2>&1; then
    echo -e "  ${YELLOW}â?æªæ¾å?Xcode Command Line Tools${RESET}"
    echo -e "    è¿è¡: xcode-select --install"
  fi
fi

# Linux é¢å¤æ£æµ?if [[ "$OS" == "Linux" ]]; then
  if command -v dpkg &>/dev/null; then
    # Debian/Ubuntu
    MISSING=()
    for pkg in libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev; do
      if ! dpkg -s "$pkg" &>/dev/null 2>&1; then
        MISSING+=("$pkg")
      fi
    done
    if [ ${#MISSING[@]} -gt 0 ]; then
      echo -e "  ${RED}â?ç¼ºå°ç³»ç»ä¾èµ: ${MISSING[*]}${RESET}"
      echo -e "    è¿è¡: sudo apt-get install -y ${MISSING[*]} libayatana-appindicator3-dev librsvg2-dev patchelf"
      exit 1
    fi
  elif command -v rpm &>/dev/null; then
    # Fedora/RHEL/CentOS
    MISSING=()
    for pkg in webkit2gtk4.1-devel openssl-devel gtk3-devel; do
      if ! rpm -q "$pkg" &>/dev/null 2>&1; then
        MISSING+=("$pkg")
      fi
    done
    if [ ${#MISSING[@]} -gt 0 ]; then
      echo -e "  ${RED}â?ç¼ºå°ç³»ç»ä¾èµ: ${MISSING[*]}${RESET}"
      echo -e "    è¿è¡: sudo dnf install -y ${MISSING[*]} libayatana-appindicator-gtk3-devel librsvg2-devel patchelf"
      exit 1
    fi
  else
    echo -e "  ${GRAY}â?æ æ³èªå¨æ£æµç³»ç»ä¾èµï¼è¯·ç¡®ä¿å·²å®è£ WebKit2GTK 4.1ãOpenSSLãGTK3 å¼åå${RESET}"
  fi
fi

# ââ ä¾èµå®è£ ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

step "å®è£åç«¯ä¾èµ"
if [ ! -d "node_modules" ]; then
  npm ci --silent
  ok "ä¾èµå®è£å®æ"
else
  ok "ä¾èµå·²å­å¨ï¼è·³è¿"
fi

# ââ æ¸çç¼å­ ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

if [ "$CLEAN" = true ]; then
  step "清理 Rust 编译缓存"
  (cd src-tauri && cargo clean)
  ok "缓存已清理"
fi

# ── gateway sidecar（Release 安装包需要内置 evoflow-gateway）────────────────

if [ "$DEBUG" != true ]; then
  step "构建 gateway sidecar"
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  GATEWAY_OUT="$(pwd)/src-tauri/binaries/evoflow-gateway"
  if [[ "$OS" == "Darwin" ]]; then
    GATEWAY_BUILD="${REPO_ROOT}/backend/packaging/macos/build-gateway-macos.sh"
  else
    GATEWAY_BUILD="${REPO_ROOT}/backend/packaging/unix/build-gateway-unix.sh"
  fi
  if [[ ! -f "$GATEWAY_BUILD" ]]; then
    fail "未找到 gateway 构建脚本: $GATEWAY_BUILD"
  fi
  chmod +x "$GATEWAY_BUILD" 2>/dev/null || true
  bash "$GATEWAY_BUILD" "$GATEWAY_OUT"
  if [[ -f "$(pwd)/scripts/sync-version.js" ]]; then
    node scripts/sync-version.js
  fi
  ok "gateway sidecar 就绪"
fi

# ── 构建 ────────────────────────────────────────────────────────────────────

START_TIME=$(date +%s)

# æå»ºåæ°
BUILD_ARGS=""
if [[ -n "$TARGET" ]]; then
  rustup target add "$TARGET" 2>/dev/null || true
  BUILD_ARGS="--target $TARGET"
fi

if [ "$DEBUG" = true ]; then
  step "Debug æå»ºï¼ä¸æåå®è£å¨ï¼"
  npm run tauri build -- --debug $BUILD_ARGS
else
  step "Release æå»º"
  if [[ -n "$TARGET" ]]; then
    echo -e "  ${GRAY}ç®æ : $TARGET${RESET}"
    npm run tauri build -- $BUILD_ARGS
  elif [[ "$OS" == "Darwin" ]] && [[ "$ARCH" == "arm64" ]]; then
    # macOS Apple Silicon: æå»º ARM64 çæ¬
    rustup target add x86_64-apple-darwin 2>/dev/null || true
    echo -e "  ${GRAY}æå»º ARM64 çæ¬...${RESET}"
    npm run tauri build -- --target aarch64-apple-darwin
  else
    npm run tauri build
  fi
fi

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ââ è¾åºç»æ ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

echo ""
echo -e "  ${GREEN}â?æå»ºæåï¼èæ¶ ${ELAPSED}s${RESET}"
echo -e "  ${GRAY}âââââââââââââââââââââââââââââââââââââ${RESET}"

if [ "$DEBUG" = true ]; then
  if [[ -n "$TARGET" ]]; then
    echo -e "  å¯æ§è¡æä»? src-tauri/target/$TARGET/debug/evopanel"
  else
    echo -e "  å¯æ§è¡æä»? src-tauri/target/debug/evopanel"
  fi
else
  if [[ -n "$TARGET" ]]; then
    BUNDLE_DIR="src-tauri/target/$TARGET/release/bundle"
  else
    BUNDLE_DIR="src-tauri/target/release/bundle"
  fi
  if [[ "$OS" == "Darwin" ]]; then
    DMG=$(find "$BUNDLE_DIR/dmg" -name "*.dmg" 2>/dev/null | head -1)
    APP=$(find "$BUNDLE_DIR/macos" -name "*.app" -maxdepth 1 2>/dev/null | head -1)
    [ -n "$DMG" ] && echo -e "  DMG: ${GRAY}$DMG${RESET}"
    [ -n "$APP" ] && echo -e "  APP: ${GRAY}$APP${RESET}"
  else
    APPIMAGE=$(find "$BUNDLE_DIR/appimage" -name "*.AppImage" 2>/dev/null | head -1)
    DEB=$(find "$BUNDLE_DIR/deb" -name "*.deb" 2>/dev/null | head -1)
    [ -n "$APPIMAGE" ] && echo -e "  AppImage: ${GRAY}$APPIMAGE${RESET}"
    [ -n "$DEB" ] && echo -e "  DEB: ${GRAY}$DEB${RESET}"
  fi
fi

echo ""
echo -e "  ${GRAY}æç¤º: åå¸è·¨å¹³å°çæ¬è¯·æ¨é?tagï¼ä¾å¦?${RESET}"
echo -e "  ${GRAY}  git tag v0.1.0 && git push origin v0.1.0${RESET}"
echo ""
