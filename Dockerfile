FROM oven/bun:1.3.0 AS frontend
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN bun --bun run build

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HERACLES_DATA_DIR=/data HERACLES_HOST=0.0.0.0 \
    GARMIN_TOKENSTORE=/data/garmin
WORKDIR /app
RUN groupadd --gid 10001 heracles && useradd --uid 10001 --gid heracles --create-home heracles \
    && mkdir /data && chown heracles:heracles /data && chmod 700 /data
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY heracles ./heracles
COPY harness ./harness
COPY server.py login.py ./
COPY --from=frontend /build/web/dist ./web/dist
USER heracles
VOLUME ["/data"]
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8791/healthz', timeout=3)"]
CMD ["python", "server.py"]
