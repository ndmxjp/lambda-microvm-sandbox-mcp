import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chownSync, mkdirSync, openSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { LIMITS, type BackgroundExecResponse, type ExecRequest, type ExecResponse } from "./protocol.js";
import type { AgentState } from "./state.js";
import { badRequest } from "./errors.js";
import { isRoot } from "./users.js";

const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * PATH for child processes. Inside the image this is the fixed system PATH plus
 * the directory of the running node binary. When the agent is not root (local
 * development) the agent's own PATH is appended so dev-machine tools resolve.
 */
function basePath(): string {
  const parts = BASE_PATH.split(":");
  const nodeDir = path.dirname(process.execPath);
  if (!parts.includes(nodeDir)) parts.unshift(nodeDir);
  if (!isRoot() && process.env.PATH) {
    for (const p of process.env.PATH.split(":")) if (p && !parts.includes(p)) parts.push(p);
  }
  return parts.join(":");
}

export interface SpawnAsOptions {
  cwd: string;
  env?: Record<string, string>;
  asRoot?: boolean;
  stdio?: SpawnOptions["stdio"];
}

/**
 * Build spawn options that run the child as the configured exec user when the
 * agent itself is root. When the agent is not root (local tests, docker run
 * without --user) the child simply inherits the current user.
 */
export function spawnOptionsFor(state: AgentState, opts: SpawnAsOptions): SpawnOptions {
  const user = state.execUser;
  const switchUser = isRoot() && user !== null && !opts.asRoot;
  const home = switchUser ? user.home : (process.env.HOME ?? "/root");
  const userName = switchUser ? user.name : (process.env.USER ?? (isRoot() ? "root" : "unknown"));
  const env: Record<string, string> = {
    PATH: basePath(),
    HOME: home,
    USER: userName,
    LOGNAME: userName,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    CI: "true",
    ...state.runEnv,
    ...(opts.env ?? {}),
  };
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env,
    detached: true,
    stdio: opts.stdio ?? ["pipe", "pipe", "pipe"],
  };
  if (switchUser) {
    spawnOpts.uid = user.uid;
    spawnOpts.gid = user.gid;
  }
  return spawnOpts;
}

/** Collects up to `cap` bytes from a stream and remembers whether it overflowed. */
class CappedBuffer {
  private chunks: Buffer[] = [];
  private length = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.length >= this.cap) {
      this.truncated = true;
      return;
    }
    const room = this.cap - this.length;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.length += room;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function resolveCwd(state: AgentState, cwd: string | undefined): string {
  const resolved = path.resolve(state.options.workspace, cwd ?? ".");
  try {
    if (!statSync(resolved).isDirectory()) throw badRequest(`cwd is not a directory: ${resolved}`);
  } catch (err) {
    if (err instanceof Error && err.name === "HttpError") throw err;
    throw badRequest(`cwd does not exist: ${resolved}`);
  }
  return resolved;
}

export async function runCommand(state: AgentState, req: ExecRequest): Promise<ExecResponse | BackgroundExecResponse> {
  if (typeof req.command !== "string" || req.command.length === 0) throw badRequest("command is required");
  if (req.background === true) return startBackground(state, req);
  return runProcess(state, ["bash", "-c", req.command], req);
}

/**
 * Start a long-running command (dev server, watcher) in its own session with
 * stdout/stderr appended to a log file the agent can read later. The process is
 * not tracked as "running" so suspend does not wait for it; terminate still
 * signals it.
 */
export function startBackground(state: AgentState, req: ExecRequest): BackgroundExecResponse {
  const cwd = resolveCwd(state, req.cwd);
  const logDir = path.join(state.options.transferDir, "..", "jobs");
  mkdirSync(logDir, { recursive: true, mode: 0o755 });
  const logPath = path.join(logDir, `${randomUUID()}.log`);
  const fd = openSync(logPath, "a", 0o644);
  if (isRoot() && state.execUser && !req.as_root) {
    try {
      chownSync(logPath, state.execUser.uid, state.execUser.gid);
    } catch {
      /* best effort */
    }
  }
  const opts = spawnOptionsFor(state, {
    cwd,
    ...(req.env ? { env: req.env } : {}),
    asRoot: req.as_root === true,
    stdio: ["ignore", fd, fd],
  });
  const child = spawn("bash", ["-c", req.command], opts);
  if (child.pid === undefined) throw new Error("failed to start background command");
  state.background.add(child);
  child.on("exit", () => state.background.delete(child));
  child.on("error", () => state.background.delete(child));
  child.unref();
  return { background: true, pid: child.pid, log_path: logPath, command: req.command };
}

export interface ProcessRequest {
  cwd?: string;
  timeout_s?: number;
  env?: Record<string, string>;
  stdin?: string | Buffer;
  as_root?: boolean;
}

export async function runProcess(state: AgentState, argv: string[], req: ProcessRequest): Promise<ExecResponse> {
  const [cmd, ...args] = argv;
  if (!cmd) throw badRequest("argv is empty");
  const timeoutS = Math.min(Math.max(req.timeout_s ?? LIMITS.execTimeoutDefaultS, 1), LIMITS.execTimeoutMaxS);
  const cwd = resolveCwd(state, req.cwd);
  const started = Date.now();
  const child = spawn(cmd, args, spawnOptionsFor(state, { cwd, ...(req.env ? { env: req.env } : {}), asRoot: req.as_root === true }));
  state.running.add(child);

  const stdout = new CappedBuffer(LIMITS.outputBytes);
  const stderr = new CappedBuffer(LIMITS.outputBytes);
  child.stdout?.on("data", (c: Buffer) => stdout.push(c));
  child.stderr?.on("data", (c: Buffer) => stderr.push(c));

  if (child.stdin) {
    child.stdin.on("error", () => {
      /* child may exit before reading stdin */
    });
    if (req.stdin !== undefined) child.stdin.write(req.stdin);
    child.stdin.end();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child, "SIGKILL");
  }, timeoutS * 1000);

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    state.running.delete(child);
  });

  return {
    exit_code: result.code,
    signal: result.signal,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    duration_ms: Date.now() - started,
    timed_out: timedOut,
    truncated: stdout.truncated || stderr.truncated,
  };
}

/** Run a helper process (tar etc.) as the exec user and wait for it. */
export async function runHelper(
  state: AgentState,
  argv: string[],
  opts: SpawnAsOptions & { input?: NodeJS.ReadableStream },
): Promise<{ code: number | null; stderr: string }> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("empty argv");
  const child = spawn(cmd, args, spawnOptionsFor(state, { ...opts, stdio: ["pipe", "ignore", "pipe"] }));
  state.running.add(child);
  const stderr = new CappedBuffer(64 * 1024);
  child.stderr?.on("data", (c: Buffer) => stderr.push(c));
  if (opts.input && child.stdin) opts.input.pipe(child.stdin);
  else child.stdin?.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c));
  }).finally(() => state.running.delete(child));
  return { code, stderr: stderr.toString() };
}

/** Best-effort: wait for running commands to finish, up to `ms`. */
export async function drainRunning(state: AgentState, ms: number): Promise<number> {
  const deadline = Date.now() + ms;
  while (state.running.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return state.running.size;
}

export function killRunning(state: AgentState, signal: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const child of state.running) {
    killGroup(child, signal);
    n++;
  }
  for (const child of state.background) {
    killGroup(child, signal);
    n++;
  }
  return n;
}
