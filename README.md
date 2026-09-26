# lambda-microvm-sandbox-mcp

Isolated sandboxes for AI coding agents on **AWS Lambda MicroVMs**, exposed as
an MCP server you can start with `npx lambda-microvm-sandbox-mcp`.

- [`packages/mcp-server`](packages/mcp-server) – the MCP server (published to npm). See its README for agent configuration and the tool list.
- [`packages/sandbox-agent`](packages/sandbox-agent) – the HTTP agent baked into the MicroVM image (exec / file API on 8080, Lambda lifecycle hooks on 9000) and its `Dockerfile`.
- `npx lambda-microvm-sandbox-mcp setup` – provisions the S3 bucket, build role and MicroVM image in the user's account from the assets shipped in the package (`cloudformation/prerequisites.yaml` for the IaC route).
- [`scripts/smoke-test.ts`](scripts/smoke-test.ts) – end-to-end check against a real MicroVM (billable, needs `--yes`).
- [`docs/research.md`](docs/research.md), [`docs/plan.md`](docs/plan.md) – research notes and the implementation plan.

## Development

```bash
npm install
npm test            # builds both packages, then runs vitest (no AWS access needed)
npm run typecheck
npm run lint        # eslint (typescript-eslint recommended)
npm run format      # prettier --write; CI runs format:check
```

The tests launch the real sandbox-agent in-process and drive the MCP server
against a fake Lambda control plane, so the whole exec / file / transfer /
suspend / resume / destroy path is covered locally.

## CI

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` / test | push to main, pull requests | typecheck, lint, format check, `npm test` on ubuntu (Node 20, 22) and macOS (Node 22); packs the npm tarball and runs it with `npx` over stdio to confirm `tools/list` returns 13 tools |
| `ci.yml` / secrets | same | gitleaks over the full history (`.gitleaks.toml` allowlists the dummy test secrets) |
| `ci.yml` / dockerfile | same | hadolint on the image Dockerfile |
| `ci.yml` / image | push to main, or PRs labelled `image` | builds the Dockerfile for linux/arm64 under QEMU, boots it in Docker and drives `/ready`, `/run`, `/exec`, the sudo shim and `/validate` (`packages/sandbox-agent/image/ci-boot-test.sh`). Verifies the dnf package list without AWS |
| `release.yml` | tag `v*` | test, check the tag matches `packages/mcp-server/package.json`, `npm publish --provenance`, GitHub release. Needs the `NPM_TOKEN` secret |
| `e2e.yml` | manual (`workflow_dispatch`) | `setup` + `doctor` + smoke test against a real MicroVM using an OIDC role from the `AWS_ROLE_ARN` repository variable. Billable, so never automatic |

Dependabot keeps npm dependencies (AWS SDK grouped) and actions up to date weekly.

## Building the image from this checkout

```bash
npm run build
npm run build-image -- --region ap-northeast-1 --dry-run   # plan only, read-only AWS calls
npm run build-image -- --region ap-northeast-1             # bucket + role + image (asks first)
npm run doctor -- --region ap-northeast-1
```

Image snapshots are billed for storage (about $0.08/GB-month, minimum one
week). Old versions can be deleted with
`aws lambda-microvms delete-microvm-image-version`.

## Trying it end to end

```bash
npm run smoke-test -- --yes --region ap-northeast-1   # one VM (~$0.13/h at 2 GB), exercised then terminated
```

`.mcp.json` in this repository points Claude Code at the local build.
