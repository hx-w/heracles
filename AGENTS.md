# Heracles project guide

Heracles is a personal, self-hosted Garmin training companion. The service is Go, SQLite and a React PWA. Official DeepSeek Harness runs as a tool-free JSON-RPC subprocess; model selection is runtime configuration and must not enter coach prompts. There is no Python runtime or compatibility layer.

- Never commit `.env`, `.local`, `.ops`, Garmin credentials, device links, databases, real health fixtures or logs. Operational host/domain/deployment procedures stay in ignored local files.
- Keep Garmin as the training baseline across sports. Distinguish local adjustments, independent exported workouts, self-reported training and native Garmin completion. Do not claim adaptive Coach plans have been edited.
- Proposals require confirmation and revalidate `(date, workout_id)`, source content, check-in and adopted revisions. A change to one session must preserve other sessions. External writes require durable receipts and readback; uncertainty must not trigger blind retries.
- Measurement time and fetch time are different. Preserve missing and zero values; stale data must not become fresh after a fetch or restart.
- Pairing invitations are single-use; GET previews never consume them. Device credentials are hashed and revocable, with no server-side expiry. Keep request size limits before body allocation.
- Keep Harness shell, file and working-directory tools disabled. No account credentials or location fields in coach context.
- Use plain CSS, system typography, generous touch targets and reduced-motion support. Check 320/390px mobile, 1280px desktop, forms, keyboard and drawer focus.
- Validate with `go test -race ./...` and `bun --bun run build`. Test the built Docker image and real protocol boundary.
- `.github/workflows/docker-image.yml` is the only CI. It builds and exports a deployable image; do not add other CI workflows.
- Exercise data/media has its own Creative Commons attribution. Keep per-asset licence and source metadata; application MIT does not override it.
