# Launch Handoff

Use this document to resume the Programmable Video launch. It records the verified release state, the intended demo, and the remaining work. Read `AGENTS.md`, `README.md`, and this document before acting.

This is a temporary handoff. Keep its pull request in draft, and close it without merging after the launch unless the maintainer wants to retain the document.

Status date: September 11, 2026. The maintainer owns the launch and all public posting decisions. An agent may prepare assets and changes, but must receive explicit maintainer approval before posting, merging, or closing the handoff pull request.

## Product In One Sentence

Programmable Video turns a product repository, visual references, and a short brief into a deterministic React video that can be reviewed locally at an exact Git commit and published to Cloudflare Stream.

## Verified Release State

- Public repository: <https://github.com/AbdulsaboorS/programmable-video>
- Public `main` commit when this handoff was written: `73a16102392c8592b473b05397ce78b23bab1146`
- GitHub is public and configured as a template repository.
- GitHub Actions `Verify` passed for that commit: <https://github.com/AbdulsaboorS/programmable-video/actions/runs/34501784543>
- Formatting, linting, generated types, type checking, builds, and the complete test suite passed before publication testing and in the linked workflow run.
- A fresh clone completed the full local journey: project creation, immutable Git-bundle submission, exact-commit Sandbox build, Preview review, approval, Container rendering, Stream playback, and downloadable MP4 readiness.
- No application deployment is part of the supported journey. Studio, Preview, D1, R2, Workflows, Sandbox, and Containers run locally. Stream is contacted only for final publication.

The implementation and operating instructions live in `README.md` and `docs/deployment-runbook.md`. Treat those as the source of truth instead of copying setup details from this handoff.

## Important Product Boundaries

- Keep the connected product repository read-only.
- Generate composition code in a separate local Git repository.
- Store an immutable local Git bundle in R2 as the revision source of truth.
- Use the same deterministic React composition for Preview and final rendering.
- Require a clean committed revision before submission.
- Run the authoring, build, review, and approval loop locally.
- Require a Cloudflare account with Stream enabled only for final publication.
- Keep tokens, account identifiers, `.dev.vars`, certificates, local database state, reference downloads, and Stream capability URLs out of Git and public output.

## Fixes That Must Remain

- `apps/studio/src/RevisionReviewCanvas.tsx` permits Preview on a distinct HTTP loopback origin during local development while still rejecting arbitrary HTTP and same-origin Preview. This shipped in `824729f`.
- `RendererContainer.sleepAfter` is `"10m"` in `apps/studio/worker/index.ts`. A prior `"2m"` value stopped an active 360-frame render before upload completed. This shipped in `73a1610`.
- `CONTAINER_EXTRA_CA_CERT` supports enterprise TLS interception for Renderer uploads to Stream. Follow the TLS-proxy instructions in `README.md`; never commit the certificate bundle.
- Studio and Preview must use distinct strict ports and shared local persistence. Follow the documented `pnpm dev` path.

## Remaining Work

1. Clone public `main` on the recording laptop. Require a clean worktree, confirm `73a1610` is an ancestor of its current HEAD, and verify GitHub Actions `Verify` passed for that exact HEAD.
2. Follow `README.md` to configure and start the local application. Put secrets only in ignored `.dev.vars` files.
3. Run a short smoke test before recording: load Studio, create or open a project, and confirm Preview opens on its distinct local origin.
4. Record the launch demo in short Screen Studio clips using the script and shot list below.
5. Assemble the clips, review captions, and export an H.264 MP4 suitable for X/Twitter.
6. Watch the exported file from beginning to end. Confirm that text is readable, no credentials or personal information are visible, narration matches the screen, and the final comparison has time to play.
7. Confirm the local worktree is clean and `Verify` is green for public `main` before asking the maintainer to post. Link the GitHub repository in the proposed post.

The launch is complete when the maintainer confirms that the public post contains the final video and repository link, public `main` remains green, and the maintainer has decided whether to close or retain this temporary draft pull request.

### Current Next Action

No recording or editing project is considered portable from the first laptop. The next action is for the maintainer to make a ten-second Screen Studio test export on the recording laptop, inspect it for overlays and export restrictions, and then record the clips below. A prior end-to-end Stream publication proved the product path, but its capability URLs and local state are intentionally absent here. Create a fresh local demo project or use private assets supplied directly by the maintainer.

## Demo Plan

Target 75 to 90 seconds. Use hard cuts between prepared states. Record each section as a separate clip and stop between clips instead of pausing. Use the face camera for the opening and closing, a small face overlay during explanation, and no face overlay during the final comparison.

The demonstration intentionally uses Programmable Video as its own source product. State this plainly so the recursion is easy to follow.

### Script

