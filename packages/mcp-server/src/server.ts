import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SandboxService } from "./service.js";
import { SandboxError } from "./client.js";

export const SERVER_NAME = "lambda-microvm-sandbox";
export const SERVER_VERSION = "0.2.0";

function ok(result: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result as Record<string, unknown>,
  };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof SandboxError || err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const sandboxId = z.string().describe("Sandbox id returned by sandbox_create (same as the MicroVM id).");
const encoding = z.enum(["utf-8", "base64"]).optional().describe("Text encoding of `content`. Use base64 for binary files.");

export function createMcpServer(service: SandboxService): McpServer {
  const cfg = service.config;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "Isolated Linux sandboxes on AWS Lambda MicroVMs.",
        "Typical flow: sandbox_create -> sandbox_upload_dir (optional) -> sandbox_exec / file tools -> sandbox_download (optional) -> sandbox_destroy.",
        "To run a web app: start it with sandbox_exec background=true listening on 0.0.0.0, then sandbox_port_forward its port and give the user the returned http://127.0.0.1 URL.",
        `Each sandbox is a fresh Firecracker VM (Amazon Linux 2023, git/python3/node/gcc preinstalled, cwd /workspace, user "sandbox" with passwordless sudo).`,
        "Sandboxes suspend automatically when idle and resume on the next call (the first call after a pause takes roughly 2 extra seconds).",
        `They are destroyed after at most ${Math.round(cfg.maxDurationS / 60)} minutes; copy anything you need out with sandbox_download or sandbox_read_file before that.`,
        "Always call sandbox_destroy when finished: running sandboxes cost money.",
      ].join(" "),
    },
  );

  server.registerTool(
    "sandbox_create",
    {
      title: "Create sandbox",
      description:
        "Start a new isolated sandbox VM and wait until it accepts commands (typically a few seconds). Returns the sandbox_id used by every other tool. Costs money while running; destroy it when done.",
      inputSchema: {
        name: z.string().max(64).optional().describe("Optional label for your own reference."),
        max_duration_s: z
          .number()
          .int()
          .min(60)
          .max(28_800)
          .optional()
          .describe(`Hard lifetime in seconds after which the VM is destroyed (default ${cfg.maxDurationS}, max 28800 = 8h).`),
        internet_egress: z
          .boolean()
          .optional()
          .describe(`Allow outbound internet (package installs, git clone). Default ${cfg.internetEgress}.`),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run(() => service.create(args)),
  );

  server.registerTool(
    "sandbox_exec",
    {
      title: "Run a shell command",
      description:
        "Run a bash command inside the sandbox and return exit code, stdout and stderr (each capped at 1 MiB). Default cwd is /workspace and default user is `sandbox` (use `sudo` or as_root for root). Commands are killed after timeout_s. For servers and other long-running processes pass background=true: the command is started detached and the call returns its pid and a log file path you can read with sandbox_read_file.",
      inputSchema: {
        sandbox_id: sandboxId,
        command: z.string().min(1).describe("Command line passed to `bash -c`."),
        cwd: z.string().optional().describe("Working directory, absolute or relative to /workspace."),
        timeout_s: z.number().int().min(1).max(3600).optional().describe("Timeout in seconds (default 120, max 3600)."),
        env: z.record(z.string()).optional().describe("Extra environment variables."),
        stdin: z.string().optional().describe("Data written to the command's stdin."),
        as_root: z.boolean().optional().describe("Run as root instead of the sandbox user."),
        background: z
          .boolean()
          .optional()
          .describe("Start detached and return immediately with pid and log_path (for servers). Bind servers to 0.0.0.0."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ sandbox_id, ...req }) => run(() => service.exec(sandbox_id, req)),
  );

  server.registerTool(
    "sandbox_port_forward",
    {
      title: "Forward a sandbox port to localhost",
      description:
        "Make a TCP port inside the sandbox reachable from this machine as http://127.0.0.1:<local_port> (HTTP and WebSocket). Use it to open a dev server or web app running in the sandbox in the user's browser. The app must listen on 0.0.0.0 inside the sandbox. Returns the local URL to give the user.",
      inputSchema: {
        sandbox_id: sandboxId,
        remote_port: z.number().int().min(1).max(65535).describe("Port the app listens on inside the sandbox, e.g. 3000."),
        local_port: z.number().int().min(1).max(65535).optional().describe("Local port to listen on; a free port is chosen when omitted."),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ sandbox_id, remote_port, local_port }) => run(() => service.portForward(sandbox_id, remote_port, local_port)),
  );

  server.registerTool(
    "sandbox_port_forward_stop",
    {
      title: "Stop a port forward",
      description: "Stop forwarding one port (or all ports when remote_port is omitted) of a sandbox.",
      inputSchema: {
        sandbox_id: sandboxId,
        remote_port: z.number().int().min(1).max(65535).optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ sandbox_id, remote_port }) => run(() => service.stopPortForward(sandbox_id, remote_port)),
  );

  server.registerTool(
    "sandbox_read_file",
    {
      title: "Read a file",
      description:
        "Read a file from the sandbox. Paths are absolute or relative to /workspace. Large files are truncated at max_bytes (default 16 MiB).",
      inputSchema: {
        sandbox_id: sandboxId,
        path: z.string().min(1),
        encoding,
        max_bytes: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id, ...req }) => run(() => service.readFile(sandbox_id, req)),
  );

  server.registerTool(
    "sandbox_write_file",
    {
      title: "Write a file",
      description: "Create or overwrite a file in the sandbox, creating parent directories. Use encoding=base64 for binary content.",
      inputSchema: {
        sandbox_id: sandboxId,
        path: z.string().min(1),
        content: z.string(),
        encoding,
        mode: z
          .string()
          .regex(/^[0-7]{3,4}$/)
          .optional()
          .describe('Octal permission bits such as "755".'),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ sandbox_id, ...req }) => run(() => service.writeFile(sandbox_id, req)),
  );

  server.registerTool(
    "sandbox_list_files",
    {
      title: "List files",
      description: "List a directory in the sandbox (non-recursive by default, dotfiles hidden unless include_hidden).",
      inputSchema: {
        sandbox_id: sandboxId,
        path: z.string().min(1).default("."),
        recursive: z.boolean().optional(),
        include_hidden: z.boolean().optional(),
        max_entries: z.number().int().min(1).max(20_000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id, ...req }) => run(() => service.listFiles(sandbox_id, req)),
  );

  server.registerTool(
    "sandbox_delete_path",
    {
      title: "Delete a file or directory",
      description:
        "Delete a single file, or a directory with recursive=true, inside the sandbox. This only removes files; use sandbox_destroy to get rid of the sandbox itself.",
      inputSchema: {
        sandbox_id: sandboxId,
        path: z.string().min(1),
        recursive: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ sandbox_id, ...req }) => run(() => service.deletePath(sandbox_id, req)),
  );

  server.registerTool(
    "sandbox_upload_dir",
    {
      title: "Upload a local directory",
      description:
        "Copy a directory (or single file) from the local machine into the sandbox as a tar.gz. By default .git, node_modules, .venv, __pycache__, .DS_Store, ._*, dist and target are excluded; pass exclude=[] to include everything. Bandwidth is limited (a few MB/s), so keep uploads small.",
      inputSchema: {
        sandbox_id: sandboxId,
        local_path: z.string().min(1).describe("Path on the machine running this MCP server."),
        remote_path: z
          .string()
          .min(1)
          .default(".")
          .describe("Destination directory in the sandbox, absolute or relative to /workspace (created if missing)."),
        exclude: z.array(z.string()).optional().describe("tar --exclude patterns."),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ sandbox_id, local_path, remote_path, exclude }) => run(() => service.uploadDir(sandbox_id, local_path, remote_path, exclude)),
  );

  server.registerTool(
    "sandbox_download",
    {
      title: "Download to the local machine",
      description:
        "Copy a directory or file from the sandbox into a local directory (extracted from a tar.gz). Same default excludes as sandbox_upload_dir.",
      inputSchema: {
        sandbox_id: sandboxId,
        remote_path: z.string().min(1).describe("Path in the sandbox, absolute or relative to /workspace."),
        local_path: z.string().min(1).describe("Local destination directory (created if missing)."),
        exclude: z.array(z.string()).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ sandbox_id, remote_path, local_path, exclude }) => run(() => service.download(sandbox_id, remote_path, local_path, exclude)),
  );

  server.registerTool(
    "sandbox_suspend",
    {
      title: "Suspend sandbox",
      description:
        "Suspend the VM now (state kept, no compute charges). It resumes automatically on the next call, or explicitly with sandbox_resume.",
      inputSchema: { sandbox_id: sandboxId },
      annotations: { idempotentHint: true },
    },
    async ({ sandbox_id }) => run(() => service.suspend(sandbox_id)),
  );

  server.registerTool(
    "sandbox_resume",
    {
      title: "Resume sandbox",
      description: "Resume a suspended VM.",
      inputSchema: { sandbox_id: sandboxId },
      annotations: { idempotentHint: true },
    },
    async ({ sandbox_id }) => run(() => service.resume(sandbox_id)),
  );

  server.registerTool(
    "sandbox_destroy",
    {
      title: "Destroy sandbox",
      description: "Terminate the VM and forget it. All files inside are lost; download anything you need first.",
      inputSchema: { sandbox_id: sandboxId },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ sandbox_id }) => run(() => service.destroy(sandbox_id)),
  );

  server.registerTool(
    "sandbox_status",
    {
      title: "Sandbox status",
      description: "Current state (RUNNING, SUSPENDED, ...) and state reason of one sandbox.",
      inputSchema: { sandbox_id: sandboxId },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id }) => run(() => service.status(sandbox_id)),
  );

  server.registerTool(
    "sandbox_vm_logs",
    {
      title: "Read the VM's CloudWatch logs",
      description:
        "Tail the sandbox VM's own log stream in CloudWatch (the in-VM agent's messages, lifecycle hook events, crashes). Only available when the server runs with --execution-role-arn; otherwise explains what to do. For the output of a background command use its log_path with sandbox_read_file instead.",
      inputSchema: {
        sandbox_id: sandboxId,
        limit: z.number().int().min(1).max(1000).optional().describe("Number of most recent events (default 100)."),
        since_minutes: z.number().int().min(1).optional().describe("Only events newer than this many minutes."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sandbox_id, limit, since_minutes }) => run(() => service.vmLogs(sandbox_id, limit, since_minutes)),
  );

  server.registerTool(
    "sandbox_list",
    {
      title: "List sandboxes",
      description:
        "List sandboxes known to this server with their state, plus any MicroVMs in the account it does not manage. Sandboxes that Lambda already terminated are reported once with the reason and then forgotten.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run(() => service.list()),
  );

  return server;
}
