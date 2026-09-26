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
```

The tests launch the real sandbox-agent in-process and drive the MCP server
against a fake Lambda control plane, so the whole exec / file / transfer /
suspend / resume / destroy path is covered locally.

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
