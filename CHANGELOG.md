# Changelog

## 0.1.1 (2026-09-26)

- Rename the file-deletion tool from `sandbox_delete` to `sandbox_delete_path`
  and spell out in its description that it does not destroy the sandbox, after
  an agent mistook it for an alias of `sandbox_destroy`.
- Release workflow publishes through npm Trusted Publishing (OIDC) with
  provenance; no npm token is stored in GitHub.

## 0.1.0 (2026-09-26)

- First release: MCP server with 13 tools, in-VM sandbox-agent with sudo relay,
  `setup` / `doctor` commands, CloudFormation prerequisites template.
