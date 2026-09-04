# Product Video Starter

- Read the connected product source before implementing or changing a video.
- Reuse its exact components, styles, fonts, icons, assets, labels, spacing, and geometry. Screenshots are fidelity references, not substitutes for usable source.
- Add fixed demo data and frame-driven animation without redesigning or approximating the product UI.
- Keep every rendered frame a pure function of the integer frame and validated story props.
- Do not use timers, CSS animation, current time, randomness, or render-time network requests in the composition.
- Keep story contracts, timeline calculations, and visual markup separate.
- Bundle all visual assets locally and namespace composition CSS with `pv-`.
- Preserve the 1280x720, 30 fps, 360-frame specification for this starter.
- Preserve `src/review-bridge.ts` and its exact-origin version-1 Studio protocol when changing the local preview. Preserve `src/render-bridge.ts` for approved frame capture.
- Complete every existing heading and field in `SOURCE_PROVENANCE.md`. Use the full 40-character lowercase source commit SHA, concrete source paths and symbols, and at least one bullet under adaptations and remaining visual differences. Use `None.` when either list has no findings.
- Run `pnpm verify` before committing and submitting a revision.
