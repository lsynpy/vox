#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV="${1:?Usage: deploy.sh [local|jdc] [IMAGE_TAG]}"
ENV_FILE="${SCRIPT_DIR}/.env.${ENV}"

if [[ ! -f "${ENV_FILE}" ]]; then
    echo "Error: ${ENV_FILE} not found"
    exit 1
fi

source "${SCRIPT_DIR}/.registry.env"
source "${ENV_FILE}"

IMAGE_TAG="${2:-}"
if [[ -z "${IMAGE_TAG}" ]]; then
    echo "Error: IMAGE_TAG required. Run 'make prepare' first, or pass the tag manually."
    echo "  Usage: $0 ${ENV} <IMAGE_TAG>"
    exit 1
fi

# ---------------------------------------------------------------------------
get_ip() {
    if [[ "${IS_LOCAL}" == "true" ]]; then
        echo "127.0.0.1"
    else
        local get_ip_cmd
        case "${ARCH}" in
            amd64) get_ip_cmd="hostname -I 2>/dev/null | awk '{print \$1}'" ;;
            arm64) get_ip_cmd="ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i==\"src\") print \$(i+1)}'" ;;
            *)     get_ip_cmd="hostname -I 2>/dev/null | awk '{print \$1}'" ;;
        esac
        ssh "${VPS_HOSTNAME}" "$get_ip_cmd"
    fi
}

# ---------------------------------------------------------------------------
verify_health() {
    local port="$1"
    local ip
    ip=$(get_ip)

    uv run "${SCRIPT_DIR}/verify.py" "${ip}" "${port}"
}

# ---------------------------------------------------------------------------
deploy_container() {
    echo "[2/3] Starting container..."

    if [[ "${IS_LOCAL}" == "true" ]]; then
        docker pull "${IMAGE_TAG}"
        docker stop vox 2>/dev/null || true
        docker rm vox 2>/dev/null || true
        docker run -d \
            --name vox \
            --restart unless-stopped \
            -p "${VOX_PORT}:${VOX_PORT}" \
            -v "${MUSIC_DIR}:/music" \
            -v "${CONFIG_DIR}:/var/lib/vox" \
            -v "${CACHE_DIR}:/var/cache/vox" \
            "${IMAGE_TAG}" \
            -f
    else
        ssh "${VPS_HOSTNAME}" bash <<SSH_EOF
            set -euo pipefail
            echo '  Pulling image...'
            docker pull ${IMAGE_TAG}
            echo '  Starting container...'
            docker stop vox 2>/dev/null || true
            docker rm vox 2>/dev/null || true
            docker run -d \
                --name vox \
                --restart unless-stopped \
                --net=host \
                -v ${MUSIC_DIR}:/music \
                -v ${CONFIG_DIR}:/var/lib/vox \
                -v ${CACHE_DIR}:/var/cache/vox \
                ${IMAGE_TAG} \
                -f
SSH_EOF
    fi
}

# ---------------------------------------------------------------------------
deploy() {
    echo ""
    echo "==> Deploying to ${ENV} (${ARCH})..."
    if [[ "${IS_LOCAL}" == "false" ]]; then
        echo "  Target: ${VPS_HOSTNAME}"
    fi
    echo "  Image: ${IMAGE_TAG}"

    # Config management (local only)
    if [[ "${IS_LOCAL}" == "true" ]]; then
        mkdir -p "${CONFIG_DIR}" "${CACHE_DIR}"

        CONFIG_FILE="${CONFIG_DIR}/vox.toml"
        if [[ ! -f "${CONFIG_FILE}" ]]; then
            echo "  Writing config..."
            cat > "${CONFIG_FILE}" << EOF
album_art_pattern = "(album|cover|folder|front|back|artwork)[.](jpeg|jpg|png)"

[[mount_dirs]]
source = "${MUSIC_DIR}"
name = "Music"

[users]

[users.admin]
admin = true
initial_password = "admin"
EOF
        elif ! grep -q '^\[\[mount_dirs\]\]' "${CONFIG_FILE}" 2>/dev/null; then
            echo "  Adding mount_dirs..."
            cat >> "${CONFIG_FILE}" << EOF

[[mount_dirs]]
source = "${MUSIC_DIR}"
name = "Music"
EOF
        fi
    fi

    deploy_container

    echo "[3/3] Verifying deployment..."
    if [[ "${IS_LOCAL}" != "true" ]]; then
        echo "  Waiting for service to start..."
        sleep 3
    fi
    verify_health "${VOX_PORT}"

    local ip
    ip=$(get_ip)
    echo ""
    echo "==> Deployed!"
    echo "  Image:    ${IMAGE_TAG}"
    echo "  Web UI:   http://${ip}:${VOX_PORT}"
    echo "  API docs: http://${ip}:${VOX_PORT}/api-docs/"
    if [[ "${IS_LOCAL}" == "true" ]]; then
        docker ps --filter "name=vox" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    fi
}

# ---------------------------------------------------------------------------
# Discover valid environments from .env.* files
VALID_ENVS=$(ls "${SCRIPT_DIR}"/.env.* 2>/dev/null | xargs -I{} basename {} | sed 's/\.env\.//' | tr '\n' ' ')

if ! echo "${VALID_ENVS}" | grep -qw "${ENV}"; then
    echo "Error: Unknown ENV '${ENV}'. Use one of: ${VALID_ENVS}"
    exit 1
fi

deploy
