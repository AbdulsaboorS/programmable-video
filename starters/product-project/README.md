# Product Video Starter

This repository is the reviewed starting point for one product project's reusable product visuals and videos.

## Start

```sh
pnpm install
pnpm dev
```

The local preview renders the same React composition for any selected frame and supports play, pause, and seeking. Replace the synthetic product UI and story with faithful, locally bundled product context. Keep product visuals in `ProductComposition.tsx`, editable story data in `story.ts`, and frame timing in `timeline.ts`.

Studio embeds the built `index.html` from a separate preview origin. The version-1 protocol in `src/review-bridge.ts` accepts validated play, pause, and seek commands only from the exact parent origin and reports the selected frame back to Studio. Preserve that protocol and `src/render-bridge.ts` while changing the product visuals, story, or timing.

Record the exact product-source commit, reused files and assets, adaptations, and remaining visual differences in `SOURCE_PROVENANCE.md`.

## Checks

```sh
pnpm verify
```

This command runs formatting, type checking, tests, and the production build in order. Commit the reviewed revision, then submit it with the command in the Studio handoff. Studio independently reruns each check at that exact commit in an isolated Sandbox, publishes `index.html` for exact-frame review, and uses `render.html` to capture the same bundled story after approval.
