# Contributing

## Development

```bash
npm install
npm test            # builds both packages, then runs vitest (no AWS access needed)
npm run typecheck
npm run lint        # eslint (typescript-eslint recommended)
npm run format      # prettier --write; CI runs format:check
```

The repository is an npm workspace with two packages:

- `packages/sandbox-agent` – the HTTP agent that runs inside the MicroVM
  (exec / file API on port 8080, Lambda lifecycle hooks on 9000, root relay
  socket for the `sudo` shim). Node standard library only; bundled with esbuild
  into `dist/image/agent.mjs` next to the `Dockerfile`.
- `packages/mcp-server` – the published npm package. Its build copies the agent
  bundle and Dockerfile into `image/` so `setup` can ship them.

The tests start the real sandbox-agent in-process and drive the MCP server
against a fake Lambda control plane (`packages/mcp-server/test/fake-aws.ts`),
so the whole create / exec / files / transfer / suspend / resume / destroy path
runs locally. `setup` is tested against fake AWS clients as well.

## CI

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` / test | push to main, pull requests | typecheck, lint, format check, `npm test` on ubuntu (Node 20, 22) and macOS (Node 22); packs the npm tarball and runs it with `npx` over stdio to confirm `tools/list` returns 13 tools |
| `ci.yml` / secrets | same | gitleaks over the full history (`.gitleaks.toml` allowlists the dummy test secrets) |
| `ci.yml` / dockerfile | same | hadolint on the image Dockerfile |
| `ci.yml` / image | push to main, or PRs labelled `image` | builds the Dockerfile for linux/arm64 under QEMU, boots it in Docker and drives `/ready`, `/run`, `/exec`, the sudo shim and `/validate` (`packages/sandbox-agent/image/ci-boot-test.sh`). Verifies the dnf package list without AWS. About six minutes |
| `release.yml` | tag `v*` | test, check the tag matches `packages/mcp-server/package.json`, `npm publish --provenance` via npm Trusted Publishing (OIDC, no token secret), GitHub release |
| `e2e.yml` | manual (`workflow_dispatch`) | `setup` + `doctor` + smoke test against a real MicroVM using an OIDC role from the `AWS_ROLE_ARN` repository variable. Billable, so never automatic |

Dependabot keeps npm dependencies (AWS SDK grouped) and actions up to date weekly.

## Building the image from this checkout

```bash
npm run build
npm run build-image -- --region ap-northeast-1 --dry-run   # plan only, read-only AWS calls
npm run build-image -- --region ap-northeast-1             # bucket + role + image (asks first)
npm run doctor -- --region ap-northeast-1
```

`build-image` is an alias for `lambda-microvm-sandbox-mcp setup`. Image
snapshots are billed for storage (about $0.08/GB-month, minimum one week); old
versions can be deleted with `aws lambda-microvms delete-microvm-image-version`.

## Trying it end to end

```bash
npm run smoke-test -- --yes --region ap-northeast-1   # one VM (~$0.13/h at 2 GB), exercised then terminated
```

`.mcp.json` in this repository points Claude Code at the local build
(`node packages/mcp-server/dist/index.js`), so you can test tool changes from a
Claude Code session opened in this directory.

## Releasing

1. Bump `version` in `packages/mcp-server/package.json` and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. `release.yml` runs the tests, publishes to npm with provenance and creates a
   GitHub release. Publishing authenticates through npm Trusted Publishing: the
   package settings on npmjs.com trust `ndmxjp/lambda-microvm-sandbox-mcp` /
   `release.yml`, so no npm token is stored in GitHub. Users pick up the new
   image assets by running `npx lambda-microvm-sandbox-mcp setup` again.

## Conventions

- TypeScript, ESM, Node 20+. Formatting is prettier's; lint is eslint with
  typescript-eslint recommended.
- Anything that talks to AWS goes behind an interface (`MicrovmApi`,
  `SetupClients`) so it can be faked in tests.
- Never put real account ids, ARNs or secrets in the repository; the docs use
  the AWS example account `123456789012`.
