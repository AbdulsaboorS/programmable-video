# Contributing

Programmable Video is an experimental reference application. Small, focused changes with tests are easiest to review.

## Development

1. Install Node.js and enable Corepack.
2. Run `pnpm install --frozen-lockfile`.
3. Read `AGENTS.md` and the nearest product or design documentation before changing behavior.
4. Add tests for contracts, timing, and important render behavior.
5. Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

Keep connected product repositories read-only. Keep generated composition source separate from product source. Every rendered frame must remain a deterministic function of the frame number and validated properties.

## Pull Requests

Explain the user-visible behavior, important implementation decisions, and verification performed. Never include credentials, account identifiers, private repository links, or production media URLs.
