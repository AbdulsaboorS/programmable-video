# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a developer or technical creator making a short product video for a launch, use case, or technical explanation. They need to complete the journey without help from the prototype author and should not need to understand browser automation, FFmpeg, codecs, or video delivery.

Product managers, documentation and education teams, product and design teams, and technical marketing teams are adjacent users.

## Product Purpose

Programmable Video turns a real product repository into accurate, reusable product videos. A creator provides product source, references, and a brief; a coding agent builds a deterministic React composition from the product's real interface; and the creator reviews, approves, finishes, and publishes the result through Stream.

Success means a first-time creator can independently produce and publish a faithful video while recovering from common failures without losing the latest usable draft.

## Positioning

The product repository, rather than screenshots or a separately maintained mock interface, is the source of truth for product visuals. Exact source provenance, deterministic compositions, frame-specific review, and exact-revision approval make the output inspectable and reproducible. Accepted product visuals form a reusable "film set" so later stories do not need to recreate the interface.

## Operating Context

The primary journey is Draft, Review, Finish, and Published. A creator creates a project, records one GitHub repository the coding agent can read, uploads fidelity references, writes a short video brief, and hands the work to an external coding agent. Studio builds the agent's managed revision, presents an isolated frame-addressable preview, supports revision feedback and product-match review, and requires explicit approval of an exact revision.

After approval, the creator can trim the video, choose an output profile and fit, optionally add one audio track and English captions, and publish an immutable finished output through Stream. Published outputs can be played, downloaded as MP4 files when ready, shared with bearer links, and regenerated with different finishing settings without changing the approved source.

## Capabilities and Constraints

- Local operation is intended for one trusted creator. A deployed Studio must use an explicit authentication boundary such as Cloudflare Access.
- Each project records one read-only GitHub product repository as source context. Studio does not verify repository access. Generated composition code lives separately and never writes to the product repository.
- Source videos are 1280x720 at 30 fps and are 12 or 15 seconds long.
- Video visuals must use the product's real components, styles, fonts, icons, assets, labels, spacing, and geometry. Screenshots are fidelity references, not substitutes for usable source.
- Preview and final rendering use the same deterministic React composition at an approved Git commit.
- Approval is attached to an exact revision and build. Finishing never changes that approved source.
- Finishing supports trim, landscape/square/portrait output, contain/cover fit, one bounded audio track, and English captions. It is a constrained form with immediate preview, not a general timeline editor.
- Publications and their finishing specifications are immutable. Publishing changed settings creates another publication.
- Public tenancy, billing, arbitrary formats and durations, a managed in-Studio agent, and general video editing are outside the current scope.

## Brand Commitments

The product name is Programmable Video. Studio should retain Kumo components and established Cloudflare interaction and accessibility consistencies. These provide a trusted foundation rather than limiting the redesign: the accepted Studio design direction and installed design skills lead information hierarchy, workflow clarity, responsive behavior, and visual craft.

Primary interface language uses Draft, Review, Finish, Published video, Draft history, Published videos, and Technical details. Internal implementation terms stay in Technical details unless a creator needs them to recover from an error.

## Evidence on Hand

- `docs/product-overview.md` records the product vision, audiences, mechanism, and ideal journey.
- `docs/deployment-runbook.md` defines the advanced managed deployment path and required platform configuration.
- `docs/finishing-and-delivery-slice.md` defines finishing, publication, delivery, and deferred capabilities.
- `docs/studio-design-direction.md` is the accepted source of truth for the Studio redesign.
- The automated tests and deployment smoke test establish the create-to-Stream path. No public customer claims, benchmarks, or testimonials are established.

## Product Principles

- Make a first faithful video achievable without training.
- Preserve product fidelity by grounding visuals in usable source and explicit human review.
- Keep every preview, approval, render, and publication tied to reproducible inputs.
- Keep technical machinery available for diagnosis but out of the creator's primary path.
- Reuse accepted product visuals instead of rebuilding the product interface for each story.

## Accessibility & Inclusion

Studio must support keyboard navigation, visible focus, reduced-motion preferences, and touch targets of at least 44px. Mobile layouts must preserve preview access, controls, and the current primary action without compressing the desktop workspace. Errors must be human-readable, appear beside the affected control, and provide one clear recovery action.
