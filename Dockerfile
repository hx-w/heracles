FROM oven/bun:1.3.0 AS frontend
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN bun --bun run build

FROM golang:1.25-bookworm AS backend
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o /out/heracles ./cmd/heracles

# Official standalone Harness, pinned by version and SHA256. No Python required.
FROM debian:bookworm-slim AS harness
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) url=https://files.pythonhosted.org/packages/01/f3/1f7b9ea37ece210a5e432089bd63d048b2c45acc910561ec5e730c46a532/deepseek_harness_runtime_bin-0.2.1rc2-py3-none-manylinux_2_28_x86_64.whl; digest=0a0a4eb85a22cd9339972e6a5ced77a27ec791353a5b220e3e10b8cdbbdeca39 ;; \
      arm64) url=https://files.pythonhosted.org/packages/2e/36/dd6d86ab8e4dd4ec2b3ed09ccb3bb28864d86c4e1c31189f7753bd0c07c6/deepseek_harness_runtime_bin-0.2.1rc2-py3-none-manylinux_2_28_aarch64.whl; digest=71ed869e3e9a0e3ea398521730889d2d7e154767834165f1553755818e3f2a78 ;; \
      *) exit 1 ;; esac \
    && curl -fL --retry 3 "$url" -o /tmp/runtime.whl \
    && echo "$digest  /tmp/runtime.whl" | sha256sum -c - \
    && unzip -q /tmp/runtime.whl '*/runtime/*' -d /tmp/unpacked \
    && mkdir /runtime && cp -a /tmp/unpacked/*/runtime/. /runtime/ \
    && chmod -R a+rX /runtime && find /runtime -type f -exec chmod 755 {} +

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 heracles && useradd --uid 10001 --gid heracles --create-home heracles \
    && mkdir /data && chown heracles:heracles /data && chmod 700 /data
COPY --from=backend /out/heracles /usr/local/bin/heracles
COPY --from=harness /runtime/ /opt/dsh/
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) ln -s /opt/dsh/deepseek-harness-sdk-runtime-linux-x64 /usr/local/bin/dsh ;; arm64) ln -s /opt/dsh/deepseek-harness-sdk-runtime-linux-arm64 /usr/local/bin/dsh ;; *) exit 1 ;; esac \
    && dsh --version
ENV HERACLES_DATA_DIR=/data HERACLES_ADDR=0.0.0.0:8791 \
    HERACLES_WEB_DIR=/app/web HARNESS_BIN=/usr/local/bin/dsh HARNESS_PATCH=/app/config/coach.patch.yml
WORKDIR /app
COPY config ./config
COPY --from=frontend /build/web/dist ./web
USER heracles
VOLUME ["/data"]
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD ["heracles", "healthcheck"]
ENTRYPOINT ["heracles"]
