# AGENTS.md

## Purpose

Build an agent-native system that turns a team's real product context into reusable, deterministic React video compositions and managed Stream videos.

Keep the code easy for humans and agents to read, review, and change.

## Working Method

- Read `.agents/skills/video-composer/SKILL.md` before creating or changing a video composition.
- Inspect nearby code before adding files or dependencies.
- Check for an existing pattern before creating a new one.
- Read local convention files when they exist.
- Treat design and user experience as engineering requirements.
- Study established solutions before inventing a new pattern.
- State uncertainty instead of guessing.
- Ask when ambiguity would change behavior or architecture.
- Use short, direct sentences and active voice.
- Use one term for each concept.

## Architecture

- Build the smallest complete vertical slice first.
- Keep domain contracts explicit and independent from infrastructure.
- Validate all data that crosses a system boundary.
- Keep composition, rendering, orchestration, and media concerns separate.
- Keep connected source repositories read-only. Store generated composition code in separate local Git repositories.
- Treat an approved Git commit as the source of truth for preview and final render.
- Choose durable boundaries without building speculative capability.
- Prefer established libraries when they reduce total complexity.
- Check existing dependencies before adding or rebuilding functionality.
- Stop and extract shared code when logic begins to repeat.
- Do not add abstractions without a current concrete need.
- Do not preserve obsolete paths or compatibility without a real consumer.
- Reconsider structure when a flat directory approaches ten files.
- Raise unclear or misleading names before extending them.

## Composition Rules

- Make every rendered frame a function of the frame number and typed properties.
- Do not use timers, CSS animations, current time, randomness, or render-time network requests.
- Keep story data, visual components, and timeline logic separate.
- Use the same composition implementation for preview and final rendering.

## Cloudflare

- Check current Cloudflare documentation before choosing APIs or limits.
- Prefer bindings and generated platform types over handwritten API shapes.
- Use immutable local Git bundles in R2 as the only revision source. Use Stream only to publish finished video.
- Never commit tokens, account identifiers, or other secrets.

## Quality

- Add tests for contracts, timing logic, and important render behavior.
- Run formatting, type checks, tests, and relevant builds before completion.
- Explain why in comments. Do not restate the code or record minor history.
- Update documentation when behavior or architecture changes.
