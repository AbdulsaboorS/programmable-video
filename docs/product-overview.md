# Programmable Video

- [View the GitHub repository](https://github.com/AbdulsaboorS/programmable-video)

## What We Are Building And Why

Programmable Video turns a real product repository into accurate, reusable product videos. A creator describes a short product story, and a coding agent uses the product's actual components, styles, fonts, icons, and assets to build it as a deterministic React composition.

The first video creates a reusable set of product visuals: a "film set" for that product. Later videos can reuse the same interface and add a new story, data, timing, captions, or format instead of rebuilding the product UI from scratch.

Short product videos work well in social posts, documentation, blog posts, landing pages, presentations, and release notes. Today, producing them usually means recording a live product, performing the flow correctly, editing the recording, and repeating much of that work for every variation. Coding agents can make bespoke videos much faster, but the current workflow is usually local and ad hoc. Teams still need a shared way to provide source and assets, review fidelity, collaborate on revisions, render untrusted composition code, and manage the finished media.

Cloudflare already operates much of the media infrastructure this product needs. Stream provides video ingestion, encoding, storage, caption management, thumbnails, secure playback, and delivery. Media Transformations can create clips, alternate sizes and crops, still frames, spritesheets, and audio derivatives. The missing layer is a managed composition workflow that connects product source and coding agents to this infrastructure.

The current release is an open-source reference application for developers exploring a programmable path from product source to published video on Cloudflare. It demonstrates the complete managed workflow while remaining explicit about its prerelease dependencies and operational gaps.

## Who Benefits

- Developer Relations teams creating frequent launch and use-case videos.
- Product managers communicating workflows, concepts, and releases.
- Documentation and education teams adding short illustrative videos to technical content.
- Product and design teams creating accurate demos without maintaining separate mock interfaces.
- Technical marketing teams adapting one product story for websites, presentations, and social channels.
- Developers building automated or data-driven video products on Cloudflare.

These users should not need to understand browser automation, FFmpeg, codecs, or video delivery. They should be able to direct the result, review the product match, and reuse accepted product visuals.

## Ideal Product Journey

### 1. Connect The Product

The creator connects a product repository read-only and selects a source version. They can add reference screenshots, brand assets, product URLs, and examples. Programmable Video keeps generated composition code separate and never writes back to the product repository.

### 2. Describe The Video

The creator explains the use case, audience, destination, story, length, and desired formats. They can also request captions, audio, voice-over, or other channel-specific needs without configuring a video pipeline.

### 3. Create Reusable Product Visuals

A managed coding agent studies the real product source and prepares the components, styles, assets, and fixed demo states needed for video. It records what source it used and identifies any difference from the real product. For an existing product, it starts from previously accepted visuals instead of recreating them.

### 4. Build And Review A Draft

The agent adds the story, data, camera treatment, cursor movement, and frame-based animation. The creator watches a scrubbable preview, compares it with product references, and comments on a specific frame. They can request changes in plain language while the latest valid draft remains available.

### 5. Approve An Exact Revision

The system validates a saved composition revision and shows its source provenance and product differences. The creator approves one exact revision only after confirming that it matches the product. Preview and final render use the same code and inputs.

### 6. Render And Finish The Video

A managed Chrome and FFmpeg composition job renders the approved revision. The Stream Workers binding uploads and manages the finished video from the Worker-based workflow. Stream handles encoding, storage, metadata, caption management, thumbnails, secure playback, and delivery.

Media Transformations can then create the outputs needed for each destination: shorter clips, alternate dimensions, crops, frame captures, spritesheets, or extracted audio. These are derivatives of the approved composition, not replacements for the composition system.

### 7. Publish And Reuse

The creator receives a playable Stream video and the links or embed information needed for its destination. The approved product visuals remain available for the next video, so a new story can reuse the film set and move from brief to published output much faster.

```text
Product source + references + video brief
  -> reusable product visuals
  -> agent-authored composition
  -> preview, frame feedback, and product-match review
  -> approved exact revision
  -> managed Chrome and FFmpeg render
  -> Stream encoding, management, playback, and delivery
  -> Media Transformations variants
  -> reuse for the next product video
```

## Product Principle

The product repository is the source of truth for how the interface looks. Programmable Video is not a general timeline editor and does not ask an agent to redesign the product from screenshots. It gives coding agents a managed way to turn real product source into faithful, reviewable, reusable video.
