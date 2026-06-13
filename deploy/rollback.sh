#!/usr/bin/env bash
set -euo pipefail

# Usage: rollback.sh <version> [local|<target>]
VERSION="${1:?Usage: rollback.sh <version> [local|<target>]}"
ENV="${2:-local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "${SCRIPT_DIR}/.env.${ENV}"

IMAGE_NAME="vox"
CONTAINER_NAME="vox"

# Support both short tags (e.g. "local", "v1.0.0") and full registry paths
if [[ "${VERSION}" == registry* ]]; then
    IMAGE_TAG="${VERSION}"
else
    IMAGE_TAG="${IMAGE_NAME}:${VERSION}"
fi

rollback_local() {
    echo "==> Rolling back to ${IMAGE_TAG} [local]..."
    bash "${SCRIPT_DIR}/deploy.sh" local "${IMAGE_TAG}"
}

rollback_remote() {
    if [[ -z "${VPS_HOSTNAME}" ]]; then
        echo "Error: VPS_HOSTNAME not set"
        exit 1
    fi

    echo "==> Rolling back to ${IMAGE_TAG} on ${VPS_HOSTNAME}..."
    ssh "${VPS_HOSTNAME}" bash << REMOTE_EOF
        set -euo pipefail

        echo "  Stopping existing container..."
        docker stop ${CONTAINER_NAME} 2>/dev/null || true
        docker rm ${CONTAINER_NAME} 2>/dev/null || true

        echo "  Starting container with tag ${IMAGE_TAG}..."
        docker run -d \
            --name ${CONTAINER_NAME} \
            --restart unless-stopped \
            -p ${VOX_PORT}:${VOX_PORT} \
            -v ${MUSIC_DIR}:/music \
            -v ${CONFIG_DIR}:/var/lib/vox \
            -v ${CACHE_DIR}:/var/cache/vox \
            ${IMAGE_TAG} \
            -f

        docker ps --filter "name=${CONTAINER_NAME}"
REMOTE_EOF

    echo "==> Rolled back on ${VPS_HOSTNAME}!"
}

# Discover valid environments from .env.* files
VALID_ENVS=$(ls "${SCRIPT_DIR}"/.env.* 2>/dev/null | xargs -I{} basename {} | sed 's/\.env\.//' | tr '\n' ' ')

if ! echo "${VALID_ENVS}" | grep -qw "${ENV}"; then
    echo "Error: Unknown ENV '${ENV}'. Use one of: ${VALID_ENVS}"
    exit 1
fi

if [[ "${IS_LOCAL}" == "true" ]]; then
    rollback_local
else
    rollback_remote
fi
