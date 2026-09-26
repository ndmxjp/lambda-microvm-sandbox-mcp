/**
 * Wire protocol shared between the sandbox-agent (inside the MicroVM) and the
 * MCP server (on the developer machine). Keep this file free of runtime code so
 * the MCP server can `import type` it without a runtime dependency.
 */

/** Header carrying the per-VM shared secret delivered through the `/run` hook. */
export const SECRET_HEADER = "x-sandbox-secret";

/** Default ports. */
export const DEFAULT_API_PORT = 8080;
export const DEFAULT_HOOK_PORT = 9000;

/** Prefix Lambda uses for lifecycle hooks. */
export const HOOK_PATH_PREFIX = "/aws/lambda-microvms/runtime/v1";

/** Upper bounds enforced by the agent. */
export const LIMITS = {
  /** Max JSON request body. */
  jsonBodyBytes: 16 * 1024 * 1024,
  /** Max size of one archive chunk. */
  chunkBytes: 8 * 1024 * 1024,
  /** Max captured stdout / stderr per stream. */
  outputBytes: 1024 * 1024,
  /** Default and max exec timeout in seconds. */
  execTimeoutDefaultS: 120,
  execTimeoutMaxS: 3600,
  /** Default and max entries returned by list. */
  listEntriesDefault: 1000,
  listEntriesMax: 20000,
} as const;

/** Payload passed to RunMicrovm as `runHookPayload` (JSON-encoded string). */
export interface RunHookPayload {
  secret: string;
  /** Extra environment variables applied to every exec. */
  env?: Record<string, string>;
}

export interface HealthResponse {
  ok: true;
  /** True once the `/run` hook has delivered the secret. */
  ready: boolean;
  uptime_s: number;
  workspace: string;
  exec_user: string | null;
  version: string;
}

export interface ExecRequest {
  command: string;
  cwd?: string;
  timeout_s?: number;
  env?: Record<string, string>;
  stdin?: string;
  as_root?: boolean;
  /**
   * Start the command detached (own session, output to a log file) and return
   * immediately. For servers and other long-running processes.
   */
  background?: boolean;
}

export interface BackgroundExecResponse {
  background: true;
  pid: number;
  /** Combined stdout+stderr log inside the sandbox. */
  log_path: string;
  command: string;
}

export interface ExecResponse {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
}

export type Encoding = "utf-8" | "base64";

export interface ReadFileRequest {
  path: string;
  encoding?: Encoding;
  max_bytes?: number;
}

export interface ReadFileResponse {
  path: string;
  content: string;
  encoding: Encoding;
  size: number;
  truncated: boolean;
}

export interface WriteFileRequest {
  path: string;
  content: string;
  encoding?: Encoding;
  /** Octal string such as "755". */
  mode?: string;
  mkdirs?: boolean;
}

export interface WriteFileResponse {
  path: string;
  size: number;
}

export interface ListFilesRequest {
  path: string;
  recursive?: boolean;
  max_entries?: number;
  include_hidden?: boolean;
}

export interface FileEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string;
}

export interface ListFilesResponse {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface DeleteRequest {
  path: string;
  recursive?: boolean;
}

export interface DeleteResponse {
  path: string;
  deleted: boolean;
}

/** Pull a tar.gz from a presigned URL and extract it (S3 relay mode). */
export interface PullRequest {
  url: string;
  dest: string;
}

export interface PullResponse {
  dest: string;
  bytes: number;
}

/** Tar a directory and PUT it to a presigned URL (S3 relay mode). */
export interface PushRequest {
  src: string;
  url: string;
  exclude?: string[];
}

export interface PushResponse {
  src: string;
  bytes: number;
}

/** Chunked upload: start -> PUT chunks -> finish. */
export interface UploadStartRequest {
  dest: string;
}

export interface UploadStartResponse {
  transfer_id: string;
}

export interface UploadChunkResponse {
  transfer_id: string;
  received: number;
}

export interface UploadFinishRequest {
  transfer_id: string;
  sha256?: string;
}

export interface UploadFinishResponse {
  dest: string;
  bytes: number;
}

/** Chunked download: start -> GET chunks -> finish. */
export interface DownloadStartRequest {
  path: string;
  exclude?: string[];
}

export interface DownloadStartResponse {
  transfer_id: string;
  size: number;
  sha256: string;
}

export interface DownloadFinishRequest {
  transfer_id: string;
}

export interface ErrorResponse {
  error: string;
  message: string;
}

/** Request sent by the in-VM `sudo` shim over the root relay unix socket (one JSON line). */
export interface RootRelayRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** base64 */
  stdin?: string;
  timeout_s?: number;
}

/** Reply from the root relay (one JSON line). */
export type RootRelayResponse = ExecResponse | ErrorResponse;
