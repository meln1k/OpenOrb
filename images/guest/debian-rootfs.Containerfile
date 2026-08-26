# OpenOrb guest image root filesystem.
ARG DEBIAN_BASE_IMAGE
FROM ${DEBIAN_BASE_IMAGE}

ARG AGENT_BROWSER_ASSET
ARG AGENT_BROWSER_LICENSE_SHA256
ARG AGENT_BROWSER_SHA256
ARG AGENT_BROWSER_SOURCE_SHA256
ARG AGENT_BROWSER_VERSION
ARG BUN_ASSET
ARG BUN_LICENSE_SHA256
ARG BUN_SHA256
ARG BUN_VERSION
ARG CHROMIUM_VERSION
ARG COREPACK_SHA256
ARG COREPACK_VERSION
ARG NODE_ASSET
ARG NODE_SHA256
ARG NODE_VERSION
ARG PNPM_SHA256
ARG PNPM_VERSION
ARG WEBSOCAT_ASSET
ARG WEBSOCAT_LICENSE_SHA256
ARG WEBSOCAT_SHA256
ARG WEBSOCAT_VERSION
ARG YARN_SHA256
ARG YARN_VERSION

RUN printf '%s\n' \
        'Types: deb' \
        'URIs: http://snapshot.debian.org/archive/debian/20260803T000000Z' \
        'Suites: trixie trixie-updates' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
        'Check-Valid-Until: no' \
        '' \
        'Types: deb' \
        'URIs: http://snapshot.debian.org/archive/debian-security/20260803T000000Z' \
        'Suites: trixie-security' \
        'Components: main' \
        'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
        'Check-Valid-Until: no' \
        > /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        autoconf \
        automake \
        bash \
        build-essential \
        bzip2 \
        ca-certificates \
        coreutils \
        curl \
        dbus-x11 \
        dpkg-dev \
        ffmpeg \
        file \
        findutils \
        fonts-dejavu-core \
        fonts-freefont-ttf \
        fonts-liberation \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        fzf \
        gh \
        git \
        imagemagick \
        iproute2 \
        iputils-ping \
        jq \
        less \
        libasound2t64 \
        libatk-bridge2.0-0t64 \
        libatk1.0-0t64 \
        libatspi2.0-0t64 \
        libcairo2 \
        libcups2t64 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0t64 \
        libgtk-3-0t64 \
        libnspr4 \
        libnss3 \
        libnss3-tools \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        lsof \
        mercurial \
        openssh-client \
        openssl \
        patch \
        perl \
        pkg-config \
        procps \
        python-is-python3 \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        socat \
        subversion \
        tar \
        time \
        tmux \
        unzip \
        util-linux \
        vim \
        wget \
        xz-utils \
        zstd \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN install -d \
        /usr/local/lib/openorb \
        /usr/local/lib/openorb/node \
        /usr/local/libexec \
        /usr/local/share/agent-browser/skills \
        /usr/share/doc/agent-browser \
        /usr/share/doc/bun \
        /usr/share/doc/websocat \
    && curl --fail --location --show-error \
        "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ASSET}" \
        --output /tmp/node.tar.xz \
    && printf '%s  %s\n' "${NODE_SHA256}" /tmp/node.tar.xz \
        | sha256sum --check --strict - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local/lib/openorb/node \
    && ln -s /usr/local/lib/openorb/node/bin/node /usr/local/bin/node \
    && ln -s /usr/local/lib/openorb/node/bin/node /usr/local/bin/nodejs \
    && ln -s /usr/local/lib/openorb/node/bin/npm /usr/local/bin/npm \
    && ln -s /usr/local/lib/openorb/node/bin/npx /usr/local/bin/npx \
    && curl --fail --location --show-error \
        "https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${AGENT_BROWSER_ASSET}" \
        --output /usr/local/libexec/agent-browser \
    && printf '%s  %s\n' \
        "${AGENT_BROWSER_SHA256}" \
        /usr/local/libexec/agent-browser \
        | sha256sum --check --strict - \
    && chmod 0755 /usr/local/libexec/agent-browser \
    && curl --fail --location --show-error \
        "https://raw.githubusercontent.com/vercel-labs/agent-browser/v${AGENT_BROWSER_VERSION}/LICENSE" \
        --output /usr/share/doc/agent-browser/copyright \
    && printf '%s  %s\n' \
        "${AGENT_BROWSER_LICENSE_SHA256}" \
        /usr/share/doc/agent-browser/copyright \
        | sha256sum --check --strict - \
    && curl --fail --location --show-error \
        "https://github.com/vercel-labs/agent-browser/archive/refs/tags/v${AGENT_BROWSER_VERSION}.tar.gz" \
        --output /tmp/agent-browser-source.tar.gz \
    && printf '%s  %s\n' "${AGENT_BROWSER_SOURCE_SHA256}" /tmp/agent-browser-source.tar.gz \
        | sha256sum --check --strict - \
    && tar -xzf /tmp/agent-browser-source.tar.gz \
        --strip-components=2 \
        -C /usr/local/share/agent-browser/skills \
        "agent-browser-${AGENT_BROWSER_VERSION}/skill-data" \
    && curl --fail --location --show-error \
        "https://registry.npmjs.org/corepack/-/corepack-${COREPACK_VERSION}.tgz" \
        --output /tmp/corepack.tgz \
    && printf '%s  %s\n' "${COREPACK_SHA256}" /tmp/corepack.tgz \
        | sha256sum --check --strict - \
    && curl --fail --location --show-error \
        "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz" \
        --output /tmp/pnpm.tgz \
    && printf '%s  %s\n' "${PNPM_SHA256}" /tmp/pnpm.tgz \
        | sha256sum --check --strict - \
    && curl --fail --location --show-error \
        "https://registry.npmjs.org/yarn/-/yarn-${YARN_VERSION}.tgz" \
        --output /tmp/yarn.tgz \
    && printf '%s  %s\n' "${YARN_SHA256}" /tmp/yarn.tgz \
        | sha256sum --check --strict - \
    && npm_config_cache=/tmp/npm-cache npm install --global --ignore-scripts --no-audit \
        --no-fund --prefix /usr/local/lib/openorb/corepack /tmp/corepack.tgz \
    && npm_config_cache=/tmp/npm-cache npm install --global --ignore-scripts --no-audit \
        --no-fund --prefix /usr/local/lib/openorb/pnpm /tmp/pnpm.tgz \
    && npm_config_cache=/tmp/npm-cache npm install --global --ignore-scripts --no-audit \
        --no-fund --prefix /usr/local/lib/openorb/yarn /tmp/yarn.tgz \
    && ln -s /usr/local/lib/openorb/corepack/bin/corepack /usr/local/bin/corepack \
    && ln -s /usr/local/lib/openorb/pnpm/bin/pnpm /usr/local/bin/pnpm \
    && ln -s /usr/local/lib/openorb/pnpm/bin/pnpx /usr/local/bin/pnpx \
    && ln -s /usr/local/lib/openorb/yarn/bin/yarn /usr/local/bin/yarn \
    && ln -s /usr/local/lib/openorb/yarn/bin/yarnpkg /usr/local/bin/yarnpkg \
    && curl --fail --location --show-error \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ASSET}" \
        --output /tmp/bun.zip \
    && printf '%s  %s\n' "${BUN_SHA256}" /tmp/bun.zip \
        | sha256sum --check --strict - \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 "/tmp/bun/${BUN_ASSET%.zip}/bun" /usr/local/bin/bun \
    && ln -s bun /usr/local/bin/bunx \
    && curl --fail --location --show-error \
        "https://raw.githubusercontent.com/oven-sh/bun/bun-v${BUN_VERSION}/LICENSE.md" \
        --output /usr/share/doc/bun/copyright \
    && printf '%s  %s\n' "${BUN_LICENSE_SHA256}" /usr/share/doc/bun/copyright \
        | sha256sum --check --strict - \
    && curl --fail --location --show-error \
        "https://github.com/vi/websocat/releases/download/v${WEBSOCAT_VERSION}/${WEBSOCAT_ASSET}" \
        --output /usr/local/bin/websocat \
    && printf '%s  %s\n' "${WEBSOCAT_SHA256}" /usr/local/bin/websocat \
        | sha256sum --check --strict - \
    && chmod 0755 /usr/local/bin/websocat \
    && curl --fail --location --show-error \
        "https://raw.githubusercontent.com/vi/websocat/v${WEBSOCAT_VERSION}/LICENSE" \
        --output /usr/share/doc/websocat/copyright \
    && printf '%s  %s\n' "${WEBSOCAT_LICENSE_SHA256}" /usr/share/doc/websocat/copyright \
        | sha256sum --check --strict - \
    && rm -rf /tmp/agent-browser-source.tar.gz /tmp/bun /tmp/bun.zip /tmp/corepack.tgz /tmp/node.tar.xz /tmp/npm-cache /tmp/pnpm.tgz /tmp/yarn.tgz \
    && node --version \
    && npm --version \
    && corepack --version \
    && pnpm --version \
    && yarn --version \
    && bun --version \
    && websocat --version

COPY agent-browser-wrapper.sh /tmp/agent-browser-wrapper.sh

RUN sed "s/@CHROMIUM_VERSION@/${CHROMIUM_VERSION}/g" \
        /tmp/agent-browser-wrapper.sh > /usr/local/bin/agent-browser \
    && chmod 0755 /usr/local/bin/agent-browser \
    && rm /tmp/agent-browser-wrapper.sh \
    && bash -n /usr/local/bin/agent-browser \
    && agent-browser --version \
    && agent-browser skills get core >/dev/null \
    && test ! -e /root/.agent-browser/browsers \
    && test -z "$(find /var/cache/apt/archives /var/lib/apt/lists -type f -print -quit 2>/dev/null)"
