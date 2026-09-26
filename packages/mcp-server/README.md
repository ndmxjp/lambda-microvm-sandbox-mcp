# lambda-microvm-sandbox-mcp

MCP server that gives AI coding agents (Kiro, Claude Code, ...) isolated Linux
sandboxes running on **AWS Lambda MicroVMs**. Each sandbox is a fresh Firecracker
VM with git, Python, Node and a C toolchain, reachable only through this server.

```
Kiro / Claude Code ──stdio──▶ lambda-microvm-sandbox-mcp ──AWS SDK──▶ Lambda MicroVMs
                                        │
                                        └──HTTPS + auth token──▶ sandbox-agent inside the VM
```

## Quick start

MicroVM images cannot be shared between AWS accounts, so each account builds
its own once. The Dockerfile and agent are inside this package; `setup` does
the rest (S3 bucket, build role, image build, about three minutes):

```bash
# 1. AWS credentials must be available (profile, SSO, env vars).
npx lambda-microvm-sandbox-mcp setup --region ap-northeast-1
# 2. Check everything the server needs.
npx lambda-microvm-sandbox-mcp doctor --region ap-northeast-1
```

`setup` prints what it will create and asks before doing it (`--dry-run` to
only look, `--yes` to skip the question). Run it again after upgrading the
package to build a new image version. If your organisation manages
infrastructure as code, deploy `cloudformation/prerequisites.yaml` instead and
pass its outputs: `setup --bucket <name> --build-role-arn <arn>`.

Permissions: `setup` needs to create an S3 bucket, an IAM role and a MicroVM
image. The server itself needs `lambda:RunMicrovm`, `GetMicrovm`,
`ListMicrovms`, `SuspendMicrovm`, `ResumeMicrovm`, `TerminateMicrovm`,
`CreateMicrovmAuthToken`, `GetMicrovmImage`, `lambda:PassNetworkConnector` and
`sts:GetCallerIdentity`. Credentials never enter the VM.

## Configure your agent

Claude Code (`.mcp.json` in the project, or `~/.claude.json`):

```json
{
  "mcpServers": {
    "lambda-sandbox": {
      "command": "npx",
      "args": ["-y", "lambda-microvm-sandbox-mcp", "--region", "ap-northeast-1"],
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
      "env": { "AWS_REGION": "ap-northeast-1", "AWS_PROFILE": "default" },
      "autoApprove": ["sandbox_exec", "sandbox_read_file", "sandbox_list_files", "sandbox_status", "sandbox_list"]
    }
  }
}
```

The image is found by name (`sandbox-agent` in your account and region). Use
`--image-name` if you built it under another name, or `--image-arn` to point at
a specific ARN. Run `npx lambda-microvm-sandbox-mcp --help` for every option;
all have environment-variable twins (`SANDBOX_IMAGE_NAME`, `SANDBOX_IMAGE_ARN`,
`SANDBOX_MAX_DURATION_S`, `SANDBOX_IDLE_S`, `SANDBOX_SUSPENDED_S`,
`SANDBOX_INTERNET_EGRESS`, `SANDBOX_TRANSFER_BUCKET`, `SANDBOX_STATE_FILE`,
`SANDBOX_TOKEN_TTL_MIN`).

## Tools

| Tool | Purpose |
|---|---|
| `sandbox_create` | Start a VM and wait until it accepts commands. Returns `sandbox_id`. |
| `sandbox_exec` | Run a bash command (`cwd`, `timeout_s`, `env`, `stdin`, `as_root`); `background=true` for servers. |
| `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_files` / `sandbox_delete_path` | File operations. Paths are absolute or relative to `/workspace`. |
| `sandbox_upload_dir` / `sandbox_download` | Move directories in and out as tar.gz, chunked over the VM endpoint (or via S3 when `--transfer-bucket` is set). |
| `sandbox_port_forward` / `sandbox_port_forward_stop` | Expose a port inside the sandbox as `http://127.0.0.1:<port>` locally (HTTP + WebSocket). Start the app with `sandbox_exec` `background=true` listening on 0.0.0.0. |
| `sandbox_suspend` / `sandbox_resume` | Pause compute billing while keeping state. Suspended VMs auto-resume on the next call. |
| `sandbox_status` / `sandbox_list` | State and `stateReason`; terminated VMs are reported once and forgotten. |
| `sandbox_vm_logs` | Tail the VM's CloudWatch log stream (agent messages, lifecycle hooks, crashes). Needs `--execution-role-arn`. |
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
- By default the VM has **no** IAM execution role, so anything that needs AWS
  access must go through your agent, not the sandbox. Without a role Lambda also
  does not forward the VM's stdout/stderr anywhere; if you need those logs (for
  example to debug a sandbox that Lambda terminated), run
  `setup --execution-role` once and start the server with
  `--execution-role-arn <arn>`. That role can only write to CloudWatch Logs, and
  `sandbox_vm_logs` then reads the stream.
