#!/bin/bash
# =============================================================================
# EvoPanel Docker é¨ç½²èæ¬
# =============================================================================
# åè½:
#   1. æ£æ?Docker ç¯å¢
#   2. æå»º Docker éå
#   3. å¯å¨/åæ­¢/éå¯å®¹å¨
#   4. æ¥çæ¥å¿
#   5. å¸¸è§é®é¢ææ¥
# =============================================================================

set -e

# -----------------------------------------------------------------------------
# é¢è²å®ä¹
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# -----------------------------------------------------------------------------
# éç½®
# -----------------------------------------------------------------------------
CONTAINER_NAME="evopanel"
IMAGE_NAME="evopanel"
IMAGE_TAG="latest"
DEFAULT_PORT=1420
CONFIG_DIR="$HOME/.evopanel"
DATA_DIR="$(pwd)/data"

# -----------------------------------------------------------------------------
# å·¥å·å½æ°
# -----------------------------------------------------------------------------
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${CYAN}[STEP]${NC} $1"
}

separator() {
    echo "--------------------------------------------------------------------------------"
}

# -----------------------------------------------------------------------------
# æ£æ?Docker ç¯å¢
# -----------------------------------------------------------------------------
check_docker() {
    log_step "æ£æ?Docker ç¯å¢..."
    
    # æ£æ?Docker æ¯å¦å®è£
    if ! command -v docker &> /dev/null; then
        log_error "Docker æªå®è£æä¸å¨ PATH ä¸?
        echo ""
        echo "è¯·åå®è£ Docker:"
        echo "  Ubuntu/Debian:  curl -fsSL https://get.docker.com | sh"
        echo "  CentOS/RHEL:   yum install -y docker-ce"
        echo "  Arch Linux:     pacman -S docker"
        exit 1
    fi
    
    # æ£æ?Docker æå¡æ¯å¦è¿è¡
    if ! docker info &> /dev/null; then
        log_error "Docker æå¡æªè¿è¡?
        echo ""
        echo "è¯·å¯å?Docker æå¡:"
        echo "  sudo systemctl start docker"
        exit 1
    fi
    
    # æ£æ?Docker Compose
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
        log_info "Docker Compose v2 å¯ç¨"
    elif command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
        log_info "Docker Compose v1 å¯ç¨"
    else
        log_warn "Docker Compose æªå®è£ï¼é¨ååè½å¯è½ä¸å¯ç?
        COMPOSE_CMD=""
    fi
    
    log_info "Docker ç¯å¢æ£æ¥éè¿"
}

# -----------------------------------------------------------------------------
# æ£æ¥åç½®è¦æ±?# -----------------------------------------------------------------------------
check_requirements() {
    log_step "æ£æ¥åç½®è¦æ±?.."
    
    # æ£æ¥æå»ºä¸ä¸æ
    if [ ! -f "Dockerfile" ]; then
        log_error "Dockerfile ä¸å­å¨ï¼è¯·ç¡®ä¿å¨é¡¹ç®æ ¹ç®å½è¿è¡æ­¤èæ¬"
        exit 1
    fi
    
    if [ ! -f "package.json" ]; then
        log_error "package.json ä¸å­å¨ï¼è¯·ç¡®ä¿å¨é¡¹ç®æ ¹ç®å½è¿è¡æ­¤èæ¬"
        exit 1
    fi
    
    # åå»ºå¿è¦ç®å½
    mkdir -p "$DATA_DIR"
    
    log_info "åç½®è¦æ±æ£æ¥éè¿"
}

# -----------------------------------------------------------------------------
# æåææ°ä»£ç ï¼å¯éï¼
# -----------------------------------------------------------------------------
pull_latest() {
    log_step "æ£æ¥æ´æ?.."
    
    if [ -d ".git" ]; then
        git fetch origin main
        LOCAL=$(git rev-parse @)
        REMOTE=$(git rev-parse origin/main)
        
        if [ "$LOCAL" != "$REMOTE" ]; then
            log_warn "æ¬å°çæ¬è½åäºè¿ç¨ï¼æ¯å¦æ´æ°ï¼?
            read -p "è¾å¥ y æ´æ°ï¼å¶ä»è·³è¿? " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                log_info "æ´æ°ä»£ç ..."
                git pull origin main
            fi
        else
            log_info "å·²æ¯ææ°çæ?
        fi
    fi
}

