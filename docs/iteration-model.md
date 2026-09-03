# Prompt-Driven Iteration Model

## Decision

Programmable Video remains source-backed. A creator connects a product repository and provides at least one screenshot for internal-beta fidelity review. Screenshots help the agent and creator judge fidelity; they do not replace usable source code. Later product versions may make references optional when another reliable comparison source exists.

Creators adjust videos by prompting an agent. Studio will not become a general timeline editor. Small controls may later expose common changes such as text, timing, captions, audio, and output shape, but they should update typed inputs or send structured agent instructions rather than create a separate editing model.

## Why Reuse Matters

The first product video establishes faithful, reusable product visuals from the real components, styles, fonts, icons, assets, and fixed product states. A video then adds its own story, timing, camera treatment, cursor movement, captions, and audio.

An iteration such as "hold this screen longer" should change video-specific direction without rebuilding or silently redesigning the accepted product visuals. Later videos should start from the accepted product visuals and add only the states and timeline required by the new story.

The intended model distinguishes:

- **Product visual version:** an accepted source-backed implementation of reusable product UI.
- **Live draft:** the latest compile-valid preview from an agent workspace. It may contain uncommitted work and cannot be approved or rendered.
- **Saved revision:** an immutable Git commit that passed the required checks. It can be reviewed, approved, and rendered while earlier revisions remain available.

The current prototype stores product visuals and video-specific code in one local composition repository and creates previews after the project CLI submits a clean `main` commit. The terms above describe the target boundary, not behavior already available in Studio.

## Target Creator Loop

The target Studio places an agent conversation beside a scrubbable video canvas:

```text
Creator prompt
  -> agent edits an isolated persistent workspace
  -> incremental compilation succeeds
  -> Studio displays the new live draft
  -> creator comments on a frame or requests another change
  -> agent saves a revision when the draft is worth reviewing
  -> clean exact-commit checks run
  -> creator approves and renders the saved revision
```

Studio must keep showing the latest valid draft while the agent is editing or while a new build fails. Partial or broken output must not replace a usable preview. A creator should be able to identify a frame and request a specific change, such as slowing a transition at 4.2 seconds.

Creative feedback should feel interactive. Text, style, and timing changes should appear in seconds when incremental compilation permits it. Full clean checks may take longer and belong at the saved-revision boundary. Final rendering may take minutes because it happens only after approval.

The immutable revision remains the safety boundary. Approval and final rendering never consume an uncommitted live draft.

## Agent Contract

The agent-facing workflow should follow five principles demonstrated well by tools such as `tcut`:

1. Give agents one short task contract containing source identity, video brief, references, local repository path, completion command, and required report.
2. Provide one non-interactive verification command with stable machine-readable results.
3. Treat accepted product visuals as a reusable artifact rather than rebuilding the UI for each video.
4. Make variations change story and timing before changing accepted product visuals.
5. Lead agent documentation with one concise reference and one working example; keep detailed architecture documentation secondary.

The Voice second-repository test showed that the generated handoff was repetitive, verification required several commands, review lacked a correction path, and the exact-commit build was constrained by a `lite` Sandbox. The handoff now keeps dynamic task and access context, the starter exposes `pnpm verify`, review can issue revision-specific external-agent feedback, and saved revisions build on `basic` while retaining independent managed checks.

## Delivery Order

1. The second-repository test, generated-handoff simplification, request-changes handoff, and one-command starter verification are complete.
2. The embedded exact-preview implementation is complete locally with play, pause, frame seeking, time, fullscreen, retry, and frame-specific external-agent feedback. Preview Worker deployment and reviewed-starter synchronization remain release gates.
3. Persist briefs and feedback, accept reference screenshots, and surface source provenance during product-match review.
4. Make the reusable product-visual and video-specific boundaries explicit in the managed project starter.
5. Request a second video from one accepted product visual version and measure creator time, changed files, fidelity, and code reuse.
6. Run an unassisted DevRel creator test, then address build queuing, retry, isolation, egress, and launch documentation. See [Internal Beta Launch Plan](internal-beta-launch-plan.md).

## Not Now

- Screenshot-only UI reconstruction or animation
- A general manual timeline editor
- Live drafts that can bypass exact-commit approval
- Additional output formats, clip editing, or local publishing
- Replacing Stream or the managed renderer
- Platform integration or a managed in-Studio agent during the internal-beta window
