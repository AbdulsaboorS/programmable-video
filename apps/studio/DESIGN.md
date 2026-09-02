---
name: Programmable Video Studio
description: A precise Cloudflare production workspace for creating and publishing product videos.
colors:
  canvas: "var(--color-kumo-canvas)"
  surface: "var(--color-kumo-base)"
  surface-raised: "var(--color-kumo-elevated)"
  border: "var(--color-kumo-line)"
  text: "var(--text-color-kumo-default)"
  text-strong: "var(--text-color-kumo-strong)"
  text-subtle: "var(--text-color-kumo-subtle)"
  brand: "var(--text-color-kumo-brand)"
  media: "#0b0d10"
typography:
  headline:
    fontFamily: "Inter, sans-serif"
    fontSize: "clamp(1.5rem, 2.2vw, 2rem)"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  control: "6px"
  surface: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
---

# Design System: Programmable Video Studio

## Overview

**Creative North Star: "The Production Console"**

Studio is a quiet, exact operating environment where the video remains the dominant artifact and controls stay close to the decision they affect. It inherits Kumo's Cloudflare familiarity, compact density, and interaction behavior while using a dark media canvas to separate product footage from application chrome.

**Key Characteristics:**

- Preview-first workspaces with one narrow control surface.
- Restrained neutral UI with semantic color reserved for state and action.
- Plain creator language in the main flow; implementation detail stays disclosed on demand.
- Immediate controls and deterministic state rather than decorative motion.

## Colors

Kumo semantic tokens are the source of truth for application surfaces, text, focus, and status. `#0b0d10` is reserved for preview media and its controls.

**The Semantic Color Rule.** Never hard-code an application status or action color when Kumo exposes the corresponding token.

## Typography

**Display Font:** Inter (sans-serif fallback)
**Body Font:** Inter (sans-serif fallback)

Inter is intentionally retained as part of Kumo and Cloudflare consistency. Headings use weight and scale, not ornamental type; technical identifiers use the existing data treatment only where exact values matter.

## Layout

Projects use a centered `960px` maximum reading width. A project workspace fills the viewport below the `56px` header and pairs a flexible preview canvas with a `360-400px` controls panel. At `760px` and below, Preview and Controls become mutually exclusive panes with a full-width segmented switch. Controls and touch targets are at least `44px` high.

Spacing follows a compact 4/8/16/24/32px rhythm. Related labels and values stay tight; stage boundaries and primary decisions receive larger separation.

## Elevation & Depth

The system is flat by default. Borders and tonal surface changes establish hierarchy. Shadows are limited to temporary elevation, such as the project creation form or a sticky Finish action, and use soft blur rather than hard offsets.

## Shapes

Application surfaces use `12px` corners. Inputs and ordinary controls use `6px` corners. Small state badges may be pill-shaped. Preview frames preserve the video's exact aspect ratio and never inherit decorative application rounding that changes its geometry.

## Components

### Navigation

The workspace header contains All projects, the project name, the four numbered stages, and Technical details. The current stage uses `aria-current="step"`; unavailable future stages remain visible but disabled. Mobile retains all four stages and uses Preview/Controls below them.

### Workspace

The preview owns the flexible region. All editing and approval controls stay in the right panel on desktop. Each stage has one emphasized next action. Optional groups and history remain collapsed until requested.

### Feedback and State

Loading, empty, disabled, success, and error states use plain language. Recovery actions sit beside the failure they address. Global mobile alerts sit above the safe-area bottom so they do not cover navigation or headings.

### Technical Details

Technical details use a native modal dialog presented as a right drawer. Escape and backdrop click close it, and focus returns to the trigger. Revisions, commits, builds, manifests, and workflow diagnostics belong here unless needed for recovery.

## Do's and Don'ts

### Do:

- **Do** use Kumo components and semantic tokens before adding local primitives.
- **Do** keep the video visible while creators make desktop decisions.
- **Do** preserve exact stage, approval, revision, and publication state in the URL and interface.
- **Do** keep controls keyboard accessible, visibly focused, and large enough for touch.

### Don't:

- **Don't** compress preview and controls side by side on mobile.
- **Don't** expose infrastructure vocabulary in the primary creator journey.
- **Don't** detach primary actions from the panel containing their inputs.
- **Don't** add decorative animation, gradients, glass effects, or a second component system.
