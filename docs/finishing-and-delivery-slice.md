# Finishing And Delivery Slice

## Deployment Prerequisite

Before applying `0008_managed_publications.sql`, verify that
`managed_render_jobs` contains no rows with `status` equal to `queued` or
`rendering`. Drain those legacy Workflows first. Migration `0008` enforces this
precondition and aborts rather than backfilling an in-flight Workflow whose exact
legacy step history cannot be preserved. The legacy `/api/renders` API remains a
separate render path.

## Goal

Let a creator turn one approved product-video revision into one or more finished publications without changing the approved source composition.

A creator can trim, choose an output shape, add one audio track, attach captions, publish through Stream, download an MP4, and copy a share link.

## Product Boundary

- Product-match approval remains attached to the exact Git revision and build tuple.
- Finishing never rewrites the approved commit, build artifact, manifest, or approval.
- Each publish snapshots an immutable finishing specification and creates a new publication.
- Changing finishing settings and publishing again creates another publication from the same approved source.
- The source composition remains 1280x720, 30 fps, and 360 or 450 frames.
- This is a finishing form with preview, not a general timeline editor.

## Creator Flow

1. Approve the exact product revision.
2. Open **Finish video** instead of immediately rendering.
3. Select trim start and end on the existing frame-based review canvas.
4. Select an output profile: landscape 1280x720, square 1080x1080, or portrait 1080x1920.
5. Select `contain` or `cover` and preview the framing. `contain` is the default because it preserves approved UI; `cover` uses a center-weighted crop.
6. Optionally upload one audio file and set its volume. Audio starts at publication time zero, is trimmed when longer than the video, ends in silence when shorter, and never loops.
7. Optionally upload one English WebVTT file or request English captions generated from spoken audio after Stream processing. These are selectable Stream captions, not burned into pixels.
8. Confirm the finished-output preview and publish.
9. When Stream and delivery processing are ready, play the publication, download its MP4, or copy its player share link.
10. Change the settings and choose **Publish another version** to create another immutable publication.

## Supported Inputs

- Trim range: half-open source frame interval `[startFrame, endFrame)` within the approved source duration.
- Output fit: `contain` or `cover` only.
- Contain background: `#0b0d10` for the first slice.
- Audio: one MP3, WAV, or M4A file, at most 25 MiB and 60 seconds after decoding.
- Audio gain: muted through 100%. No fade, ducking, offset, or looping.
- Captions: one English WebVTT asset of at most 1 MiB, or Stream-generated English captions from spoken audio.

## Publication Identity

Each managed render job must snapshot:

- approved revision ID;
- approved build attempt, manifest digest, and input digest;
- finishing-spec version and canonical JSON;
- finishing-spec SHA-256 digest;
- immutable audio or caption asset IDs and content digests;
- output dimensions, fit, trim range, and audio gain.

The publication and referenced media identity are immutable. Retrying a failed job may reuse the same publication identity. Changing settings creates a new publication identity.

## Processing Boundary

- Keep the current exact-SHA R2 artifact and renderer bridge unchanged.
- Capture only frames in the selected source range.
- Apply crop, scale, pad, and audio mixing in the existing renderer Container with FFmpeg.
- Retrieve private media assets in Node through short-lived, digest-bound capabilities. Composition JavaScript must not fetch them.
- Validate final dimensions, duration, frame rate, video codec, and expected audio stream before upload.
- Upload the finished MP4 to Stream.
- After Stream is ready, upload WebVTT or request generated captions.
- Request Stream's downloadable MP4 and poll until it is ready.
- Persist player, manifest, thumbnail, caption, and download processing states independently.

Media Transformations is not the primary renderer for this slice. It operates on videos outside Stream and cannot mix a new audio track. The existing FFmpeg pipeline already owns deterministic rendering and can produce the finished master directly.

## Download And Share

- **Download MP4** uses Stream's asynchronous per-video downloadable MP4 generation and appears only when ready.
- The filename is derived from the project and publication and sanitized to Stream's filename rules.
- **Copy share link** copies the ready Stream player URL.
- The share URL is a bearer link, matching the accepted preview and Stream security model.
- Expiring links, revocation, named recipients, and a public watch page are later managed-sharing work.

## Data And API Shape

- Add a versioned finishing contract in `packages/contracts` without widening `ManagedVideoSpec`.
- Store immutable finishing snapshots on managed publication/render records.
- Add owner-scoped private media assets in R2 with D1 metadata and digests, following the product-reference upload boundary.
- Change managed render creation to require the finishing specification and an idempotency key.
- Return publication history rather than only the latest render.
- Add owner-scoped audio/caption upload and publication delivery-status routes.

## Implementation Order

1. Publication identity, no-op finishing spec, idempotent republish, and publication history.
2. Trim rendering and finished-output confirmation.
3. Landscape, square, and portrait output with `contain` and `cover` preview.
4. Private one-track audio upload, validation, capability delivery, and FFmpeg mix.
5. WebVTT upload and optional Stream-generated English captions.
6. Stream MP4 generation, download state, download button, and copy-share-link action.

Each step must be a complete vertical slice with contracts, migrations, ownership checks, UI, failure recovery, and tests before the next begins.

## Acceptance

- A creator can publish a trimmed landscape video from an approved revision.
- The creator can publish square and portrait derivatives without changing or reapproving the source revision.
- `contain` never crops approved UI; `cover` is visibly identified as cropping and requires finished-output confirmation.
- A validated uploaded audio track is mixed deterministically and never exposed publicly before publication.
- Uploaded or generated English captions appear in the Stream player and survive reload.
- Every publication can be played, downloaded as MP4 when ready, and shared by copying its player URL.
- Multiple publications from one approval remain separately visible and reproducible.
- Failed processing can be retried without duplicating a successful publication.
- Another owner cannot read media, create publications, or request delivery links.

## Deferred

- Multi-track timeline editing, clip splitting, reordering, transitions, and arbitrary durations.
- Audio offset, looping, fades, ducking, waveform editing, recording, voice generation, and music libraries.
- Caption text editing, translation, styling, and burned-in captions.
- Manual crop focal points, keyframed crops, and composition-native responsive layouts.
- AI upscaling, quality enhancement, color correction, and effects.
- Managed share expiry, revocation, recipient access control, and analytics.
