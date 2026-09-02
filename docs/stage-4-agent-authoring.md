# Stage 4: Agent Authoring Foundation

## Status

Completed and verified on August 19, 2026. These requirements are preserved as the historical acceptance contract for the trusted-composition rendering foundation. The product now continues with the managed product-project workflow described in the [product overview](product-overview.md).

## Outcome

A coding agent working in this repository can create a new trusted React video composition, validate and preview it with structured tools, and make it available in the studio without changing rendering or orchestration infrastructure.

Stage 4 is complete when both the existing support-agent composition and a new product-launch composition can be selected in the studio, edited through typed forms, rendered by the managed Container, and delivered through Stream.

## Initial Users

Optimize the first internal alpha for DevRel and documentation teams creating product explainers, launch videos, tutorials, and release content.

## Authoring Flow

```text
Person describes a video to a repository coding agent
  -> agent reads the video-composer skill
  -> agent creates a composition and bundled assets
  -> structured commands validate props, timing, and frames
  -> human reviews the source and preview
  -> reviewed code is merged and deployed
  -> internal user selects the composition in the studio
  -> user edits typed fields and submits a render
  -> Container renders Chromium frames and FFmpeg encodes MP4
  -> Stream processes, stores, and serves the result
```

Generated code remains trusted repository code. Human review and deployment are required before it can run in a Cloudflare Container.

## Product Decisions

- Author with repository coding agents, not an embedded studio chat.
- Require a human-reviewed merge before generated code is deployed.
- Keep the fixed 1280x720, 30fps, 360-frame, H.264, no-audio profile.
- Bundle fonts, images, SVGs, and screenshots in composition packages.
- Block render-time network requests as the prototype does today.
- Generate basic studio forms from declared `text` and `textarea` fields.
- Add a minimal composition selector to complete the second composition's browser-to-Stream path.
- Keep the existing Kumo studio and managed render architecture.

## Composition Module

Introduce one composition module interface shared by authoring tools, the studio, and the renderer. It must provide:

- Stable composition ID, label, and description.
- The fixed video specification.
- Runtime props schema and inferred props type.
- Valid default props.
- Basic field descriptions for generated forms.
- Representative review frames.
- The React frame renderer used by preview and capture.

Keep serializable metadata and schema free of React and CSS side effects. A composition package may expose its manifest separately from its visual implementation. Infrastructure code must not import composition-specific props or branch on composition IDs.

Create one side-effect-free manifest registry as the source of truth for IDs, schemas, defaults, fields, and review frames. The Worker and command validation must be able to import it without React, DOM globals, CSS, fonts, or visual assets entering their dependency graphs.

Create a browser-only adapter that pairs each registered manifest with its React renderer. It must import the same manifest object rather than duplicate metadata, and it must verify one renderer for every manifest with no extras. Adding a future composition should require its package and registry entry, not edits to the Worker, Workflow, Container server, or frame capture loop.

The first implementation should support only strict, flat object schemas whose editable values are strings. Every schema key must have exactly one ordered field descriptor, and descriptors cannot name unknown keys. A field descriptor contains its key, label, `text` or `textarea` control, and a valid preview frame; textarea rows may be optional. Defaults must pass the schema. Validation errors must appear on the corresponding generated field.

## Generalized Render Contract

Replace the support-agent-only request with a validated request containing:

```text
compositionId
props
buildId
```

Carry `compositionId` through the studio, browser frame bridge, Worker, Workflow, Container request, renderer, still command, and local render command. Validate props against the selected composition at every system boundary that accepts untrusted serialized data.

Reject unknown IDs, props for the wrong composition, and build mismatches with safe structured failures. There is no backward-compatibility requirement for the old support-agent-only request shape because the browser and deployment update together.

Public render creation returns HTTP 400 for an unknown composition or invalid/mismatched props, HTTP 409 for a build mismatch, and HTTP 202 for a valid submission. Existing render lookup behavior remains HTTP 404 for an unknown job.

Tighten browser request isolation while generalizing the renderer. HTTP and HTTPS requests are allowed only when their origin exactly equals the renderer's generated `staticServer.origin`; reject external hosts, alternate loopback hosts, and alternate loopback ports. Browser-internal `about:`, `data:`, and `blob:` URLs may remain allowed. Add tests for the allowed asset origin and rejected network destinations.

## Structured Agent Commands

Expose the commands through the root `pnpm video` script:

```sh
pnpm video list [--json]
pnpm video validate <composition-id> [--props <path>] [--json]
pnpm video still <composition-id> --frame <number> [--props <path>] [--output <path>] [--json]
pnpm video render <composition-id> [--props <path>] [--output <path>] [--json]
```

Commands use default props when no props file is supplied. Exit 0 on success, 1 for validation or execution failure, and 2 for invalid command usage. Human-readable failures go to stderr.

With `--json`, write exactly one versioned envelope to stdout for both success and failure. Use `{ "version": 1, "ok": true, "command": "...", "data": ... }` for success and `{ "version": 1, "ok": false, "command": "...", "error": { "code": "...", "message": "..." } }` for failure. Define error codes for invalid usage, unknown composition, invalid props, invalid frame, I/O failure, and render failure. Command data returns registered manifest summaries, normalized validated props, or the created artifact path and metadata as applicable. Do not mix progress text into JSON stdout. Do not add MCP until these command interfaces prove sufficient.

