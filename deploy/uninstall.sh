#!/usr/bin/env bash
set -euo pipefail

# Usage: uninstall.sh [local|<target>]
ENV="${1:-local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "${SCRIPT_DIR}/.env.${ENV}"

CONTAINER_NAME="vox"

uninstall_local() {
    echo "==> Uninstalling Vox [local]..."
    docker stop "${CONTAINER_NAME}" 2>/dev/null || true
    docker rm "${CONTAINER_NAME}" 2>/dev/null || true
    echo "  Container removed."
    echo "  Config preserved at: ${CONFIG_DIR}"
    echo "  Cache preserved at:  ${CACHE_DIR}"
}

uninstall_remote() {
    if [[ -z "${VPS_HOSTNAME}" ]]; then
        echo "Error: VPS_HOSTNAME not set"
        exit 1
    fi

    echo "==> Uninstalling Vox on ${VPS_HOSTNAME}..."
    ssh "${VPS_HOSTNAME}" << REMOTE_EOF
        docker stop ${CONTAINER_NAME} 2>/dev/null || true
        docker rm ${CONTAINER_NAME} 2>/dev/null || true
        echo "  Container removed."
        echo "  Config preserved at: ${CONFIG_DIR}"
        echo "  Cache preserved at:  ${CACHE_DIR}"
REMOTE_EOF
}

if [[ "${IS_LOCAL}" == "true" ]]; then
    uninstall_local
else
    uninstall_remote
fi
