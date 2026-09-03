# Build from the repository root so workspace packages and apps/studio/dist are in context.
FROM --platform=linux/amd64 mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  PORT=8080

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY packages/composition-registry/package.json packages/composition-registry/tsconfig.json ./packages/composition-registry/
COPY packages/composition-registry/src ./packages/composition-registry/src
COPY compositions ./compositions
COPY apps/renderer/package.json apps/renderer/tsconfig.json ./apps/renderer/
RUN pnpm install --filter @programmable-video/renderer... --prod --frozen-lockfile --ignore-scripts --reporter append-only \
  && pnpm rebuild esbuild

COPY apps/renderer/src ./apps/renderer/src
COPY apps/studio/dist ./apps/studio/dist

EXPOSE 8080
CMD ["pnpm", "--filter", "@programmable-video/renderer", "start"]
