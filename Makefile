# Local Bruno build helpers (Node v22 — see .nvmrc)
# Usage: make <target>
#
# First time (or after a clean):
#   make setup && make pack-mac

.PHONY: help setup ensure-deps ensure-node dev build-web prepare-electron-web build-mac pack-mac

# Load nvm when available so recipes use the .nvmrc Node version.
# Homebrew installs nvm.sh under $(brew --prefix)/opt/nvm/, not under ~/.nvm.
define NVM_USE
	export NVM_DIR="$${NVM_DIR:-$$HOME/.nvm}"; \
	HOMEBREW_PREFIX="$${HOMEBREW_PREFIX:-$$(brew --prefix 2>/dev/null)}"; \
	if [ -s "$$HOMEBREW_PREFIX/opt/nvm/nvm.sh" ]; then . "$$HOMEBREW_PREFIX/opt/nvm/nvm.sh"; \
	elif [ -s "$$NVM_DIR/nvm.sh" ]; then . "$$NVM_DIR/nvm.sh"; \
	fi; \
	command -v nvm >/dev/null 2>&1 && nvm use || true
endef

help:
	@echo "Bruno local build targets:"
	@echo "  make setup      - install deps and run project setup (required once)"
	@echo "  make dev        - run Electron + React (hot reload)"
	@echo "  make build-web  - build the React UI into packages/bruno-app/dist"
	@echo "  make build-mac  - package a macOS app/dmg (unsigned for local use)"
	@echo "  make pack-mac   - faster unpacked .app only (unsigned)"
	@echo ""
	@echo "First time: make setup && make pack-mac"

setup: ensure-node
	npm i --legacy-peer-deps
	npm run setup

ensure-node:
	@$(NVM_USE); \
	REQUIRED=$$(cat .nvmrc 2>/dev/null | tr -d '[:space:]'); \
	CURRENT=$$(node -v 2>/dev/null | sed 's/^v//'); \
	echo "Node $$CURRENT (want $$REQUIRED from .nvmrc)"; \
	if [ -n "$$REQUIRED" ] && [ "$$CURRENT" != "$$REQUIRED" ]; then \
		echo "Warning: Node version mismatch. Run: nvm use"; \
	fi

ensure-deps: ensure-node
	@if [ ! -d node_modules ] || [ ! -x node_modules/.bin/rsbuild ]; then \
		echo "error: dependencies missing (rsbuild not found)."; \
		echo "Run:  make setup"; \
		exit 1; \
	fi

dev: ensure-deps
	@$(NVM_USE); npm run dev

build-web: ensure-deps
	@$(NVM_USE); npm run build:web

# Copy the React build into electron/web and rewrite absolute /static/ paths for file://.
# Mirrors scripts/build-electron.sh / scripts/build-electron.js.
prepare-electron-web: build-web
	rm -rf packages/bruno-electron/web
	mkdir packages/bruno-electron/web
	cp -r packages/bruno-app/dist/* packages/bruno-electron/web
	sed -i'' -e 's@/static/@./static/@g' packages/bruno-electron/web/*.html
	sed -i'' -e 's@/static/font@../../static/font@g' packages/bruno-electron/web/static/css/*.css
	find packages/bruno-electron/web -name '*.map' -type f -delete

# Full mac distribution (.dmg / .pkg / .zip) under packages/bruno-electron/out/
build-mac: build-web
	@$(NVM_USE); CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:electron:mac -- -c.mac.identity=null

# Unpacked .app only (faster). Open packages/bruno-electron/out/mac*/Bruno.app
pack-mac: prepare-electron-web
	@$(NVM_USE); \
	CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack --workspace=packages/bruno-electron -- --config electron-builder-config.js -c.mac.identity=null
