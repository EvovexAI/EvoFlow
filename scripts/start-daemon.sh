#!/usr/bin/env bash
#
# start-daemon.sh - Start all EvoFlow development services in daemon mode
#
# This script starts EvoFlow services in the background without keeping
# the terminal connection. Logs are written to separate files.
#
# Must be run from the repo root directory.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Stop existing services ────────────────────────────────────────────────────

echo "Stopping existing services if any..."
pkill -f "langgraph dev" 2>/dev/null || true
pkill -f "uvicorn app.gateway.app:app" 2>/dev/null || true
./scripts/cleanup-containers.sh evo-flow-sandbox 2>/dev/null || true
sleep 1

# ── Banner ────────────────────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo " Starting EvoFlow in Daemon Mode"
echo "=========================================="
echo ""

# ── Config check ─────────────────────────────────────────────────────────────

if ! { \
        [ -n "$EVOFLOW_CONFIG_PATH" ] && [ -f "$EVOFLOW_CONFIG_PATH" ] || \
        [ -f backend/config.yaml ] || \
        [ -f config.yaml ]; \
    }; then
    echo "✗ No EvoFlow config file found."
    echo "  Checked these locations:"
    echo "    - $EVOFLOW_CONFIG_PATH (when EVOFLOW_CONFIG_PATH is set)"
    echo "    - backend/config.yaml"
    echo "    - ./config.yaml"
    echo ""
    echo "  Run 'make config' from the repo root to generate ./config.yaml, then set required model API keys in .env or your config file."
    exit 1
fi

# ── Auto-upgrade config ──────────────────────────────────────────────────

"$REPO_ROOT/scripts/config-upgrade.sh"

# ── Cleanup on failure ───────────────────────────────────────────────────────

cleanup_on_failure() {
    echo "Failed to start services, cleaning up..."
    pkill -f "langgraph dev" 2>/dev/null || true
    pkill -f "uvicorn app.gateway.app:app" 2>/dev/null || true
    echo "✓ Cleanup complete"
}

trap cleanup_on_failure INT TERM

# ── Start services ────────────────────────────────────────────────────────────

mkdir -p logs
LOG_DATE="$(date +%Y-%m-%d)"
(cd backend && PYTHONPATH=. uv run python -c "from app.gateway.logging_setup import prune_old_daily_logs, resolve_gateway_logs_dir; d=resolve_gateway_logs_dir(); prune_old_daily_logs(d,'gateway'); prune_old_daily_logs(d,'langgraph')" 2>/dev/null) || true

echo "Starting LangGraph server..."
nohup sh -c "cd backend && NO_COLOR=1 uv run langgraph dev --no-browser --allow-blocking --no-reload > ../logs/langgraph-${LOG_DATE}.log 2>&1" &
./scripts/wait-for-port.sh 2024 60 "LangGraph" || {
    echo "✗ LangGraph failed to start. Last log output:"
    tail -60 "logs/langgraph-${LOG_DATE}.log"
    if grep -qE "config_version|outdated|Environment variable .* not found|KeyError|ValidationError|config\.yaml" "logs/langgraph-${LOG_DATE}.log" 2>/dev/null; then
        echo ""
        echo "  Hint: This may be a configuration issue. Try running 'make config-upgrade' to update your config.yaml."
    fi
    cleanup_on_failure
    exit 1
}
echo "✓ LangGraph server started on localhost:2024"

echo "Starting Gateway API..."
nohup sh -c "cd backend && PYTHONUNBUFFERED=1 PYTHONPATH=. uv run uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001" &
./scripts/wait-for-port.sh 8001 30 "Gateway API" || {
    echo "✗ Gateway API failed to start. Last log output:"
    tail -60 "logs/gateway-${LOG_DATE}.log" 2>/dev/null || tail -60 logs/gateway.log 2>/dev/null || true
    echo ""
    echo "  Hint: Try running 'make config-upgrade' to update your config.yaml with the latest fields."
    cleanup_on_failure
    exit 1
}
echo "✓ Gateway API started on localhost:8001"

# ── Ready ─────────────────────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo " EvoFlow is running in daemon mode!"
echo "=========================================="
echo ""
echo " 🌐 LangGraph:   http://localhost:2024"
echo " 📡 Gateway:    http://localhost:8001"
echo ""
echo " 📋 Logs (daily, 7-day retention):"
echo " - LangGraph: logs/langgraph-${LOG_DATE}.log"
echo " - Gateway: logs/gateway-${LOG_DATE}.log"
echo ""
echo " 🛑 Stop daemon: make stop"
echo ""
