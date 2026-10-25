# Garmin editing capabilities

Heracles follows Garmin's training structure across running, cycling, strength and other sports. Original sport keys and full step payloads remain intact, including types the interface does not yet label individually.

There are three distinct capabilities:

| Source | What is established | Current Heracles behavior |
| --- | --- | --- |
| Ordinary custom workouts, numeric ID | The Garmin Connect endpoints support create, full replacement update, schedule and removal. Unscheduled running, cycling and strength test workouts were created, updated, read back and deleted during integration validation. | Read, explain and propose changes. After adoption and a second explicit confirmation, create independent running/cycling/strength workouts in the Garmin library, with durable receipts and readback. No automatic scheduling or overwrite. |
| Garmin adaptive Coach workouts, UUID / FBT_ADAPTIVE | Reading works through the adaptive workout endpoint. The ordinary numeric-ID update endpoint cannot be applied to these workouts. No reliable direct edit has been verified. | Garmin stays authoritative. Local suggestions are clearly labeled and never described as changes to Garmin or the watch. |
| Official Garmin Training API | Publishes third-party workouts and plans with approved Business access. Personal access is pull-only and lists health/activity data, not Training API. This does not establish permission to rewrite Garmin's own adaptive plans. | No partner credentials or unverified writes are assumed. |

Garmin's own rescheduling rules also vary by plan. Its documentation says Run Coach, Cycling Coach, Triathlon Coach and Fitness Coach adapt automatically and do not offer manual workout rescheduling. Expert Running and Strength Coach have different rescheduling options. Do not infer write capability solely from the sport name.

Sources: [Garmin plan behavior](https://support.garmin.com/en-AU/?faq=o21H5a4cSU52FwFAy0R6Z5&productID=707538&tab=topics), [Garmin Developer Program](https://developer.garmin.com/gc-developer-program/overview/), [python-garminconnect](https://github.com/cyberjunky/python-garminconnect).

Any native-write feature must identify the plan kind, show the exact change, require confirmation, recheck its baseline, and verify Garmin's actual result before claiming success. Creating a separate workout is not the same as editing a Coach plan.

Strength exports use native `category` / `exerciseName` keys from [Garmin's exercise catalogue](https://connect.garmin.com/web-data/exercises/Exercises.json), native repetitions and weight units. Repeated sets use repeat groups with the final inter-set rest skipped; the prescribed work, set count and rest remain unchanged. Standard warm-up uses Garmin's warm-up category. An unmapped work exercise is rejected before any course is uploaded, rather than becoming an unnamed step. Teaching detail stays in Heracles; Garmin receives short execution cues and a clean course title. Readback verifies the native steps, counts, weights, units and notes, not only the title.
