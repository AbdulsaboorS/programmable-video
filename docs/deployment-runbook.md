# Deployment Runbook

This guide deploys the complete Programmable Video reference application into your Cloudflare account. It is a manual, advanced setup rather than a one-click installer.

## Availability And Cost

You need Workers, Workflows, Containers, Sandbox, Artifacts, D1, R2, Stream, and Zero Trust Access. Product availability and account limits vary. The pinned Wrangler version labels Artifacts and Sandbox commands as prerelease functionality.

The deployment creates billable compute, storage, and video resources. Delete test projects, Containers, R2 objects, and Stream videos when you no longer need them.

## Local Requirements

- Node.js 24, Corepack, Git, Docker, FFmpeg, and ffprobe.
- A Cloudflare account with the required products enabled.
- Wrangler authenticated to the target account with `pnpm --filter @programmable-video/studio exec wrangler login`.
- A `workers.dev` subdomain or custom domains for the Studio and Preview Workers.

Install the repository first:

```sh
corepack enable
pnpm install --frozen-lockfile
```

## Choose Account Values

Record these non-secret values for the rest of the setup:

```sh
export ARTIFACTS_ACCOUNT_ID="<account-id>"
export ARTIFACTS_NAMESPACE="programmable-video"
export STUDIO_ORIGIN="https://programmable-video-studio.<workers-subdomain>.workers.dev"
export PREVIEW_ORIGIN="https://programmable-video-preview.<workers-subdomain>.workers.dev"
export ACCESS_AUD="<studio-access-audience>"
export ACCESS_TEAM_DOMAIN="https://<team-name>.cloudflareaccess.com"
```

Replace the example origins and account values in both Wrangler configuration files. Keep the Studio and Preview origins exact: no trailing slash, path, query, credentials, or fragment.

## Provision Storage

Create D1 and copy the returned `database_id` into the `PROJECTS_DB` entry in `apps/studio/wrangler.jsonc`:

```sh
pnpm --filter @programmable-video/studio exec wrangler d1 create programmable-video-projects
```

The completed binding must contain the returned identifier:

```jsonc
{
  "binding": "PROJECTS_DB",
  "database_name": "programmable-video-projects",
  "database_id": "<returned-database-id>",
  "migrations_dir": "migrations",
}
```

Create the three private R2 buckets:

```sh
pnpm --filter @programmable-video/studio exec wrangler r2 bucket create programmable-video-previews
pnpm --filter @programmable-video/studio exec wrangler r2 bucket create programmable-video-references
pnpm --filter @programmable-video/studio exec wrangler r2 bucket create programmable-video-media
```

Apply every D1 migration before deploying project APIs:

```sh
pnpm --filter @programmable-video/studio exec wrangler d1 migrations apply programmable-video-projects --remote
```

Migration `0008_managed_publications.sql` intentionally aborts if legacy render jobs are queued or running. A fresh deployment has no legacy jobs.

## Provision Artifacts

Create the `programmable-video` namespace in the Cloudflare dashboard. Then create the seed repository and request structured output:

```sh
pnpm --filter @programmable-video/studio exec wrangler artifacts repos create product-project-starter-v1 \
  --namespace programmable-video \
  --description "Programmable Video managed composition starter" \
  --default-branch main \
  --json
```

The creation response contains the repository's HTTPS remote and initial write token. Do not issue a second token. Copy both values without saving the response to the repository.

Push only the reviewed starter tree. Run this block in Bash (`bash` starts it on systems whose default shell is different). The hidden prompt keeps the token out of shell history, and the credential helper keeps it out of Git configuration and process arguments:

```bash
export ARTIFACTS_REMOTE="<remote-from-create-response>"
read -r -s -p "Artifacts write token: " ARTIFACTS_TOKEN && printf '\n'
export ARTIFACTS_TOKEN
export ARTIFACTS_GIT_HELPER='!f() { printf "%s\n" "username=x" "password=$ARTIFACTS_TOKEN"; }; f'
seed_dir="$(mktemp -d "${TMPDIR:-/tmp}/programmable-video-seed.XXXXXX")"
trap 'rm -rf "$seed_dir"; unset ARTIFACTS_TOKEN ARTIFACTS_GIT_HELPER ARTIFACTS_REMOTE' EXIT
git archive HEAD:starters/product-project | tar -x -C "$seed_dir"
git -C "$seed_dir" init -b main
git -C "$seed_dir" add .
git -C "$seed_dir" -c user.name="Programmable Video" -c user.email="noreply@example.com" commit -m "Seed product video starter"
git -C "$seed_dir" remote add origin "$ARTIFACTS_REMOTE"
git -C "$seed_dir" -c credential.helper= -c "credential.helper=$ARTIFACTS_GIT_HELPER" push -u origin main
```

