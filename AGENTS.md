# Heracles project guide

Heracles enhances Garmin training plans for one self-hosting user. Keep it mobile friendly and simple: one application process, SQLite, Docker, official DeepSeek Harness, `deepseek-flash`.

- Never commit `.env`, `.local`, Garmin credentials, private links, SQLite/FIT files, real health fixtures or generated runtime logs. Do not include them in Docker build context.
- Preserve Garmin snapshots. Coach output is a proposal, adopted only after validation and explicit user action. Identity is `(date, workout_id)`; changes to one session must not remove unrelated sessions.
- Treat source time separately from fetch time. Missing values are not zero. Never invent Garmin data or imply local changes reached a watch.
- Keep the official Harness tool-free. Test runtime startup and failure cleanup when changing its profile or SDK. Never grant shell/file tools to coach prompts.
- Use the existing plain CSS tokens and system fonts. Check 320/390px mobile and 1280px desktop, keyboard layout, touch targets and action error feedback.
- Run `.venv/bin/python -m pytest -q` and `bun --bun run build` locally. Docker is the delivery boundary.
- `.github/workflows/docker-image.yml` is the only CI. It builds the image and exports a deployment artifact; do not add unrelated jobs or workflows.
