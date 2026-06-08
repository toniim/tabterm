# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — Build the self-contained `tabterm` binary with Bun.
#
# `bun install` runs the postinstall hook that downloads GoTTY into bin/, then
# we build the SPA, embed every asset (SPA + gotty + session-init) and compile a
# single static binary. The result lives at /src/dist/tabterm.
###############################################################################
FROM oven/bun:1 AS builder

WORKDIR /src

# Install dependencies first so this layer is cached unless the lockfile changes.
# The `postinstall` hook (scripts/install-gotty.ts) downloads the GoTTY binary,
# so we copy the script it needs alongside the manifests.
COPY package.json bun.lock ./
COPY scripts/install-gotty.ts ./scripts/
RUN bun install --frozen-lockfile

# Bring in the rest of the source and compile the standalone binary, mirroring
# the `make compile` target (build SPA → embed assets → bun build --compile).
COPY . .
RUN bun run build \
 && bun scripts/gen-embed.ts \
 && bun build --compile --minify src/server/index.ts --outfile dist/tabterm

###############################################################################
# Stage 2 — Runtime image with everything a user needs:
#   - tabterm  : the compiled binary (SPA + gotty + session-init embedded)
#   - bun      : the runtime/toolchain
#   - gotty    : standalone PTY backend (also embedded in the binary)
#   - claude   : Claude Code CLI (launched for "Claude" sessions)
###############################################################################
FROM debian:bookworm-slim AS runtime

# Runtime tools: bash for the spawned PTY shells, git/ssh/curl for real work
# inside the terminals, ca-certificates for TLS, procps for htop/ps, etc.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      less \
      openssh-client \
      procps \
 && rm -rf /var/lib/apt/lists/*

# Bun — copied straight from the official image (single static binary).
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# GoTTY — the same binary the build downloaded, exposed standalone on PATH.
COPY --from=builder /src/bin/gotty /usr/local/bin/gotty

# tabterm — the self-contained compiled binary.
COPY --from=builder /src/dist/tabterm /usr/local/bin/tabterm

# Run as a non-root user: friendlier shells and Claude Code dislikes root.
RUN useradd --create-home --shell /bin/bash tabterm
USER tabterm
WORKDIR /home/tabterm

# Claude Code CLI — official native installer, lands in ~/.local/bin.
ENV PATH=/home/tabterm/.local/bin:$PATH
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && claude --version

# tabterm serves HTTP + WebSocket on this port (override via ~/.config/tabterm.json).
EXPOSE 3000

# Pre-create the data dirs owned by `tabterm` so the volumes below inherit the
# right ownership (otherwise Docker creates the mountpoints as root and the
# server can't write the SQLite db). ~/.config holds config + db; ~/.cache holds
# per-session claude markers.
RUN mkdir -p /home/tabterm/.config /home/tabterm/.cache
VOLUME ["/home/tabterm/.config", "/home/tabterm/.cache"]

ENTRYPOINT ["tabterm"]