**0:00-0:09 | Face**

> Making a product video often means manually editing screens and animations. When the product changes, you edit the video again.

**0:09-0:24 | Product UI**

> I built Programmable Video to make videos from product code. I run Studio locally, record a public repo, add references, and write a brief. An agent creates the video as React code without changing the product repo.

**0:24-0:36 | Architecture**

> Studio's build, review, and approval path runs locally. D1 tracks the project, R2 stores each revision, Sandbox builds it, Workflows runs the steps, and Containers render it. Stream publishes the final video.

**0:36-1:03 | Demo**

> I'm using Programmable Video to make a video about itself. Here's the original app.
>
> I add its repo, a screenshot, and my brief. The agent submits a Git commit. I review the frames, approve that commit, and publish it.

**1:03-1:18 | Reveal**

> Here's the original product on the left and the generated video on the right. It keeps the design and turns it into an animated story.

**1:18-1:30 | Close**

> It's an open-source experimental reference implementation, not an official Cloudflare product. You can run it locally and use Cloudflare Stream when you're ready to publish.

### Recording Order

Prepare these screens before recording:

1. A camera-only opening.
2. A clean Programmable Video project screen.
3. The architecture diagram in `README.md`.
4. The original product UI ready for one short interaction.
5. A project with its repository, reference image, and brief already entered.
6. A sanitized handoff excerpt and a coding agent ready to receive the real handoff off-camera.
7. A completed revision with commit provenance and passing checks.
8. The frame-addressable Preview ready to scrub.
9. Approval and finishing controls.
10. A completed Stream publication. Cut to this state instead of recording build, render, or Stream processing time.
11. The original product and generated video side by side, labeled `Original product` and `Generated video`.
12. The public GitHub repository for the closing call to action.

Use the exact handoff generated by Studio off-camera because it contains the current project ID, commands, and temporary reference access. Show only a sanitized excerpt in the recording. Redact project IDs, local paths, tokens, capability URLs, and download commands. A short lead-in for the real off-camera handoff is enough:

```text
Complete this product-video handoff autonomously. Match the source product closely, create a clean short animation of its main workflow, run all checks, commit the result, and submit the exact commit back to Studio.

[PASTE THE HANDOFF FROM STUDIO HERE]
```

The coding agent needs Studio's real generated handoff. The public recording needs only the safe excerpt and a cut to the completed result.

## Recording And Editing

- Record and export at 1920 by 1080, 30 fps, in a 16:9 frame.
- Make a ten-second test recording and export before recording the full demo. Confirm there is no watermark, control overlay, missing microphone audio, or blocked UI.
- Place the camera at eye level. Use a nearby microphone and soft front light.
- Use macOS Video Effects for Portrait blur or background replacement if desired; Screen Studio's canvas background is separate from the webcam background.
- Hide notifications, desktop icons, bookmarks, unrelated tabs, usernames, local paths, and credentials.
- Keep the cursor slow and intentional. Screen Studio can adjust cursor size and zooms after recording.
- Generate captions locally in Screen Studio or another editor, then review every line manually.
- Keep the final side-by-side reveal uninterrupted for at least ten seconds.
- Prefer hard cuts. Avoid decorative transitions and unnecessary music.
- Export an MP4 using H.264, 1080p, 30 fps, with a web or social-media preset.

## Fresh-Agent Instructions

1. Inspect the current branch, worktree, public `main`, open pull request, and latest GitHub Actions result before changing anything.
2. Ask the maintainer which remaining launch step they want help with. Continue from the current next action instead of restarting implementation work that is already verified.
3. Load `video-composer` before creating or changing a composition.
4. Load `cloudflare` before changing Cloudflare architecture or configuration, and consult current Cloudflare documentation.
5. Load `diagnosing-bugs` if the local journey fails. Preserve local state and diagnose the failing boundary. Retry the same immutable bundle only for infrastructure failure; format, type, test, or build failures require a corrected commit and a new submission.
6. Load `no-ai-slop` when revising the spoken script or launch post. Keep the language short, concrete, and conversational.
7. Run the repository's complete verification gates after code changes. Keep launch-video files and generated composition repositories outside the public application repository unless the maintainer explicitly changes that decision.

## Known Non-Code Context

- Use Screen Studio and ensure pause controls are absent from the test export.
- The final video will be edited from short clips rather than recorded as one continuous take.
- The strongest payoff is the final side-by-side comparison between the original Studio UI and the generated animation.
- The call to action must say that local authoring and review do not require Stream credentials; a Cloudflare account with Stream enabled is needed when publishing the finished video.
- A previously generated local composition directory was intentionally excluded from the public repository. Generate or transfer recording assets separately rather than adding local artifacts to application source.
