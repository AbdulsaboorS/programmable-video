# Creator Journey

## Goal

A creator should always understand:

- What the product is doing now.
- What has already completed.
- What requires their attention.
- Which product source the agent used.
- Whether the preview matches the real product.
- What will happen after they select the next action.

The interface must explain the creative workflow in product language. It must not require users to understand manifests, Workflows, Containers, hashes, or build infrastructure.

## User-Facing Terms

- **Product**: the connected source repository and the reusable product visuals created from it.
- **Video**: one requested product story.
- **Draft**: the latest preview the creator can review and change.
- **Source version**: the exact source commit used for the product visuals.
- **Render**: the finished video created from an approved draft.

The phrase **film set** can explain the idea in documentation, but the main interface should say **reusable product visuals** until user testing shows that creators understand film set without explanation.

## Journey

### 1. Products

The first screen answers **What can I do here?** before asking for input.

Primary message:

> Turn your real product UI into short videos with a coding agent.

Each product card shows its repository, source version, reusable-visual status, video count, and most recent activity. The empty state shows the complete flow in one sentence and provides one clear **Connect product** action.

### 2. Connect Product

The creator provides a GitHub repository and branch. Studio records the source URL without verifying access, so the coding agent must be able to read it.

Progress is explicit:

```text
Checking repository access
  -> reading project structure
  -> finding UI entry points
  -> checking fonts and assets
  -> ready for a video brief
```

Each step has `waiting`, `working`, `complete`, or `needs attention` status. A failure explains what happened, what the product could not access, and the exact action that can fix it.

### 3. Describe Video

The brief asks for:

- What should happen in the video?
- Who is it for?
- Where will it be used?
- Desired length and shape
- Optional reference links or files

The form includes a plain-language example based on the connected product. Advanced media settings stay hidden until needed.

The main action says **Create first draft**, not **Start Workflow** or **Run build**.

### 4. Agent Progress

The creator sees meaningful work rather than a generic spinner:

```text
Understanding your request
Finding the real product UI
Preparing fixed demo data
Adding animation
Checking visual match
Building preview
```

The current step includes a short explanation. Completed steps remain visible. Technical logs are available behind **View details**, but they are not the primary progress UI.

Progress must come from persisted backend or agent events, not decorative animation. For every long-running operation, show when it started, the latest activity time, elapsed time, the last completed step, the current named step, and what happens next. If no event arrives within the expected interval, say that updates are delayed and offer refresh, retry, or details instead of appearing frozen.

External coding-agent work belongs in the same progress model. The agent should report milestones such as source inspection, implementation, checks, and commit. Until that reporting channel exists, Studio must clearly say that it is waiting for the creator to submit the agent's committed revision and cannot observe work inside the agent session.

The source-use panel lists components, styles, fonts, icons, and assets as the agent selects them. Any source item the agent cannot use is shown immediately with the reason and proposed fallback. The agent cannot silently replace it.

### 5. Preview And Adjust

The video preview is the largest object on the screen. It supports play, pause, frame seeking, current time, duration, and full-screen viewing.

This is an embedded review canvas around the exact built revision, not a general editor. Pausing or seeking selects a frame. A change request records that frame and timestamp before issuing the external-agent handoff.

The creator can request changes in plain language. Common controls support:

- Text and example data
- Scene timing
- Visible captions
- Audio, music, and voice-over
- Output shape

This is not a general timeline editor. The agent edits the composition and returns a new draft. The interface preserves earlier drafts and clearly states when a requested change would alter the real product UI.

Review must provide an explicit **Request changes** action before approval. It preserves the current usable preview, captures frame-specific feedback when available, and starts or resumes agent work on a newer draft. Approval must never be the only clear way forward from a preview.

The target editing experience places the agent conversation beside the preview. A creator can pause on a frame, describe a change, and see the latest compile-valid draft without leaving Studio. Agent work happens in an isolated persistent workspace so incremental changes do not require a clean install and new bundle submission before every preview.

A live draft is not an approval boundary. The agent saves an immutable local Git commit, and the creator submits it as a bundle. The bundle stored in local R2 is the only revision source, and the system runs clean exact-commit checks before the creator can approve or render it. Studio keeps the latest valid preview visible while the agent works or a newer draft fails. See [Prompt-Driven Iteration Model](iteration-model.md) for the target loop and delivery order.

### 6. Check Product Match

Approval is a separate, clear step. The creator sees uploaded source reference screenshots beside matching video frames and can switch or drag between them. The connected repository remains the implementation source; screenshots only establish the expected appearance.

The review summarizes:

- Source version used
- Product files and assets used
- Deterministic changes such as fixed data or frame-driven animation
- Visual differences found
- Checks that passed or need attention

The main action is disabled while an unresolved visual mismatch exists. The creator can ask the agent to fix it or explicitly inspect details. The interface never describes a mismatch as successful.

### 7. Render And Publish

After approval, the interface explains that the approved draft is locked and rendering will not change it. Stream is used only when the creator publishes the finished video; it is not involved in drafting, revision storage, preview, or approval.

Progress is shown as:

```text
Preparing approved draft
  -> rendering frames
  -> creating video
  -> uploading to Stream
  -> processing for playback
  -> ready
```

The completed screen leads with the playable Stream video. Secondary actions expose player, HLS, thumbnail, and download information without overwhelming the main result.

## Global Status Rules

- Never show a spinner without naming the work.
- Never show a disabled action without explaining why.
- Never discard creator input after a failure.
- Never expose an internal identifier unless it helps support or debugging.
- Keep the latest successful preview available while a new draft is being created.
- Polling and retries must not reset the visible workflow.
- Reconnecting or reopening the page must restore persisted progress and timestamps.
- Never advance progress from a timer alone; show only confirmed work and label estimates as estimates.
- Distinguish healthy long-running work from delayed updates and confirmed failure.
- Every failure state must offer retry, correction, or support details.
- Long work may continue when the creator leaves and must show its current state when they return.

## Implemented Frontend Slice

The first redesign consumes validated project and revision API data while preserving the existing backend actions for local handoff, bundle submission, preview, approval, render, and Stream playback.

The slice includes:

- Product selection and connect-product screens
- A persisted video brief copied into external coding-agent instructions
- Truthful waiting and revision-build states; Studio cannot observe work inside the external agent session
- An embedded cross-origin exact-build review canvas with play, pause, frame seeking, time, fullscreen, retry, and separate-tab recovery that keeps the last successful draft available during newer work
- Persisted request-changes feedback that captures the selected frame and timestamp, issues a fresh external-agent handoff for the exact reviewed draft, and preserves its preview
- Manual product-match confirmation with source-use and automated comparison clearly labeled as unimplemented
- Immutable approval, render retry, and embedded Stream playback

Side-by-side comparison and external-agent milestone events remain future slices. They must replace the labeled gaps through validated backend data rather than fixture progress.

Managed agent conversation, live compile-valid drafts, and low-latency incremental preview remain future slices. The implemented request-changes action includes the selected exact-build frame when available and hands persisted feedback to an external coding agent; submitted Git bundles remain the preview and approval boundary.

Current work prioritizes persisted briefs and frame-specific feedback, reference comparison, source provenance, and second-video reuse. Managed agent conversation and live drafts are explicitly deferred.