# -----------------------------------------------------------------------------
# æå»ºéå
# -----------------------------------------------------------------------------
build_image() {
    log_step "æå»º Docker éå..."
    
    # å¯ç¨ BuildKit
    export DOCKER_BUILDKIT=1
    
    # æå»ºéå
    log_info "æå»ºéå: ${IMAGE_NAME}:${IMAGE_TAG}"
    
    if docker build \
        --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
        --tag "${IMAGE_NAME}:latest" \
        --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
        --progress=plain \
        .; then
        log_info "éåæå»ºæå"
    else
        log_error "éåæå»ºå¤±è´¥"
        exit 1
    fi
    
    # æ¾ç¤ºéåå¤§å°
    IMAGE_SIZE=$(docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "{{.Size}}")
    log_info "éåå¤§å°: $IMAGE_SIZE"
}

# -----------------------------------------------------------------------------
# å¯å¨å®¹å¨
# -----------------------------------------------------------------------------
start_container() {
    log_step "å¯å¨å®¹å¨..."
    
    # æ£æ¥å®¹å¨æ¯å¦å·²å­å¨
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            log_warn "å®¹å¨å·²å¨è¿è¡ä¸?
            return 0
        else
            log_info "å®¹å¨å·²å­å¨ï¼éæ°å¯å¨..."
            docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1
        fi
    fi
    
    # æ£æ¥éç½®ç®å½?    if [ ! -d "$CONFIG_DIR" ]; then
        log_warn "EvoPanel éç½®ç®å½ä¸å­å? $CONFIG_DIR"
        log_info "å°åå»ºç®å½?.."
        mkdir -p "$CONFIG_DIR"
    fi
    
    # å¯å¨å®¹å¨ï¼ä½¿ç?host ç½ç»æ¨¡å¼ï¼?    log_info "å¯å¨å®¹å¨ (host ç½ç»æ¨¡å¼)..."
    
    docker run -d \
        --name "$CONTAINER_NAME" \
        --hostname "$CONTAINER_NAME" \
        --network host \
        --restart unless-stopped \
        --volume "$CONFIG_DIR:/root/.evopanel" \
        --volume "$DATA_DIR:/app/data" \
        --env "NODE_ENV=production" \
        --env "EVOFLOW_GATEWAY_URL=http://127.0.0.1:18789" \
        --env "TZ=Asia/Shanghai" \
        --health-cmd "curl -f http://localhost:1420/ || exit 1" \
        --health-interval "30s" \
        --health-timeout "5s" \
        --health-retries "3" \
        --log-driver "json-file" \
        --log-opt "max-size=10m" \
        --log-opt "max-file=3" \
        "${IMAGE_NAME}:${IMAGE_TAG}"
    
    if [ $? -eq 0 ]; then
        log_info "å®¹å¨å¯å¨æå"
    else
        log_error "å®¹å¨å¯å¨å¤±è´¥"
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# åæ­¢å®¹å¨
# -----------------------------------------------------------------------------
stop_container() {
    log_step "åæ­¢å®¹å¨..."
    
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker stop "$CONTAINER_NAME"
        log_info "å®¹å¨å·²åæ­?
    else
        log_warn "å®¹å¨æªè¿è¡?
    fi
}

# -----------------------------------------------------------------------------
# éå¯å®¹å¨
# -----------------------------------------------------------------------------
restart_container() {
    log_step "éå¯å®¹å¨..."
    stop_container
    sleep 2
    start_container
}

# -----------------------------------------------------------------------------
# å é¤å®¹å¨
# -----------------------------------------------------------------------------
remove_container() {
    log_step "å é¤å®¹å¨..."
    
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1
        log_info "å®¹å¨å·²å é?
    else
        log_warn "å®¹å¨ä¸å­å?
    fi
}

# -----------------------------------------------------------------------------
# æ¥çç¶æ?# -----------------------------------------------------------------------------
show_status() {
    log_step "å®¹å¨ç¶æ?"
    
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo ""
        docker ps -a --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        
        # æ¾ç¤ºèµæºä½¿ç¨
        echo ""
        log_info "èµæºä½¿ç¨:"
        docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" "$CONTAINER_NAME" 2>/dev/null || true
    else
        log_warn "å®¹å¨ä¸å­å?
    fi
}

# -----------------------------------------------------------------------------
# æ¥çæ¥å¿
# -----------------------------------------------------------------------------
show_logs() {
    log_step "å®¹å¨æ¥å¿ (Ctrl+C éå?:"
    echo ""
    
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker logs -f "$CONTAINER_NAME"
    else
        log_error "å®¹å¨æªè¿è¡ï¼æ æ³æ¥çæ¥å¿"
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# è¿å¥å®¹å¨
# -----------------------------------------------------------------------------
enter_container() {
    log_step "è¿å¥å®¹å¨ shell..."
    echo ""
    
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker exec -it "$CONTAINER_NAME" /bin/sh
    else
        log_error "å®¹å¨æªè¿è¡ï¼æ æ³è¿å¥"
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# å¸¸è§é®é¢ææ¥
# -----------------------------------------------------------------------------
troubleshoot() {
    echo ""
    separator
    log_info "å¸¸è§é®é¢ææ¥"
    separator
    echo ""
    
    log_info "1. æ£æ¥å®¹å¨æ¯å¦è¿è¡?"
    echo "   docker ps | grep $CONTAINER_NAME"
    echo ""
    
    log_info "2. æ¥çå®¹å¨æ¥å¿:"
    echo "   docker logs $CONTAINER_NAME"
    echo ""
    
    log_info "3. æ£æ¥ç«¯å£å ç?"
    echo "   netstat -tlnp | grep 1420"
    echo "   ss -tlnp | grep 1420"
    echo ""
    
    log_info "4. æ£æ?EvoPanel éç½®:"
    echo "   cat ~/.evopanel/evopanel.json"
    echo ""
    
    log_info "5. æµè¯ Gateway è¿æ¥:"
    echo "   curl http://localhost:18789/health"
    echo ""
    
    log_info "6. éå»ºå®¹å¨:"
    echo "   ./docker-deploy.sh rebuild"
    echo ""
    
    log_info "7. å®å¨éç½®:"
    echo "   docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME"
    echo "   docker rmi ${IMAGE_NAME}:${IMAGE_TAG}"
    echo "   ./docker-deploy.sh start"
    echo ""
    
    log_info "8. æ¥ç EvoPanel æ¥å¿:"
    echo "   docker exec $CONTAINER_NAME cat /home/appuser/.evopanel/logs/gateway.log"
    echo ""
    
    separator
    echo ""
}

# -----------------------------------------------------------------------------
# è·åæ¬æº IP
# -----------------------------------------------------------------------------
get_local_ip() {
    ip route get 1 2>/dev/null | awk '{print $7; exit}' || \
    hostname -I 2>/dev/null | awk '{print $1}' || \
    echo "localhost"
}

# -----------------------------------------------------------------------------
# æ¾ç¤ºè®¿é®ä¿¡æ¯
# -----------------------------------------------------------------------------
show_access_info() {
    local ip=$(get_local_ip)
    
    echo ""
    separator
    log_info "é¨ç½²å®æï¼?
    separator
    echo ""
    echo -e "  ${CYAN}ð è®¿é®å°å:${NC}"
    echo "     http://${ip}:1420"
    echo ""
    echo -e "  ${CYAN}ð éç½®ç®å½:${NC}"
    echo "     $CONFIG_DIR"
    echo ""
    echo -e "  ${CYAN}ð å®¹å¨åç§°:${NC}"
    echo "     $CONTAINER_NAME"
    echo ""
    echo "  å¸¸ç¨å½ä»¤:"
    echo "    ./docker-deploy.sh logs    # æ¥çæ¥å¿"
    echo "    ./docker-deploy.sh status  # æ¥çç¶æ?
    echo "    ./docker-deploy.sh stop    # åæ­¢"
    echo "    ./docker-deploy.sh start   # å¯å¨"
    echo "    ./docker-deploy.sh restart # éå¯"
    echo "    ./docker-deploy.sh rebuild # éå»º"
    echo "    ./docker-deploy.sh shell   # è¿å¥å®¹å¨"
    echo "    ./docker-deploy.sh help    # å¸®å©"
    echo ""
    separator
    echo ""
}

# -----------------------------------------------------------------------------
# ä½¿ç¨ Docker Compose æ¹å¼
# -----------------------------------------------------------------------------
compose_up() {
    if [ -z "$COMPOSE_CMD" ]; then
        log_error "Docker Compose ä¸å¯ç¨ï¼è¯·ä½¿ç¨åæºæ¨¡å¼?
        exit 1
    fi
    
    log_step "ä½¿ç¨ Docker Compose å¯å¨..."
    
    if [ ! -f "docker-compose.yml" ]; then
        log_error "docker-compose.yml ä¸å­å?
        exit 1
    fi
    
    $COMPOSE_CMD up -d
    log_info "æå¡å·²å¯å?
}

compose_down() {
    if [ -z "$COMPOSE_CMD" ]; then
        log_error "Docker Compose ä¸å¯ç?
        exit 1
    fi
    
    log_step "åæ­¢ Docker Compose æå¡..."
    $COMPOSE_CMD down
}

# -----------------------------------------------------------------------------
# æ¾ç¤ºå¸®å©
# -----------------------------------------------------------------------------
show_help() {
    echo ""
    echo "EvoPanel Docker é¨ç½²èæ¬"
    echo ""
    echo "ç¨æ³: $0 [å½ä»¤]"
    echo ""
    echo "å½ä»¤:"
    echo "  start     å¯å¨å®¹å¨"
    echo "  stop      åæ­¢å®¹å¨"
    echo "  restart   éå¯å®¹å¨"
    echo "  rebuild   éå»ºå®¹å¨ï¼å é¤å¹¶éæ°åå»ºï¼?
    echo "  remove    å é¤å®¹å¨ï¼ä¿çéåï¼"
    echo "  status    æ¥çå®¹å¨ç¶æ?
    echo "  logs      æ¥çå®¹å¨æ¥å¿"
    echo "  shell     è¿å¥å®¹å¨ shell"
    echo "  troubleshoot  å¸¸è§é®é¢ææ¥"
    echo "  compose   ä½¿ç¨ Docker Compose æ¹å¼å¯å¨"
    echo "  help      æ¾ç¤ºå¸®å©"
    echo ""
    echo "ç¤ºä¾:"
    echo "  $0 start          # å¯å¨å®¹å¨"
    echo "  $0 logs -f        # å®æ¶æ¥çæ¥å¿"
    echo "  $0 rebuild        # éå»ºå®¹å¨"
    echo ""
}

# -----------------------------------------------------------------------------
# ä¸»æµç¨?# -----------------------------------------------------------------------------
main() {
    case "${1:-help}" in
        check)
            check_docker
            ;;
        build)
            check_docker
            check_requirements
            pull_latest
            build_image
            ;;
        start)
            check_docker
            check_requirements
            start_container
            show_access_info
            ;;
        stop)
            stop_container
            ;;
        restart)
            restart_container
            ;;
        rebuild)
            check_docker
            remove_container
            build_image
            start_container
            show_access_info
            ;;
        remove)
            remove_container
            ;;
        status)
            check_docker
            show_status
            ;;
        logs)
            show_logs
            ;;
        shell)
            enter_container
            ;;
        troubleshoot)
            troubleshoot
            ;;
        compose)
            check_docker
            compose_up
            show_access_info
            ;;
        compose-down)
            compose_down
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "æªç¥å½ä»¤: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
