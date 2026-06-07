BUN  ?= bun
PORT ?= 3000

.DEFAULT_GOAL := help
.PHONY: help install gotty dev build compile start typecheck test test-unit clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install deps (postinstall downloads the GoTTY binary)
	$(BUN) install

gotty: ## Download the GoTTY binary for this OS/arch into bin/
	$(BUN) scripts/install-gotty.ts

dev: ## Run Vite + Bun server with hot reload
	$(BUN) run dev

build: ## Build the client SPA into dist/
	$(BUN) run build

compile: build ## Compile server to a single binary (run from project root)
	@test -x bin/gotty || $(BUN) scripts/install-gotty.ts
	$(BUN) build --compile --minify src/server/index.ts --outfile tabterm
	@echo
	@echo "Built ./tabterm. Run with: NODE_ENV=production ./tabterm"
	@echo "Must be run from this directory (needs dist/, bin/gotty, src/server/session-init.bash)."

start: build ## Build then serve the SPA + API from Bun (production)
	$(BUN) start

typecheck: ## Type-check the whole project
	$(BUN) run typecheck

test-unit: ## Run tests that need no running server (GoTTY health)
	@rm -rf data
	$(BUN) scripts/health-test.ts
	@rm -rf data

test: typecheck ## Typecheck, then run smoke + e2e tests against a fresh server
	@rm -rf data
	@$(BUN) src/server/index.ts > /tmp/tabterm-test.log 2>&1 & echo $$! > /tmp/tabterm-test.pid
	@for i in $$(seq 1 20); do curl -sf localhost:$(PORT)/api/health >/dev/null 2>&1 && break; sleep 0.3; done
	@set -e; \
	  trap 'kill `cat /tmp/tabterm-test.pid` 2>/dev/null || true; pkill -f "src/server/index.ts" 2>/dev/null || true; pkill -f "bin/gotty" 2>/dev/null || true; rm -rf data' EXIT; \
	  $(BUN) scripts/smoke.ts; \
	  $(BUN) scripts/smoke-v3.ts; \
	  $(BUN) scripts/smoke-v4.ts; \
	  $(BUN) scripts/e2e-pty.ts; \
	  $(BUN) scripts/shared-pty.ts; \
	  printf '\nALL TESTS PASSED\n'

clean: ## Remove build output, the SQLite db, and test artifacts
	rm -rf dist data /tmp/tabterm-test.log /tmp/tabterm-test.pid
