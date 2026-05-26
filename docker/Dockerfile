FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    ca-certificates \
    bash \
    procps \
    build-essential \
    pkg-config \
    libssl-dev \
    unzip \
    xz-utils \
    jq \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js (latest LTS via NodeSource) ──────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Go (latest stable) ───────────────────────────────────────────────────────
ARG GO_VERSION=1.24.3
RUN ARCH=$(dpkg --print-architecture | sed 's/amd64/amd64/;s/arm64/arm64/') \
    && curl -fsSL "https://dl.google.com/go/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    | tar -C /usr/local -xz

ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/root/go"
ENV PATH="${GOPATH}/bin:${PATH}"

# ── Rust (stable via rustup) ─────────────────────────────────────────────────
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --no-modify-path
ENV PATH="/root/.cargo/bin:${PATH}"

# ── AI tools + jonggrang ─────────────────────────────────────────────────────
RUN npm install -g --no-fund --no-audit \
    jonggrang \
    @anthropic-ai/claude-code \
    opencode-ai

# ── Default workdir ───────────────────────────────────────────────────────────
WORKDIR /workspace

CMD ["sleep", "infinity"]
