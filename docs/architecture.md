# Architecture

```text
Phone PWA → HTTPS proxy → Go HTTP service → SQLite
                               ├─ Garmin Connect cloud (native Go client)
                               └─ official Harness subprocess (JSON-RPC)
                                              └─ configured model provider
```

The Go service owns authentication, synchronization, training state, proposal validation, recovery check-ins, strength logs and export receipts. There is one public HTTP service and one data volume. The official standalone Harness executable is packaged in the image; it has no shell, file, image-reading or directory-changing tools. Go drives its documented initialization and session protocol and closes the process on completion or cancellation.

A Garmin snapshot is the long-term baseline. Local proposals reference exact dated courses or explicitly add independent sessions. A draft is not an adopted plan. Adoption rechecks original content, the day's check-in and the adopted revision, and commits affected records together. One session becoming invalid does not erase unrelated future sessions. Local reversal does not delete already exported Garmin courses, and the interface makes that scope explicit.

Independent workouts can be sent to the Garmin workout library after a second confirmation. They are not substituted into adaptive Coach plans or automatically scheduled. Durable receipts record every send, and the service reads Garmin back before reporting completion. An uncertain response blocks blind retries.

Garmin DI credentials are imported into the private volume and refreshed natively. Region selects an official Garmin host, never an arbitrary credential endpoint. Device timestamps and source status are retained separately from read times. Coach context removes account identity and location fields and labels bounded data samples.

Pairing uses a 24-hour single-use invitation, a user-confirmed POST and a non-expiring, hashed device credential. GET link previews do not consume invitations. HttpOnly cookies are renewed during normal use; browser deletion and private mode can still require pairing again. Only health and installation resources are public. Business APIs, media and application assets require authorization.

The React PWA uses Today, Coach and Plan, with a focused strength drawer. Training check-ins and completed sets are user reports, not edits to Garmin completion status. Exercise images and videos are bundled with per-item provenance and Creative Commons credits. Personal data is never stored in the service worker cache.
