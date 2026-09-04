# Local Operation Runbook

This runbook operates the supported Programmable Video workflow on one development machine. Studio, Preview, D1, R2, Workflows, Sandbox, and Containers run locally. An immutable Git bundle in local R2 is the only source for every submitted revision. Cloudflare Stream is contacted only when a creator publishes an approved video.

## Requirements

- Node.js 24 and Corepack
- pnpm 11.9.0
- Git
- Docker Desktop
- FFmpeg and ffprobe only for the lower-level `pnpm video render` command
- A Cloudflare account with Stream enabled only if you will publish
- A Cloudflare API token with Stream Read and Stream Edit permissions only if you will publish

## Install

Install the workspace:

```sh
corepack enable
pnpm install --frozen-lockfile
```

## Configure Local Secrets

Create the ignored local environment files:

```sh
cp apps/studio/.dev.vars.example apps/studio/.dev.vars
cp apps/preview/.dev.vars.example apps/preview/.dev.vars
```

Set `LOCAL_OWNER_EMAIL` in the Studio file. Generate a key with `openssl rand -hex 32` and set it as `PREVIEW_SIGNING_KEY` in both files. If you plan to publish, also add `STREAM_ACCOUNT_ID` and `STREAM_API_TOKEN` to the Studio file. Stream credentials are not needed to create projects, submit revisions, build previews, or approve a revision.

Never commit `.dev.vars` or secret material.

## Start The Local Application

Start Docker Desktop, then run:

```sh
pnpm dev
```

This command builds Studio, applies pending local D1 migrations, and starts Studio and Preview with shared local R2 persistence. Studio is available at `http://localhost:5173`.

## Give A Brief To An Agent

Create a project in Studio, add a brief and any PNG references, then choose **Give brief to agent**. Copy the generated instructions into a coding agent running from this repository. The instructions create a separate composition repository outside every existing Git worktree, run its checks, commit the result on `main`, and submit the exact commit. The connected product repository remains read-only.

## Submit An Exact Revision

The generated agent instructions submit the current `main` commit with:

```sh
pnpm project submit <local-project-directory>
```

The CLI rejects a dirty worktree, creates a size-bounded Git bundle containing the exact commit, computes its SHA-256 digest, and sends the bundle and commit identity to Studio. Studio verifies the digest and stores the immutable bundle in local R2. This stored bundle is the revision source of truth.

The revision Workflow starts explicitly from the submission. Sandbox checks out only the stored bundle, verifies that detached `HEAD` equals the submitted SHA, runs install, format, typecheck, tests, and build, then publishes the bounded preview to local R2. It does not clone a moving branch or retrieve revision source from another service.

## Review And Revise

Open the exact-SHA preview in Studio. Request changes against the reviewed frame when needed. The agent commits the correction in the same local repository, and you submit the new commit with the same command:

```sh
pnpm project submit ../my-product-video
```

Each submission creates a distinct immutable R2 bundle. Earlier previews remain tied to their original commit. Approving a revision locks review and final rendering to that exact commit and bundle.

## Publish To Stream

After approval, choose finishing settings and publish. The local Container renders the approved source with Chrome and FFmpeg, then uploads the finished MP4 to Stream. Stream handles processing, playback, captions, sharing, and downloadable MP4 generation.

If you do not publish, the workflow remains local through approval and does not require Stream. It ends with an approved preview rather than a final MP4.

If an enterprise TLS proxy intercepts the Renderer upload, pass its PEM root certificate when starting Studio. Configure Docker Desktop separately if the proxy also affects image pulls or builds.

```sh
CONTAINER_EXTRA_CA_CERT="$(cat /path/to/root-ca.pem)" pnpm dev
```

Never commit a CA certificate.

## Smoke Test

1. Start Studio and Preview with `pnpm dev`.
2. Create and reload a project using a public GitHub repository the coding agent can read.
3. Upload a labeled PNG reference and copy the project handoff.
4. Copy the **Give brief to agent** instructions into a coding agent running from this repository.
5. Have the agent initialize a separate repository, implement the draft, run its checks, commit a clean `main` revision, and submit it.
6. Confirm all exact-commit checks pass.
7. Inspect the isolated preview and source provenance, request one frame-specific correction, commit it, and submit the new revision.
8. Approve the corrected immutable revision and test trim, output profile, fit, optional audio, and captions.
9. If Stream credentials are configured, publish and verify playback, MP4 download, sharing, retry, republishing, and publication history.

An infrastructure-failed build can retry the same immutable bundle. A failed format, typecheck, test, or build check requires a corrected commit and a new bundle submission.

## Verification

Run the complete repository gate after setup or dependency changes:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm types:check
pnpm test
pnpm build
pnpm --dir starters/product-project verify
```

## Known Gaps

- GitHub repository access is not verified or authenticated by Studio.
- Sandbox builds retain outbound network access.
- Preview and Stream URLs are bearer capabilities.
- The application has no public tenancy, quotas, abuse controls, or retention automation.