Let the initial token expire after the push. Issue a short-lived read token and use the same credential-helper pattern for a fresh clone, then run `pnpm install --frozen-lockfile && pnpm verify` inside it before continuing.

Create an account API token with **Artifacts Read** permission. Studio uses it only for exact-commit content retrieval because that path currently uses the Artifacts REST API.

## Prepare Secrets

Copy the example files and replace every placeholder. Use the same random `PREVIEW_SIGNING_KEY` value in both files:

```sh
cp apps/studio/.dev.vars.example apps/studio/.dev.vars
cp apps/preview/.dev.vars.example apps/preview/.dev.vars
```

Both `.dev.vars` files are ignored by Git. Wrangler receives them through `--secrets-file` during the first complete deployment, so setting a secret does not create an earlier incomplete deployment. Never pass secret values as command arguments.

## Configure Access

Deployments must keep the creator Studio private:

1. Create a self-hosted Access application for the Studio hostname.
2. Add an Allow policy for the intended testers.
3. Copy its audience tag and team domain into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`.
4. Keep the Preview Worker inaccessible except through its short-lived capability URLs.

Create more-specific self-hosted Access applications with Bypass policies for exactly these paths:

```text
<studio-host>/api/internal/project-media/*
<studio-host>/api/internal/project-references/*
```

These routes independently require short-lived, digest-bound HMAC capabilities and return `404` for invalid or missing credentials. Do not bypass `/api/*` or the complete Worker.

## Generate Types And Verify

After editing Wrangler configuration, regenerate platform types and run the complete gate:

```sh
pnpm --filter @programmable-video/studio types:worker
pnpm --filter @programmable-video/preview types:worker
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Deploy

Docker must be running because Wrangler builds the Renderer and Sandbox images.

Deploy Preview first:

```sh
pnpm --filter @programmable-video/preview exec wrangler deploy \
  --secrets-file .dev.vars \
  --var "STUDIO_ORIGIN:$STUDIO_ORIGIN"
```

Build the browser bundle and deploy Studio with the same build identifier:

```sh
export BUILD_ID="$(git rev-parse --short HEAD)"
VITE_BUILD_ID="$BUILD_ID" pnpm --filter @programmable-video/studio build
pnpm --filter @programmable-video/studio exec wrangler deploy \
  --config dist/programmable_video_studio/wrangler.json \
  --secrets-file .dev.vars \
  --var "BUILD_ID:$BUILD_ID" \
  --var "STARTER_REPOSITORY:product-project-starter-v1" \
  --var "ACCESS_AUD:$ACCESS_AUD" \
  --var "ACCESS_TEAM_DOMAIN:$ACCESS_TEAM_DOMAIN" \
  --var "ARTIFACTS_ACCOUNT_ID:$ARTIFACTS_ACCOUNT_ID" \
  --var "ARTIFACTS_NAMESPACE:$ARTIFACTS_NAMESPACE" \
  --var "PREVIEW_ORIGIN:$PREVIEW_ORIGIN" \
  --var "STUDIO_ORIGIN:$STUDIO_ORIGIN"
```

Passing `--var` replaces the deployed plain-text variable set. Compare all resulting bindings and variables before moving traffic. Confirm existing secrets remain attached.

## Smoke Test

1. Open Studio in a clean browser and authenticate through Access.
2. Create and reload a project using a GitHub repository the coding agent can read.
3. Upload a labeled PNG reference and issue a temporary handoff.
4. Have the agent clone the seeded Artifacts repository, download the reference, push a revision, and report its commit.
5. Wait for all five exact-commit checks and inspect the isolated preview and source provenance.
6. Request one frame-specific revision, approve the corrected immutable draft, and continue to Finish.
7. Test trim, output profile, fit, optional audio, and captions, then publish.
8. Verify Stream playback, MP4 download, sharing, retry, republishing, and publication history.
9. Record or delete the project, repository, Workflow, publication, and Stream resources created by the test.

An infrastructure-failed build can retry the same immutable commit. A failed format, typecheck, test, or build check is invalid and requires a corrected push.

## Known Gaps

- GitHub repository access is not verified or authenticated by Studio.
- Artifacts and Sandbox availability may prevent deployment in some accounts.
- Sandbox builds retain outbound network access.
- Preview and Stream URLs are bearer capabilities.
- Provisioning and teardown are manual.
- The application has no public tenancy, quotas, abuse controls, or retention automation.
