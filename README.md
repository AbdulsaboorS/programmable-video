# Programmable Video

An agent-native product video studio built on Cloudflare.

[![Verify](https://github.com/AbdulsaboorS/programmable-video/actions/workflows/verify.yml/badge.svg)](https://github.com/AbdulsaboorS/programmable-video/actions/workflows/verify.yml)

Programmable Video turns a product repository, visual references, and a short brief into a deterministic React video. A coding agent authors the composition, the Studio builds and reviews its exact Git commit, and Cloudflare renders and publishes the approved result through Stream.

This repository is an experimental reference implementation for developers exploring what they can build with Cloudflare's developer platform. It is not an official Cloudflare product or a one-click production service.

## The Workflow

1. **Draft:** Record a GitHub source repository, upload visual references, describe the story, and copy a temporary handoff to a coding agent.
2. **Review:** Build the agent's exact commit, inspect a frame-addressable preview, request frame-specific changes, and confirm product fidelity.
3. **Finish:** Approve one immutable revision, then set trim, output shape, fit, optional audio, and captions.
4. **Publish:** Render with managed Chrome and FFmpeg, upload to Stream, and provide playback, MP4 download, sharing, retries, and history.

The source repository stays read-only. Generated composition code lives in a managed Cloudflare Artifacts Git repository. Preview and final rendering use the same deterministic React implementation at the approved commit.

## Cloudflare Architecture

```mermaid
flowchart LR
    Creator[Creator] --> Studio[Studio UI + Worker]
    GitHub[GitHub product source] --> Agent[Coding agent]
    Studio --> Agent
    Agent --> Artifacts[Artifacts Git repository]
    Artifacts --> Revision[Revision Workflow]
    Revision --> Sandbox[Sandbox checks + build]
    Sandbox --> R2Preview[Private R2 preview]
    R2Preview --> Preview[Isolated Preview Worker]
    Preview --> Studio
    Studio --> D1[D1 project state]
    Studio --> R2Media[Private R2 references + media]
    Studio --> Render[Render Workflow]
    Render --> Container[Chrome + FFmpeg Container]
    Container --> Stream[Cloudflare Stream]
    Stream --> Studio
```

| Product     | Responsibility                                                          |
| ----------- | ----------------------------------------------------------------------- |
| Workers     | Studio API, static application, isolated preview, and orchestration     |
| Workflows   | Durable revision checks and managed render execution                    |
| Containers  | Chrome frame capture and FFmpeg rendering                               |
| Sandbox SDK | Isolated install, validation, testing, and build of agent-authored code |
| Artifacts   | Managed Git repositories and exact-commit source retrieval              |
| D1          | Projects, revisions, approvals, jobs, and publication state             |
| R2          | Built previews, uploaded references, and finishing media                |
| Stream      | Video ingestion, encoding, playback, captions, and MP4 delivery         |
| Access      | Identity boundary around the creator Studio                             |

## Repository Map

| Path                             | Responsibility                                                                |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `apps/studio/`                   | React Studio, Worker API, Workflows, migrations, and Cloudflare configuration |
| `apps/preview/`                  | Isolated Worker for exact-revision previews                                   |
| `apps/renderer/`                 | Playwright capture, FFmpeg finishing, validation, and Stream upload           |
| `packages/contracts/`            | Runtime schemas for HTTP, browser, Workflow, and renderer boundaries          |
| `packages/composition-registry/` | Trusted composition registration and lookup                                   |
| `compositions/`                  | Maintained deterministic React compositions                                   |
| `starters/product-project/`      | Seed project forked for each managed product video                            |
| `docs/`                          | Product model, creator journey, finishing contract, and deployment guide      |

## Try It Locally

### Requirements

- Node.js 24 and Corepack
- pnpm 11.9.0
- FFmpeg and ffprobe for local image or video output
- A Playwright-compatible Chromium installation
- Docker only for Container builds and full Cloudflare deployment

Install dependencies:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @programmable-video/renderer exec playwright install chromium
```

Start the Studio interface:

```sh
pnpm dev
```

The interface runs locally. The managed project APIs require the Cloudflare resources and credentials described in [the deployment guide](docs/deployment-runbook.md).

### Render A Maintained Composition

Build the Studio bundle, inspect the registry, and render locally:

```sh
pnpm --filter @programmable-video/studio build
pnpm video list
pnpm video still support-agent --frame 220
pnpm video render support-agent --output ./out/support-agent.mp4
```

The renderer captures deterministic browser frames and encodes them with FFmpeg. Use `--props ./props.json` to provide validated composition properties.

### Edit The Product Starter

The seed project can also run as a small standalone composition workspace:

```sh
cd starters/product-project
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Its `pnpm verify` command checks formatting, types, tests, and the production build. Managed MP4 rendering is performed by the complete Studio pipeline; the starter alone currently provides browser preview and frame rendering.

## Deploy The Complete Studio

The managed application is intentionally infrastructure-heavy. You need a Cloudflare account with Workers, Workflows, Containers, Sandbox, Artifacts, D1, R2, Stream, and Access. Artifacts availability is limited, and the pinned Wrangler version labels its commands as private beta.

Deployment is manual and intended for experienced Cloudflare developers. It requires:

- Creating and configuring D1, three R2 buckets, an Artifacts namespace and seed repository.
- Setting Worker secrets and account-specific origins.
- Deploying the Preview Worker before the Studio Worker.
- Protecting Studio with Access while bypassing only two capability-protected internal media paths.
- Accepting the cost and security responsibility of running agent-authored code in Sandbox and Containers.

Follow [the deployment runbook](docs/deployment-runbook.md). Do not deploy using the example defaults without replacing them for your account.

## Security Boundaries

- The Studio is designed to run behind Cloudflare Access.
- Generated repository credentials are temporary, scoped, returned with `Cache-Control: private, no-store`, and never persisted in plaintext by Studio.
- Reference and finishing-media downloads use expiring, digest-bound HMAC capabilities.
- Connected GitHub repositories are source context only. Studio does not verify repository access; the coding agent must be able to read them.
- Sandbox builds currently retain outbound network access. Add an egress policy before accepting untrusted public users.
- Preview and Stream URLs are bearer capabilities in this prototype.

See [SECURITY.md](SECURITY.md) before operating a deployment.

## Quality

Run the complete local gate:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions runs the same checks on pull requests and pushes to `main`.

## Project Scope

The current path supports one GitHub source repository per project, uploaded PNG references, external-agent Git handoff, exact-commit checks, immutable approval, constrained finishing, and Stream delivery for 12- or 15-second 1280x720 videos at 30 fps.

It is not a general timeline editor, hosted public SaaS, or automated one-click deployment. Authentication for private GitHub source repositories, public tenancy, quotas, retention automation, and Sandbox egress restrictions remain future work.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Composition changes must keep every rendered frame a deterministic function of the frame number and typed properties.

## License

Licensed under the [Apache License 2.0](LICENSE).
