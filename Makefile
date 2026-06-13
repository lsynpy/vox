.PHONY: help deploy serve test test_server

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
	@echo "  serve  Vox API server only"
	@echo ""
	@echo "Testing:"
	@echo "  test          Run all tests"
	@echo "  test_server   Run Rust unit/integration tests"
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
serve:
	cd server && cargo run -- -f

# ===================================================================
# Test targets
# ===================================================================
test: test_server

test_server:
	cd server && RUST_BACKTRACE=full cargo test
