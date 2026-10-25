# Contributing

Heracles enhances Garmin training, with a focus on activity review, practical temporary adjustments, recovery feedback and strength training. Keep new work focused on these flows. Avoid adding social features, a second long-term planning system or extra background services.

Use Go 1.25+, Bun and the official Harness CLI for local development. Check changes with:

```sh
go test -race ./...
bun --bun run build
```

Tests use temporary SQLite databases, fake HTTP endpoints and explicit fixtures. Do not commit personal activity data, credentials, pairing links or runtime output. UI changes should include mobile screenshots labeled as fixtures when appropriate.

A pull request should explain the user-visible problem, resulting behavior and checks actually run. Cover multi-sport same-day sessions, stale or missing sources, concurrent actions, retries and reversals where relevant. CI is limited to Docker image construction and export; run tests locally rather than adding unrelated jobs.

Exercise media is not MIT code: preserve its per-file credits and licence. See [media attribution](docs/exercise-media.md).
