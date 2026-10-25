# iPhone support

Heracles stays a PWA. After device pairing in Safari, use Share → Add to Home Screen, leave Open as Web App enabled when present, and launch Heracles from its icon. The in-app training panel includes this guide and detects standalone display mode. Pairing remains server-side; clearing browser data or using another browser can require a new invitation.

The top Training control is available from Today, Coach and Plan. It opens a focused sheet for actual current courses, strength logging, recovery check-in, coach review and temporary adjustments. No system overlay or native app is required. Native dialog focus, 44px controls, reduced motion, safe-area insets, keyboard viewport changes and landscape layouts are supported.

A rest timer uses a deadline rather than interval counts. It supports pause/resume, a compact bar when the panel is closed, and restoration after reload. It stores only numeric timing state in this browser, never health data or course names. Returning to the foreground recalculates the remaining time. The page cannot guarantee an alarm while locked or suspended. Screen Wake Lock is optional and feature-detected; the system may reject or release it, especially in power-saving mode. Leaving the active surface releases the lock; returning can reacquire it when still enabled.

| Platform feature | This release |
| --- | --- |
| Home Screen icon and standalone launch | Supported |
| Safe areas, keyboard, landscape, native sheet focus | Supported |
| In-app training controls and rest timer | Supported |
| Optional screen wake lock | When browser and system allow |
| Web Push and app badge | Possible on installed iOS 16.4+ web apps, not enabled here |
| Dynamic Island, Lock Screen Live Activities, system widgets | Require a native iOS extension, not exposed by this PWA |

Apple documents Live Activities using ActivityKit, WidgetKit and SwiftUI in an app widget extension. Adding a site to the Home Screen does not create that extension. A future native companion would need its own implementation, signing and distribution; it should use the existing service rather than duplicate the coach.

Sources: [Apple Home Screen installation](https://support.apple.com/guide/iphone/iphea86e5236/ios), [WebKit Home Screen web app capabilities](https://webkit.org/blog/13878/), [Apple Live Activities](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities).

Validation uses Chromium and WebKit with iPhone viewports and browser API lifecycle checks. It is not physical iPhone or Dynamic Island hardware testing.

The app shell stays in normal document flow. Installed display mode uses `100vh`; browser mode uses `100dvh`, with `navigator.standalone` as well as display-mode detection. Only the open keyboard temporarily sizes the shell from VisualViewport. The bottom navigation owns the bottom safe area once, while the header owns the top inset. Avoid fixing the root or adding independent bottom spacers to individual tabs. Some iOS releases have [WebKit standalone viewport defects](https://bugs.webkit.org/show_bug.cgi?id=313800); emulation cannot establish whether a particular physical device is affected.

Coach replies put conclusions and actions first. Existing activity reports can expose exact reported facts without rewriting stored messages. Detailed evidence and charts are collapsed initially; chart windows must match their stated period, and missing measurements stay missing.