## Video-Composer Skill

Add `.agents/skills/video-composer/SKILL.md` and point to it from `AGENTS.md`. Teach the agent:

- The composition module interface and package layout.
- Deterministic frame rules and prohibited behavior.
- Story data, visual module, and timeline separation.
- Bundled asset and CSS namespacing rules.
- Generated form field constraints.
- Structured commands and expected review loop.
- Required tests, representative frames, and completion checks.

After the skill and module interface exist, use a fresh agent context to author the second composition from the skill. Give it this evaluation prompt:

> Read `AGENTS.md` and the video-composer skill. Create and register the `product-launch` composition described in `docs/stage-4-agent-authoring.md`. Do not add composition-specific branches to the renderer, Worker, Workflow, or Container. Validate it, render its representative stills, and produce a local MP4.

The fresh agent may inspect the repository and existing support-agent composition, but it must rely on the documented module interface and commands.

## Product-Launch Composition

Create an original, visually distinct 12-second product-launch composition. Use synthetic content and bundled assets. Its typed fields should cover a concise launch story such as product name, headline, supporting copy, benefits, and call to action.

The timeline should establish the announcement, demonstrate the product idea, reveal benefits, and hold a complete final call to action. It must not reuse the support-agent scene structure or merely reskin its visuals.

## Studio Requirements

- Show a compact selector for registered compositions.
- Reset to validated defaults when switching compositions.
- Generate consistent Kumo fields from the selected manifest.
- Preview the selected composition through the existing isolated iframe.
- Preserve playback, exact-frame scrubbing, accessibility, render state, and Stream result links.
- Submit `compositionId` and validated props to the managed render path.
- Disable composition switching while a render is submitting, queued, or rendering.
- When switching after an idle or terminal state, abort stale polling, clear the previous result and errors, load the new defaults, and initialize its preview.
- Keep the current useful task order on desktop and mobile.

This is a selection, preview, and render surface. Prompt-based composition generation inside the studio is not part of Stage 4.

## Verification

Add focused coverage for:

- Unique registry IDs and valid defaults.
- Exhaustive ordered field descriptions, valid controls, and valid preview/review frames.
- Timeline boundaries for both compositions.
- Unknown composition IDs and mismatched props at public boundaries.
- Exact HTTP 202, 400, 404, and 409 behavior described above.
- Renderer network isolation for the exact static origin.
- Browser bridge initialization and frame rendering for both compositions.
- Structured command success, JSON output, and failure exit codes.
- Composition switching and stale result cleanup.
- Existing support-agent behavior after migration.

Before migrating support-agent, capture its existing representative frames in the pinned Linux/amd64 Container environment. Hash the raw 1280x720 RGBA bytes after decoding each PNG, not the encoded PNG bytes. Store the frame numbers, SHA-256 hashes, image dimensions, pixel format, and pinned image identity in `compositions/support-agent/test/fixtures/linux-frame-hashes.json`. The migrated composition must produce identical hashes at those frames in the same environment; if an intentional visual change is required, stop for human approval rather than updating the baseline silently.

Before completion, run formatting, type checks, tests, production builds, representative stills for both compositions, and a local MP4 for the product-launch composition. Deploy one synchronized build and complete one Access-authenticated product-launch render through Stream.

## Acceptance Gates

- A fresh coding agent can create the product-launch composition by following the skill and command interfaces.
- Support-agent and product-launch appear in the studio and validate different props schemas.
- Preview and final rendering use the same registered implementation.
- The Worker imports manifest validation without React, DOM, CSS, fonts, or visual assets.
- The renderer, Workflow, and Container contain no composition-specific branches.
- Support-agent representative frame hashes remain unchanged through migration.
- The product-launch composition produces a valid local MP4.
- The deployed product-launch composition reaches a ready, playable Stream result.
- Existing support-agent tests and managed behavior do not regress.
- Documentation records authoring gaps discovered while building the second composition.

## Stage 4 Non-Goals

- Arbitrary code submitted or executed at runtime.
- Automatic deployment without human review.
- An embedded studio coding agent or chat interface.
- User-uploaded or remote render-time assets.
- Variable durations, dimensions, frame rates, codecs, or aspect ratios.
- Audio, narration, captions, or Media Transformations.
- Render history, cancellation, collaboration, billing, or multi-tenancy.
- MCP tools before the structured command interface is evaluated.

## Implementation Order

1. Define the side-effect-free manifest registry and browser renderer adapter.
2. Capture support-agent frame baselines, then migrate it without changing its rendered behavior.
3. Generalize contracts, frame bridge, renderer, Worker, Workflow, and Container request flow.
4. Add structured authoring commands and the video-composer skill.
5. Use a fresh agent context to create the product-launch composition and record authoring gaps.
6. Add studio selection and generated forms.
7. Verify both local paths, deploy a synchronized build, and run the managed Stream smoke test.

Stop and resolve the module interface if adding the second composition still requires support-specific edits outside its package and registry. Do not hide that coupling behind casts or duplicated conditionals.
