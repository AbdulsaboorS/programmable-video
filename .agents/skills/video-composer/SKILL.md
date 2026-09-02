---
name: video-composer
description: Create and register trusted deterministic React video compositions in this repository.
---

# Video Composer

Use this skill when creating or changing a composition. Generated compositions are trusted repository code. They require human review and deployment before the managed renderer can execute them.

## Read First

Read these files before editing:

- `AGENTS.md`
- `docs/stage-4-agent-authoring.md`
- `packages/contracts/src/composition-manifest.ts`
- `packages/composition-registry/src/index.ts` and `packages/composition-registry/src/browser.ts`
- One existing composition package, including its manifest, renderer, timeline, styles, and tests

Inspect nearby patterns before adding files or dependencies. Do not add composition-specific branches to the renderer, Worker, Workflow, Container, or frame bridge.

## Package Interface

Create the package under `compositions/<composition-id>/`. Keep these concerns separate:

- `src/manifest.ts`: side-effect-free metadata, strict props schema, defaults, fields, and review frames.
- `src/timeline.ts`: frame ranges and pure frame-derived interpolation helpers.
- `src/<Name>Composition.tsx`: visual renderer receiving only `{ frame, props }`.
- `src/composition.css`: namespaced composition styles.
- `src/browser.ts`: browser-only CSS, font, asset, renderer, and timeline exports.
- Tests: schema/manifest invariants are covered by the registry; add composition timeline and important render-behavior tests.

The package must export `./manifest` separately from `./browser`. Importing the manifest must not load React, DOM globals, CSS, fonts, images, SVGs, screenshots, or other visual assets.

Define the manifest with `defineCompositionManifest`. It must provide:

- A stable kebab-case `id`, human label, and useful description.
- The shared `videoSpec`: 1280x720, 30 fps, 360 frames.
- A strict Zod object whose editable values are all strings.
- Valid default props.
- One ordered field descriptor for every schema key, with no extras or duplicates.
- Representative review frames within frame 0 through 359.

Fields use only `text` or `textarea`. Every field needs `key`, `label`, `control`, and an in-range `previewFrame`. A textarea may specify a positive integer `rows` value. Choose the preview frame where that field's effect is clear.

Register the manifest once in `packages/composition-registry/src/index.ts`. Pair that same manifest object with its React renderer in `packages/composition-registry/src/browser.ts`. The browser registry enforces exactly one renderer per manifest and no extras.

## Deterministic Frames

Every rendered frame must be a pure function of the integer frame number and validated props.

Do not use:

- Timers, CSS animations, CSS transitions that progress with wall time, or asynchronous visual state.
- `Date`, current time, randomness, unstable IDs, or environment-dependent content.
- Render-time network requests or remote fonts, images, scripts, styles, video, or data.
- Browser layout measurements that can vary between preview and capture.

Derive motion numerically from `frame`. Clamp interpolation and boundary behavior. Keep every frame complete, including scene boundaries and frame 359. Preview and final capture must use the same registered React implementation.

## Story, Timeline, And Visuals

Keep editable story data in typed props and immutable synthetic story constants near the composition. Keep scene ranges and interpolation in the timeline module. Keep markup and visual hierarchy in the React module. Do not hide timeline boundaries inside CSS or duplicate story values across modules.

Test each scene start and end, transitions, clamping, and any important reveal boundary. Avoid blank transition frames. Select review frames that cover the opening, major states, transitions worth inspecting, and final hold.

## Assets And CSS

Bundle all fonts, images, SVGs, and screenshots in the composition package. Use package imports so Vite includes them in the browser bundle. Never fetch an asset during rendering.

Prefix the root class and every composition-owned selector with a short composition-specific namespace. Do not style bare elements globally, write to `:root`, or rely on Studio styles. Load CSS and fonts only from the browser entry point. Add dependencies to the composition package, not infrastructure packages.

## Structured Commands

Build the Studio browser bundle before commands that open Chromium:

```sh
pnpm --filter @programmable-video/studio build
```

Use the root command interface exactly:

```sh
pnpm video list [--json]
pnpm video validate <composition-id> [--props <path>] [--json]
pnpm video still <composition-id> --frame <number> [--props <path>] [--output <path>] [--json]
pnpm video render <composition-id> [--props <path>] [--output <path>] [--json]
```

Omit `--props` to use manifest defaults. A props file must be strict JSON matching the selected composition. Omit outputs to create `out/<composition-id>-frame-<frame>.png` or `out/<composition-id>.mp4`. Paths returned by commands are absolute.

Exit status is 0 for success, 1 for validation or execution failure, and 2 for invalid usage. With `--json`, parse the single version-1 envelope on stdout; do not scrape stderr. Stable failure codes are `INVALID_USAGE`, `UNKNOWN_COMPOSITION`, `INVALID_PROPS`, `INVALID_FRAME`, `IO_FAILURE`, and `RENDER_FAILURE`.

## Review Loop

1. Create the package and register its manifest and browser renderer.
2. Run `pnpm video list --json` and confirm the manifest summary.
3. Run validation with defaults and at least one representative strict JSON props file.
4. Build the Studio bundle.
5. Capture every declared review frame with `pnpm video still` and inspect the PNGs.
6. Render the local MP4 and inspect the complete timeline and final hold.
7. Run formatting, type checks, tests, and production builds.
8. Review all source and generated artifacts with a human before merge or deployment.

## Completion Checks

Before handoff, confirm:

- Manifest imports remain side-effect free and defaults pass the strict schema.
- Registry IDs are unique; fields are exhaustive and ordered; all preview/review frames are valid.
- The browser registry has exact renderer coverage and uses the same manifest object.
- Timeline and important render behavior tests pass.
- Assets are bundled, CSS is namespaced, and no frame performs network access.
- `list`, `validate`, representative `still` commands, and `render` succeed.
- `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.

Do not add runtime code execution, MCP, Studio chat, uploads, variable video specifications, audio, or deployment automation as part of composition authoring.
