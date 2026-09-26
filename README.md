# lambda-microvm-sandbox-mcp

Isolated sandboxes for AI coding agents on **AWS Lambda MicroVMs**, exposed as
an MCP server you can start with `npx lambda-microvm-sandbox-mcp`.

- [`packages/mcp-server`](packages/mcp-server) – the MCP server (published to npm). See its README for agent configuration and the tool list.
- [`packages/sandbox-agent`](packages/sandbox-agent) – the HTTP agent baked into the MicroVM image (exec / file API on 8080, Lambda lifecycle hooks on 9000) and its `Dockerfile`.
- [`scripts/build-image.ts`](scripts/build-image.ts) – bundles the agent, uploads the zip to S3 and creates/updates the MicroVM image.
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

## Building the image

```bash
export AWS_REGION=ap-northeast-1
export SANDBOX_ARTIFACT_BUCKET=<bucket in the same region>
export SANDBOX_BUILD_ROLE_ARN=arn:aws:iam::<account>:role/MicrovmBuildRole

npm run build-image -- --dry-run   # show the zip and parameters, no AWS calls
npm run build-image -- --yes       # upload, create/update the image, wait for ACTIVE
```

Image snapshots are billed for storage (minimum one week), so the script never
calls AWS without `--yes`. `--prune-versions N --yes` deletes all but the newest
`N` versions.

## Trying it end to end

```bash
export SANDBOX_IMAGE_ARN=arn:aws:lambda:ap-northeast-1:<account>:microvm-image:sandbox-agent
npm run smoke-test -- --yes        # starts one VM (~$0.13/h at 2 GB), exercises it, terminates it
```
