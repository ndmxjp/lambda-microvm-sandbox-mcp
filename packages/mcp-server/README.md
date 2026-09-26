# lambda-microvm-sandbox-mcp

MCP server that gives AI coding agents (Kiro, Claude Code, ...) isolated Linux
sandboxes running on **AWS Lambda MicroVMs**. Each sandbox is a fresh Firecracker
VM with git, Python, Node and a C toolchain, reachable only through this server.

```
Kiro / Claude Code ──stdio──▶ lambda-microvm-sandbox-mcp ──AWS SDK──▶ Lambda MicroVMs
                                        │
                                        └──HTTPS + auth token──▶ sandbox-agent inside the VM
```

## Prerequisites

1. A built MicroVM image containing the sandbox-agent (see the repository's
   `npm run build-image`). Note its ARN.
2. AWS credentials on the machine running the MCP server with permission for
   `lambda:RunMicrovm`, `GetMicrovm`, `ListMicrovms`, `SuspendMicrovm`,
   `ResumeMicrovm`, `TerminateMicrovm`, `CreateMicrovmAuthToken`,
   `GetMicrovmImage`, plus `lambda:PassNetworkConnector` for the managed
   connectors. Credentials never enter the VM.

## Configure your agent

Claude Code (`~/.claude.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "lambda-sandbox": {
      "command": "npx",
      "args": ["-y", "lambda-microvm-sandbox-mcp", "--image-arn", "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:sandbox-agent"],
      "env": { "AWS_PROFILE": "default" }
    }
  }
}
```

Kiro (`.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "lambda-sandbox": {
      "command": "npx",
      "args": ["-y", "lambda-microvm-sandbox-mcp"],
      "env": {
        "SANDBOX_IMAGE_ARN": "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:sandbox-agent",
        "AWS_PROFILE": "default"
      },
      "autoApprove": ["sandbox_exec", "sandbox_read_file", "sandbox_list_files", "sandbox_status", "sandbox_list"]
    }
  }
}
```

Run `npx lambda-microvm-sandbox-mcp --help` for every option. All options have
an environment-variable twin (`SANDBOX_IMAGE_ARN`, `SANDBOX_MAX_DURATION_S`,
`SANDBOX_IDLE_S`, `SANDBOX_SUSPENDED_S`, `SANDBOX_INTERNET_EGRESS`,
`SANDBOX_TRANSFER_BUCKET`, `SANDBOX_STATE_FILE`, `SANDBOX_TOKEN_TTL_MIN`).

## Tools

| Tool | Purpose |
|---|---|
| `sandbox_create` | Start a VM and wait until it accepts commands. Returns `sandbox_id`. |
| `sandbox_exec` | Run a bash command (`cwd`, `timeout_s`, `env`, `stdin`, `as_root`). |
| `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_files` / `sandbox_delete` | File operations. Paths are absolute or relative to `/workspace`. |
| `sandbox_upload_dir` / `sandbox_download` | Move directories in and out as tar.gz, chunked over the VM endpoint (or via S3 when `--transfer-bucket` is set). |
| `sandbox_suspend` / `sandbox_resume` | Pause compute billing while keeping state. Suspended VMs auto-resume on the next call. |
| `sandbox_status` / `sandbox_list` | State and `stateReason`; terminated VMs are reported once and forgotten. |
| `sandbox_destroy` | Terminate the VM. |

## Behaviour worth knowing

- Commands run as user `sandbox`; the agent process is root so a stray `pkill`
  cannot take the control plane down. `sudo` works without a password but is a
  shim: the container runs with `no_new_privileges`, so the shim forwards the
  command to the root agent over a group-restricted unix socket. It is
  non-interactive (`sudo cmd`, `sudo -s` with a script on stdin, `-E`, `-n`,
  `-u root`). `as_root: true` on `sandbox_exec` does the same without the shim.
- A per-VM secret is generated at `sandbox_create`, delivered to the VM through
  the `/run` lifecycle hook, and required on every request in addition to the
  Lambda auth token. Tokens are refreshed automatically before expiry.
- Sandboxes live at most `--max-duration` seconds (default 4 h, hard cap 8 h)
  and are suspended after `--idle` seconds without traffic. The first call after
  a suspend can take a few seconds while the VM resumes.
- Known sandboxes are stored in `~/.lambda-sandbox/sandboxes.json` (mode 0600)
  so a restarted server can reconnect to running VMs.
- The image is based on `al2023-minimal`, so `dnf` is really `microdnf`
  (`sudo dnf install -y <pkg>` works, `-q` and some other flags do not) and the
  default `python3` is 3.9.
- The VM has **no** IAM execution role. Anything that needs AWS access must go
  through your agent, not the sandbox.
