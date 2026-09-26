# lambda-microvm-sandbox-mcp

[![CI](https://github.com/ndmxjp/lambda-microvm-sandbox-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ndmxjp/lambda-microvm-sandbox-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/lambda-microvm-sandbox-mcp)](https://www.npmjs.com/package/lambda-microvm-sandbox-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Give your AI coding agent a **disposable Linux machine** instead of your laptop.

`lambda-microvm-sandbox-mcp` is an [MCP](https://modelcontextprotocol.io) server
that lets Claude Code, Kiro and other MCP clients create isolated sandboxes on
**AWS Lambda MicroVMs**, run commands in them, move files in and out, and throw
them away. Each sandbox is a fresh Firecracker VM in your own AWS account with
git, Python, Node.js and a C toolchain preinstalled, and it boots in about two
seconds.

[日本語版 README](README.ja.md)

## Why

- **Real isolation.** Commands run in a Firecracker VM, not in a container on your
  machine. A `rm -rf` or a malicious `npm install` cannot touch your files or
  your credentials: the VM has no IAM role and only reaches the internet.
- **Fast and cheap.** A sandbox is ready in ~2 s, suspends automatically while
  the agent is thinking (no compute charges), resumes in ~1 s on the next
  call, and is destroyed after at most 8 hours. A 2 GB sandbox costs about
  $0.13 per hour while running.
- **Nothing to host.** No servers, clusters or daemons. One `setup` command
  builds the VM image in your account; the MCP server runs locally via `npx`.
- **Made for agents.** Tools return structured results, long commands time out
  cleanly, output is capped, and the agent is told exactly what to do when
  something is missing.

## How it works

```
Claude Code / Kiro ──stdio──▶ lambda-microvm-sandbox-mcp (npx, on your machine)
                                  │  AWS SDK: RunMicrovm, tokens, suspend/resume/terminate
                                  ▼
                              AWS Lambda MicroVMs
                                  │  HTTPS + per-VM auth token + per-VM secret
                                  ▼
                              Firecracker VM (Amazon Linux 2023)
                                  └─ sandbox-agent: exec / files API, lifecycle hooks, sudo relay
```

The MCP server is the only thing that holds AWS credentials. It starts VMs from
an image you built once, mints short-lived tokens, and talks to a small agent
inside each VM. Commands run as an unprivileged `sandbox` user with passwordless
`sudo`, so agents can `sudo dnf install` what they need without being able to
kill the agent that controls the VM.

## Quick start

**1. Build the sandbox image in your AWS account** (once, about three minutes).
MicroVM images cannot be shared between accounts, so `setup` creates a private
S3 bucket, a least-privilege build role and the image from assets shipped in
the npm package. It shows the plan and asks before creating anything.

```bash
npx lambda-microvm-sandbox-mcp setup --region ap-northeast-1
npx lambda-microvm-sandbox-mcp doctor --region ap-northeast-1   # verify
```

Prefer infrastructure as code? Deploy
[`cloudformation/prerequisites.yaml`](packages/mcp-server/cloudformation/prerequisites.yaml)
and pass its outputs: `setup --bucket <name> --build-role-arn <arn>`.

**2. Register the server with your agent.**

Claude Code (`.mcp.json` in your project):

```json
{
  "mcpServers": {
    "lambda-sandbox": {
      "command": "npx",
      "args": ["-y", "lambda-microvm-sandbox-mcp", "--region", "ap-northeast-1"]
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
      "env": { "AWS_REGION": "ap-northeast-1" },
      "autoApprove": ["sandbox_exec", "sandbox_read_file", "sandbox_list_files", "sandbox_status", "sandbox_list"]
    }
  }
}
```

The server uses your normal AWS credential chain (`AWS_PROFILE`, SSO, env vars).

**3. Ask your agent to use it.**

> Create a sandbox, upload this project into it, run the test suite there and
> report the failures. Destroy the sandbox when you are done.

The agent will call `sandbox_create`, `sandbox_upload_dir`, `sandbox_exec`,
read what it needs, and finish with `sandbox_destroy`.

## Tools

| Tool | What it does |
|---|---|
| `sandbox_create` | Start a VM and wait until it accepts commands. Returns `sandbox_id`. |
| `sandbox_exec` | Run a bash command with `cwd`, `timeout_s`, `env`, `stdin`, `as_root`. Returns exit code, stdout, stderr. `background=true` starts a detached process (servers) and returns its pid and log file. |
| `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_files` / `sandbox_delete_path` | File operations, absolute or relative to `/workspace`. |
| `sandbox_upload_dir` / `sandbox_download` | Move directories in and out as tar.gz (`.git`, `node_modules`, … excluded by default). |
| `sandbox_port_forward` / `sandbox_port_forward_stop` | Expose a port inside the sandbox as `http://127.0.0.1:<port>` on your machine (HTTP and WebSocket), so a dev server or web app running in the sandbox opens in your browser. Start the app with `sandbox_exec` `background=true`. |
| `sandbox_suspend` / `sandbox_resume` | Pause compute billing while keeping state; suspended VMs auto-resume on the next call. |
| `sandbox_status` / `sandbox_list` | State and reason; VMs that Lambda already terminated are reported once. |
| `sandbox_vm_logs` | Tail the VM's CloudWatch logs (optional, needs `--execution-role-arn`). |
| `sandbox_destroy` | Terminate the VM. |

Every option of the server has a flag and an environment variable; run
`npx lambda-microvm-sandbox-mcp --help`. The full reference lives in
[`packages/mcp-server/README.md`](packages/mcp-server/README.md).

## Cost and limits

| | |
|---|---|
| Running sandbox (2 GB / 1 vCPU, ARM) | ≈ $0.13 per hour, billed per second |
| Suspended sandbox | no compute charge |
| Image snapshot storage | ≈ $0.08 per GB-month, minimum one week |
| Sandbox lifetime | `--max-duration`, default 4 h, hard cap 8 h |
| Auto-suspend | after `--idle` seconds (default 600) without traffic |
| Bandwidth to a 2 GB sandbox | about 4 MB/s, so keep uploads small |

The agent is reminded in every tool description to destroy sandboxes it no
longer needs. `sandbox_list` shows anything still running.

## Security model

- The VM has **no IAM execution role** by default. Your AWS credentials stay on
  your machine; the sandbox can only reach the public internet (or nothing, with
  `--no-internet-egress`). Opt in to a CloudWatch-Logs-only role
  (`setup --execution-role`, then `--execution-role-arn`) when you want the VM's
  own logs.
- Every request to a VM carries a Lambda-issued token that is valid for one VM
  and one port, plus a per-VM secret generated at creation and delivered
  through the `/run` lifecycle hook. Neither is ever written into the image.
- Commands run as user `sandbox`. `sudo` works, but as a shim that relays to
  the root agent over a group-restricted unix socket, because the container runs
  with `no_new_privileges`. `as_root: true` on `sandbox_exec` does the same.
- Known sandboxes are stored in `~/.lambda-sandbox/sandboxes.json` (mode 0600).
- The image is Amazon Linux 2023 minimal, so `dnf` is really `microdnf` and the
  default `python3` is 3.9. Add what you need with `sudo dnf install -y …`.

## Repository layout

- [`packages/mcp-server`](packages/mcp-server) – the npm package: MCP server, `setup`, `doctor`, CloudFormation template.
- [`packages/sandbox-agent`](packages/sandbox-agent) – the agent baked into the VM image and its `Dockerfile`.
- [`docs/`](docs) – research notes and the implementation log.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, tests, CI and releases.

## License

[MIT](LICENSE)
