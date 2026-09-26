# Changelog

## 0.2.1 (unreleased)

- Optional CloudWatch runtime logs: `setup --execution-role` creates a role that
  can only write to CloudWatch Logs; start the server with
  `--execution-role-arn` and read the VM's own log stream with the new
  `sandbox_vm_logs` tool.
- `setup --skip-image` refreshes the bucket and roles without rebuilding.
- Fix: the build role could not write build logs (wrong log group path
  `/aws/lambda/microvms/*`; Lambda uses `/aws/lambda-microvms/<image>`).
  `setup` now also refreshes the policy of roles it created earlier.

## 0.2.0 (2026-09-27)

- `sandbox_exec` gains `background: true`: start servers and other long-running
  processes detached, returning the pid and a log path instead of waiting.
- New `sandbox_port_forward` / `sandbox_port_forward_stop`: a local reverse proxy
  that injects the Lambda auth headers so a web app inside the sandbox opens at
  `http://127.0.0.1:<port>` in your browser (HTTP and WebSocket).
- Image: `npm`, `npx` and `corepack` (yarn / pnpm shims) are on PATH; AL2023's
  `nodejs22-npm` only ships `npm-22`. Run `setup` again to rebuild the image.

## 0.1.1 (2026-09-26)

- Rename the file-deletion tool from `sandbox_delete` to `sandbox_delete_path`
  and spell out in its description that it does not destroy the sandbox, after
  an agent mistook it for an alias of `sandbox_destroy`.
- Release workflow publishes through npm Trusted Publishing (OIDC) with
  provenance; no npm token is stored in GitHub.

## 0.1.0 (2026-09-26)

- First release: MCP server with 13 tools, in-VM sandbox-agent with sudo relay,
  `setup` / `doctor` commands, CloudFormation prerequisites template.
