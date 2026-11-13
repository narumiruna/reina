FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567

# This stage has no repository input. Only trusted OS tools and the pinned CLI are installed.
RUN timeout 180 sh -c 'apt-get update && apt-get install -y --no-install-recommends ripgrep fd-find ca-certificates && rm -rf /var/lib/apt/lists/*' \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && timeout 180 npm install --global --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org @earendil-works/pi-coding-agent@1.5.0 \
    && test "$(pi --version)" = "1.5.0" \
    && mkdir -p /workspace /run /opt/reina /opt/deps \
    && chown 1000:1000 /workspace
COPY bridge.mjs ready.mjs probe.mjs prepare.mjs import.mjs dependency-limits.mjs /opt/reina/
LABEL io.reina.runtime="1" io.reina.pi-version="1.5.0"
ENV HOME=/tmp/home PI_CODING_AGENT_DIR=/tmp/reina-agent PI_OFFLINE=1 PI_TELEMETRY=0
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node", "/opt/reina/bridge.mjs"]
