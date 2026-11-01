# ElectricLogo

Adapted from the React Bits ElectricLogo source supplied by the user on 2026-10-11.
Upstream: https://reactbits.dev/animations/electric-logo
License: MIT + Commons Clause License Condition v1.0 (see LICENSE.md).

Token Tracker integration changes:
- Uses the existing Token Tracker bolt SVG, not the example bolt.
- Keeps the canvas hidden until the complete outline is rendered, then fades it in.
- Loading and WebGL failures leave the decoration empty, with no solid placeholder.
- Catches initialization/render failures and handles context loss.
- Cancels frames and removes observers, event listeners and GPU resources on disposal.
- The app wrapper loads the renderer only for visible dark-theme artwork. Light mode
  retains the existing Hairline Hub; reduced motion uses a thin static bolt outline.

The shader and shape tracing remain upstream code. OGL 1.0.11 (Unlicense) provides
the WebGL renderer. Licensing notices are included in THIRD_PARTY_NOTICES.md.
