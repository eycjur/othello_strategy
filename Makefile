# Makefile
.PHONY: help install build run stop rm open update-makefile
.DEFAULT_GOAL := help

DOCKER_HUB_USERNAME ?= eycjur
IMAGE_NAME ?= claude-sandbox
CONTAINER_NAME ?= $(subst _,-,$(shell basename $(CURDIR)))
WORKSPACE := /home/agent/workspace
PORT ?= 8000
UPSTREAM_MAKEFILE := https://raw.githubusercontent.com/eycjur/my-docker-sandbox/main/Makefile

install: ## Apple container のインストールとサービス起動
	@command -v container >/dev/null || ( \
		tmp=$$(mktemp -t container).pkg && \
		curl -fsSL "https://github.com/apple/container/releases/download/1.0.0/container-1.0.0-installer-signed.pkg" -o "$$tmp" && \
		sudo installer -pkg "$$tmp" -target / && \
		rm -f "$$tmp" \
	)
	container system start --enable-kernel-install

build: ## CI: arm64 イメージをビルドして push
	docker build \
		--platform linux/arm64 \
		--no-cache \
		-t $(DOCKER_HUB_USERNAME)/$(IMAGE_NAME):latest \
		--push \
		.

run: install ## コンテナを作成/起動して zsh に入る
	@if container inspect "$(CONTAINER_NAME)" >/dev/null 2>&1; then \
		container start "$(CONTAINER_NAME)" 2>/dev/null || true; \
	else \
		container image pull --platform linux/arm64 $(DOCKER_HUB_USERNAME)/$(IMAGE_NAME):latest && \
		container run -d --init --name "$(CONTAINER_NAME)" --platform linux/arm64 \
			-v "$$(pwd):$(WORKSPACE)" \
			-w "$(WORKSPACE)" \
			--user agent \
			"$(DOCKER_HUB_USERNAME)/$(IMAGE_NAME):latest" sleep infinity; \
	fi
	container exec -it -u agent -w "$(WORKSPACE)" "$(CONTAINER_NAME)" zsh -l
	# メモリ制限上限は、--memory 4g のように指定する

stop: ## コンテナを停止
	container stop "$(CONTAINER_NAME)"

rm: ## コンテナを削除
	container rm -f "$(CONTAINER_NAME)" 2>/dev/null || true

open: ## コンテナ IP:PORT をブラウザで開く (PORT=$(PORT))
	@ip=$$(container inspect $(CONTAINER_NAME)|jq -r '.[0].status.networks[0].ipv4Address|split("/")[0]'); open "http://$$ip:$(PORT)"

update-makefile: ## 最新の Makefile を取得して更新
	curl -fsSL -o Makefile $(UPSTREAM_MAKEFILE)

help: ## このヘルプを表示
	@grep -Eh '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
