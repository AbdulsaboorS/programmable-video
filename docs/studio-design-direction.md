# Studio Design Direction

Status: accepted direction for the next Studio redesign.

## Outcome

Make the complete video journey understandable to any DevRel teammate without training. Optimize the first successful video while keeping existing-project revision and republishing available.

The primary journey is:

1. Create a project.
2. Generate a draft.
3. Review and approve the draft.
4. Finish the video.
5. Publish and use the finished output.

## Product Language

Use **Draft**, **Review**, **Finish**, and **Published video** in the primary interface.

Move revision, build, render, manifest, workflow, commit, and publication details into a **Technical details** drawer. Errors may refer to those concepts only when the user needs them to recover.

## Information Architecture

- The Projects screen shows recent projects and one prominent **New video** action.
- A project opens in a viewport-sized workspace with a four-stage stepper: Draft, Review, Finish, Published.
- The current stage dominates the workspace. Completed stages remain accessible from the stepper.
- Every stage has exactly one emphasized next action.
- Previous generated versions appear as **Draft history**.
- Finished outputs appear separately as **Published videos**.
- Approval is an explicit content and visual checkpoint that unlocks Finish.

## Desktop Workspace

- Header: All projects, project name, stage stepper, and Technical details.
- Main canvas: a flexible preview region on the left and one `360-400px` control panel on the right.
- Center landscape, square, and portrait previews inside the flexible canvas without changing control placement.
- Keep all stage controls and actions in the right panel. Do not create detached bottom actions.
- Avoid full-page scrolling. The control panel may scroll internally while the preview and primary action remain visible.

## Stage Behavior

### Draft

- Make generating a draft or sending agent instructions the primary action.
- Present agent and build progress in plain language.

### Review

- Show the current draft by default.
- Put previous drafts in an expandable Draft history section.
- Make **Approve draft** the primary action.

### Finish

- Group controls into Trim, Format, Audio, and Captions.
- Keep Trim and Format visible. Collapse optional Audio and Captions initially.
- Preview every supported adjustment immediately.
- Make **Publish video** the primary action.

### Published

- Move here automatically after a successful publish.
- Show the newest playable output prominently.
- Put older outputs in expandable history.
- Keep download, share, and retry actions near the output they affect.

## Feedback And Responsive Behavior

- Put human-readable errors beside the affected control with one clear recovery action.
- Put raw diagnostics in Technical details.
- On mobile, toggle between **Preview** and **Controls** instead of compressing both columns.
- Keep the mobile primary action fixed and reachable.
- Provide at least 44px touch targets, visible keyboard focus, and reduced-motion behavior.

## Design Sources

Use the sources selectively rather than combining their component systems:

- [UI Skills](https://www.ui-skills.com/): route work to the smallest relevant design skill.
- [Impeccable](https://github.com/pbakaus/impeccable): primary Operate-mode redesign, critique, distill, clarify, adapt, and harden workflow.
- [Beautiful UI](https://beautifului.dev): agent task rows, approval cards, meaningful loading states, and compact technical activity disclosures.
- [shadcn/ui](https://ui.shadcn.com): accessible component anatomy and predictable interaction states.
- [ReUI](https://reui.io/components): application shell, stepper, file upload, timeline, sheet, and empty-state composition references.
- [Design System Checklist](https://www.designsystemchecklist.com): final system, accessibility, state, responsive, and documentation review.
- [COSS UI](https://coss.com/ui): Field, Fieldset, Group, Scroll Area, Sheet, and Segmented Control composition references.
- [Transitions.dev](https://transitions.dev): restrained panel, drawer, tab, skeleton, error, and success transitions.
- [You Don't Need Animations](https://emilkowal.ski/ui/you-dont-need-animations): motion must communicate state or causality; routine interactions remain immediate and most transitions stay below 300ms.
- [beUI](https://beui.dev): occasional reference for drawers, tabs, sliders, upload progress, and stable error rows.
- [Rare UI](https://rareui.com): inspiration only; its expressive controls and dependency-heavy motion do not fit the routine Studio workflow.

## Implementation Guardrails

- Preserve `@cloudflare/kumo` and the existing CSS architecture.
- Adapt useful patterns instead of adding Tailwind, shadcn, Base UI, ReUI, COSS UI, beUI, or Rare UI as a second design system.
- Resolve hierarchy, copy, and interaction structure before adding motion.
- Use motion only for spatial continuity, progress, error recovery, and infrequent success feedback.
- Preserve all implemented project, review, finishing, publication, and delivery behavior during the redesign.
