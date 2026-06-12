.PHONY: help deploy dev serve watch test test_server test_web

SHELL := /usr/bin/env bash
DEPLOY_DIR := $(shell pwd)/deploy

# Registry config
include $(DEPLOY_DIR)/.registry.env

# Auto-generated image tag: YYYYMMDD-sha
TAG_DATE := $(shell date +%Y%m%d)
TAG_SHA  := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
IMAGE_TAG := $(REGISTRY)/$(ALIYUN_NAMESPACE)/vox:$(TAG_DATE)-$(TAG_SHA)

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Deploy:"
	@echo "  deploy ENV=local         Build, push, and deploy to local Docker"
	@echo "  deploy ENV=jdc           Build, push, and deploy to JDC"
	@echo ""
	@echo "Development:"
	@echo "  dev    Build web and start server (static)"
	@echo "  serve  Vox API server only"
	@echo "  watch  Vue dev server with HMR"
	@echo ""
	@echo "Testing:"
	@echo "  test          Run all tests (server + web e2e)"
	@echo "  test_server   Run Rust unit/integration tests"
	@echo "  test_web      Run Playwright end-to-end tests"
	@echo ""
	@echo "Options:"
	@echo "  IMAGE_TAG=...  Override auto-generated image tag"

default: help

# ===================================================================
# Deploy (build, push, deploy)
# ===================================================================
deploy:
	@if [ -z "$(ENV)" ]; then \
		echo "Error: ENV required. Usage: make deploy ENV=local|jdc"; \
		exit 1; \
	fi
	@bash $(DEPLOY_DIR)/prepare-image.sh "$(ENV)" && \
	bash $(DEPLOY_DIR)/deploy.sh $(ENV) "$(IMAGE_TAG)"

# ===================================================================
# Dev targets
# ===================================================================
dev:
	cd web && npm run build
	cd server && cargo run -- -f -w ../web/dist

serve:
	cd server && cargo run -- -f

watch:
	cd web && npm run dev

# ===================================================================
# Test targets
# ===================================================================
test: test_server test_web

test_server:
	cd server && RUST_BACKTRACE=full cargo test

test_web:
	-cd web && npx playwright test || open playwright-report/index.html
