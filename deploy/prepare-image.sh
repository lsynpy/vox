#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

source "${SCRIPT_DIR}/.registry.env"

ENV="${1:-local}"
ENV_FILE="${SCRIPT_DIR}/.env.${ENV}"
if [[ -f "${ENV_FILE}" ]]; then
    source "${ENV_FILE}"
fi

# Disable provenance attestations to avoid compatibility issues with some registries
export BUILDX_NO_DEFAULT_ATTESTATIONS=1

# ---------------------------------------------------------------------------
# Tag scheme: date + short SHA
TAG_DATE="$(date +%Y%m%d)"
TAG_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
IMAGE_TAG="${REGISTRY}/${ALIYUN_NAMESPACE}/vox:${TAG_DATE}-${TAG_SHA}"

# Platforms to build
PLATFORMS="linux/amd64,linux/arm64"

TMPDIR="${SCRIPT_DIR}/.deploy-tmp"

# ---------------------------------------------------------------------------
echo ""
echo "[1/4] Checking if images exist in ACR for ${IMAGE_TAG}..."

MISSING_PLATFORMS=""
for p in ${PLATFORMS//,/ }; do
    arch="${p#*/}"
    if ! docker manifest inspect "${IMAGE_TAG}" 2>/dev/null | grep -q "\"architecture\": \"${arch}\""; then
        MISSING_PLATFORMS="${MISSING_PLATFORMS} ${arch}"
    fi
done

if [[ -z "${MISSING_PLATFORMS}" ]]; then
    echo "  All platforms found — skipping build"
    echo ""
    echo "==> Image ready: ${IMAGE_TAG}"
    exit 0
fi

echo "  Missing platforms:${MISSING_PLATFORMS} — need to build"

# ---------------------------------------------------------------------------
# Helper: download binary from existing release
download_binary_from_release() {
    local tag="$1"
    local arch="$2"
    local download_dir
    download_dir=$(mktemp -d)

    if ! gh release download "${tag}" \
        --repo lsynpy/vox \
        --pattern "vox-${arch}.tar.gz" \
        --dir "${download_dir}" --clobber 2>/dev/null; then
        rm -rf "${download_dir}"
        return 1
    fi

    mkdir -p "${TMPDIR}/server"
    tar xzf "${download_dir}/vox-${arch}.tar.gz" -C "${TMPDIR}/server"
    mv "${TMPDIR}/server/vox" "${TMPDIR}/server/vox-${arch}"
    chmod +x "${TMPDIR}/server/vox-${arch}"
    rm -rf "${download_dir}"
    return 0
}

# ---------------------------------------------------------------------------
FULL_SHA="$(git rev-parse HEAD 2>/dev/null || echo "")"
SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

echo ""
echo "[2/4] Checking if release exists for commit ${SHORT_SHA}..."

RELEASE_TAG=""
release_json=$(gh release list --repo lsynpy/vox --limit 20 --json tagName 2>/dev/null) || true
if [[ -n "${release_json}" ]]; then
    RELEASE_TAG=$(echo "${release_json}" | python3 -c "
import sys, json
releases = json.load(sys.stdin)
sha = '${FULL_SHA}'
short_sha = '${SHORT_SHA}'
for r in releases:
    tag = r['tagName']
    if short_sha in tag or sha in tag:
        print(tag)
        exit()
print('')
" 2>/dev/null) || true
fi

SKIP_BUILD="false"
if [[ -n "${RELEASE_TAG}" ]]; then
    echo "  Found existing release: ${RELEASE_TAG}"
    echo "  Downloading server binaries..."

    ALL_DOWNLOADED="true"
    for p in ${PLATFORMS//,/ }; do
        arch="${p#*/}"
        if download_binary_from_release "${RELEASE_TAG}" "${arch}"; then
            echo "    ${arch} downloaded"
        else
            echo "    ${arch} failed to download"
            ALL_DOWNLOADED="false"
        fi
    done

    if [[ "${ALL_DOWNLOADED}" == "true" ]]; then
        SKIP_BUILD="true"
    else
        echo "  Failed to download all binaries from release, will trigger new build"
        rm -rf "${TMPDIR}/server"
    fi
else
    echo "  No existing release for this commit"
fi

# ---------------------------------------------------------------------------
if [[ "${SKIP_BUILD}" == "false" ]]; then
    echo ""
    echo "[3/4] Triggering GitHub Actions build (both archs)..."
    OUTPUT=$(gh workflow run "Build All Binaries" --ref master 2>&1) || true
    RUN_ID="${OUTPUT##*/}"
    RUN_ID="${RUN_ID//[^0-9]/}"
    if [[ -z "${RUN_ID}" ]]; then
        echo "  Error: Failed to trigger workflow"
        echo "  ${OUTPUT}"
        exit 1
    fi
    echo "  Run: https://github.com/lsynpy/vox/actions/runs/${RUN_ID}"
    echo "  Waiting for builds to complete..."

    # Poll every 5s until completed
    max_attempts=120  # 10 minutes max
    attempt=0
    while true; do
        attempt=$((attempt + 1))
        if [[ ${attempt} -gt ${max_attempts} ]]; then
            echo "  Timeout waiting for build"
            exit 1
        fi
        run_json=$(gh run view "${RUN_ID}" --json status,conclusion 2>/dev/null) || true
        if [[ -z "${run_json}" ]]; then
            echo "  $(date +%H:%M:%S) waiting for run to appear..."
            sleep 5
            continue
        fi
        status=$(echo "${run_json}" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null) || status="unknown"
        conclusion=$(echo "${run_json}" | python3 -c "import sys,json; print(json.load(sys.stdin)['conclusion'])" 2>/dev/null) || conclusion="..."
        echo "  $(date +%H:%M:%S) status=${status} conclusion=${conclusion}"
        if [[ "${status}" == "completed" ]]; then
            break
        fi
        sleep 5
    done

    if [[ "${conclusion}" != "success" ]]; then
        echo "  Build failed (conclusion: ${conclusion})"
        echo "  Check: https://github.com/lsynpy/vox/actions/runs/${RUN_ID}"
        exit 1
    fi
    echo "  Finding latest release..."
    LATEST_TAG=$(gh release list --repo lsynpy/vox --limit 5 --json tagName 2>/dev/null | python3 -c "import sys,json; [print(r['tagName']) for r in json.load(sys.stdin)]" 2>/dev/null | head -1)

    if [[ -z "${LATEST_TAG}" ]]; then
        echo "  Error: No release found"
        exit 1
    fi
    echo "  Release: ${LATEST_TAG}"

    echo "  Downloading server binaries..."
    for p in ${PLATFORMS//,/ }; do
        arch="${p#*/}"
        download_binary_from_release "${LATEST_TAG}" "${arch}" || {
            echo "  Error: Failed to download vox-${arch}.tar.gz"
            exit 1
        }
        echo "    ${arch} downloaded"
    done
fi

# ---------------------------------------------------------------------------
echo ""
echo "[4/4] Building web UI and multi-arch Docker image..."

cd "${PROJECT_DIR}/web" && npm ci && npm run build
echo "  Web UI built"

mkdir -p "${TMPDIR}/web"
cp -r "${PROJECT_DIR}/web/dist/"* "${TMPDIR}/web/"

cat > "${TMPDIR}/Dockerfile" << 'DOCKERFILE'
FROM debian:bookworm-slim

ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/share/vox/web /var/cache/vox /var/lib/vox

COPY server/vox-${TARGETARCH} /usr/local/bin/vox
COPY web /usr/share/vox/web

WORKDIR /var/lib/vox

EXPOSE 5050

ENTRYPOINT ["vox"]
CMD ["-f"]
DOCKERFILE

echo "  Building and pushing multi-arch image to ACR: ${IMAGE_TAG}..."
DOCKER_BUILDKIT=1 docker buildx build \
    --platform "${PLATFORMS}" \
    --provenance=false \
    --sbom=false \
    --push -t "${IMAGE_TAG}" \
    "${TMPDIR}"

rm -rf "${TMPDIR}"

echo ""
echo "==> Multi-arch image built and pushed: ${IMAGE_TAG}"
