import {
  chownSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  promises as fsp,
  statSync,
  type Stats,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  LIMITS,
  type DeleteRequest,
  type DeleteResponse,
  type DownloadFinishRequest,
  type DownloadStartRequest,
  type DownloadStartResponse,
  type Encoding,
  type FileEntry,
  type ListFilesRequest,
  type ListFilesResponse,
  type PullRequest,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type ReadFileRequest,
  type ReadFileResponse,
  type UploadFinishRequest,
  type UploadFinishResponse,
  type UploadStartRequest,
  type UploadStartResponse,
  type WriteFileRequest,
  type WriteFileResponse,
} from "./protocol.js";
import type { AgentState } from "./state.js";
import { badRequest, notFound, HttpError } from "./errors.js";
import { runHelper } from "./executor.js";
import { isRoot } from "./users.js";

export function resolvePath(state: AgentState, p: unknown): string {
  if (typeof p !== "string" || p.length === 0) throw badRequest("path is required");
  if (p.includes("\0")) throw badRequest("path contains NUL");
  return path.resolve(state.options.workspace, p);
}

function encodingOf(e: unknown): Encoding {
  if (e === undefined || e === "utf-8" || e === "utf8") return "utf-8";
  if (e === "base64") return "base64";
  throw badRequest(`unsupported encoding: ${String(e)}`);
}

/** When running as root, hand ownership of created paths to the exec user. */
function chownToExecUser(state: AgentState, p: string): void {
  if (!isRoot() || !state.execUser) return;
  try {
    chownSync(p, state.execUser.uid, state.execUser.gid);
  } catch {
    /* best effort */
  }
}

function mkdirsOwned(state: AgentState, dir: string): void {
  const missing: string[] = [];
  let cur = dir;
  while (!existsSync(cur)) {
    missing.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  mkdirSync(dir, { recursive: true });
  for (const d of missing) chownToExecUser(state, d);
}

export async function readFile(state: AgentState, req: ReadFileRequest): Promise<ReadFileResponse> {
  const p = resolvePath(state, req.path);
  const enc = encodingOf(req.encoding);
  const max = Math.min(req.max_bytes ?? LIMITS.jsonBodyBytes, LIMITS.jsonBodyBytes);
  let st: Stats;
  try {
    st = await fsp.stat(p);
  } catch {
    throw notFound(`no such file: ${p}`);
  }
  if (st.isDirectory()) throw badRequest(`is a directory: ${p}`);
  const fd = openSync(p, "r");
  try {
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, off);
      if (n === 0) break;
      off += n;
    }
    const data = buf.subarray(0, off);
    return {
      path: p,
      content: enc === "base64" ? data.toString("base64") : data.toString("utf8"),
      encoding: enc,
      size: st.size,
      truncated: st.size > off,
    };
  } finally {
    closeSync(fd);
  }
}

export async function writeFile(state: AgentState, req: WriteFileRequest): Promise<WriteFileResponse> {
  const p = resolvePath(state, req.path);
  if (typeof req.content !== "string") throw badRequest("content must be a string");
  const enc = encodingOf(req.encoding);
  const data = enc === "base64" ? Buffer.from(req.content, "base64") : Buffer.from(req.content, "utf8");
  const dir = path.dirname(p);
  if (!existsSync(dir)) {
    if (req.mkdirs === false) throw badRequest(`parent directory does not exist: ${dir}`);
    mkdirsOwned(state, dir);
  }
  const existed = existsSync(p);
  await fsp.writeFile(p, data);
  if (!existed) chownToExecUser(state, p);
  if (req.mode !== undefined) {
    if (!/^[0-7]{3,4}$/.test(req.mode)) throw badRequest("mode must be an octal string like 755");
    await fsp.chmod(p, parseInt(req.mode, 8));
  }
  return { path: p, size: data.length };
}

function entryType(st: Stats): FileEntry["type"] {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return "other";
}

export async function listFiles(state: AgentState, req: ListFilesRequest): Promise<ListFilesResponse> {
  const root = resolvePath(state, req.path);
  const max = Math.min(req.max_entries ?? LIMITS.listEntriesDefault, LIMITS.listEntriesMax);
  let st: Stats;
  try {
    st = await fsp.lstat(root);
  } catch {
    throw notFound(`no such path: ${root}`);
  }
  if (!st.isDirectory()) {
    return { path: root, entries: [toEntry(root, root, st)], truncated: false };
  }
  const entries: FileEntry[] = [];
  let truncated = false;
  const queue: string[] = [root];
  while (queue.length > 0 && !truncated) {
    const dir = queue.shift() as string;
    let names: string[];
    try {
      names = (await fsp.readdir(dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!req.include_hidden && name.startsWith(".")) continue;
      const full = path.join(dir, name);
      let est: Stats;
      try {
        est = await fsp.lstat(full);
      } catch {
        continue;
      }
      if (entries.length >= max) {
        truncated = true;
        break;
      }
      entries.push(toEntry(root, full, est));
      if (req.recursive && est.isDirectory()) queue.push(full);
    }
  }
  return { path: root, entries, truncated };
}

function toEntry(root: string, full: string, st: Stats): FileEntry {
  const rel = path.relative(root, full);
  return {
    path: rel === "" ? path.basename(full) : rel,
    type: entryType(st),
    size: st.size,
    mtime: st.mtime.toISOString(),
  };
}

export async function deletePath(state: AgentState, req: DeleteRequest): Promise<DeleteResponse> {
  const p = resolvePath(state, req.path);
  if (p === "/" || p === state.options.workspace) throw badRequest(`refusing to delete ${p}`);
  let st: Stats;
  try {
    st = await fsp.lstat(p);
  } catch {
    return { path: p, deleted: false };
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    if (!req.recursive) throw badRequest(`is a directory (set recursive: true): ${p}`);
    await fsp.rm(p, { recursive: true, force: true });
  } else {
    await fsp.rm(p, { force: true });
  }
  return { path: p, deleted: true };
}

// ---------------------------------------------------------------------------
// Archive transfers
// ---------------------------------------------------------------------------

interface Transfer {
  id: string;
  file: string;
  kind: "upload" | "download";
  dest?: string;
  size: number;
  createdAt: number;
}

const transfers = new Map<string, Transfer>();
const TRANSFER_TTL_MS = 30 * 60 * 1000;

function ensureTransferDir(state: AgentState): string {
  const dir = state.options.transferDir;
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

function getTransfer(id: unknown, kind: Transfer["kind"]): Transfer {
  if (typeof id !== "string") throw badRequest("transfer_id is required");
  const t = transfers.get(id);
  if (!t || t.kind !== kind) throw notFound(`unknown transfer: ${id}`);
  return t;
}

export function sweepTransfers(): void {
  const now = Date.now();
  for (const t of transfers.values()) {
    if (now - t.createdAt > TRANSFER_TTL_MS) void discardTransfer(t);
  }
}

async function discardTransfer(t: Transfer): Promise<void> {
  transfers.delete(t.id);
  await fsp.rm(t.file, { force: true });
}

function validateExcludes(ex: unknown): string[] {
  if (ex === undefined) return [];
  if (!Array.isArray(ex) || !ex.every((e) => typeof e === "string")) throw badRequest("exclude must be string[]");
  return ex as string[];
}

/** Create `dest` (owned by the exec user) and extract a tar.gz into it as the exec user. */
async function extractArchive(state: AgentState, archive: string, dest: string): Promise<void> {
  mkdirsOwned(state, dest);
  await fsp.chmod(archive, 0o644);
  const res = await runHelper(state, ["tar", "-xzf", archive, "-C", dest], { cwd: dest });
  if (res.code !== 0) throw new HttpError(500, "extract_failed", `tar exited ${res.code}: ${res.stderr.trim()}`);
}

/** Create a tar.gz of `src` (contents of the directory, or a single file) into `out`. */
async function createArchive(state: AgentState, src: string, out: string, exclude: string[]): Promise<void> {
  let st: Stats;
  try {
    st = await fsp.stat(src);
  } catch {
    throw notFound(`no such path: ${src}`);
  }
  const args = ["tar", "-czf", out];
  for (const e of exclude) args.push(`--exclude=${e}`);
  if (st.isDirectory()) args.push("-C", src, ".");
  else args.push("-C", path.dirname(src), path.basename(src));
  // Archive creation runs as the agent (root) so it can read anything the user asks for.
  const res = await runHelper(state, args, { cwd: state.options.workspace, asRoot: true });
  if (res.code !== 0) throw new HttpError(500, "archive_failed", `tar exited ${res.code}: ${res.stderr.trim()}`);
}

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function uploadStart(state: AgentState, req: UploadStartRequest): Promise<UploadStartResponse> {
  const dest = resolvePath(state, req.dest);
  const dir = ensureTransferDir(state);
  const id = randomUUID();
  const file = path.join(dir, `${id}.tar.gz`);
  await fsp.writeFile(file, Buffer.alloc(0));
  transfers.set(id, { id, file, kind: "upload", dest, size: 0, createdAt: Date.now() });
  return { transfer_id: id };
}

export async function uploadChunk(transferId: unknown, offset: unknown, body: Buffer): Promise<{ transfer_id: string; received: number }> {
  const t = getTransfer(transferId, "upload");
  const off = Number(offset);
  if (!Number.isInteger(off) || off !== t.size) {
    throw badRequest(`offset ${String(offset)} does not match received bytes ${t.size}`);
  }
  if (body.length > LIMITS.chunkBytes) throw badRequest(`chunk exceeds ${LIMITS.chunkBytes} bytes`);
  await fsp.appendFile(t.file, body);
  t.size += body.length;
  return { transfer_id: t.id, received: t.size };
}

export async function uploadFinish(state: AgentState, req: UploadFinishRequest): Promise<UploadFinishResponse> {
  const t = getTransfer(req.transfer_id, "upload");
  try {
    if (req.sha256) {
      const actual = await sha256File(t.file);
      if (actual !== req.sha256) throw badRequest(`sha256 mismatch: expected ${req.sha256}, got ${actual}`);
    }
    await extractArchive(state, t.file, t.dest as string);
    return { dest: t.dest as string, bytes: t.size };
  } finally {
    await discardTransfer(t);
  }
}

export async function downloadStart(state: AgentState, req: DownloadStartRequest): Promise<DownloadStartResponse> {
  const src = resolvePath(state, req.path);
  const exclude = validateExcludes(req.exclude);
  const dir = ensureTransferDir(state);
  const id = randomUUID();
  const file = path.join(dir, `${id}.tar.gz`);
  await createArchive(state, src, file, exclude);
  const size = statSync(file).size;
  transfers.set(id, { id, file, kind: "download", size, createdAt: Date.now() });
  return { transfer_id: id, size, sha256: await sha256File(file) };
}

export function downloadChunk(transferId: unknown, offset: unknown, length: unknown): { stream: Readable; length: number } {
  const t = getTransfer(transferId, "download");
  const off = Number(offset ?? 0);
  const lenReq = Number(length ?? LIMITS.chunkBytes);
  if (!Number.isInteger(off) || off < 0 || off > t.size) throw badRequest("invalid offset");
  const len = Math.min(Math.max(lenReq, 0), LIMITS.chunkBytes, t.size - off);
  if (len === 0) return { stream: Readable.from([]), length: 0 };
  return { stream: createReadStream(t.file, { start: off, end: off + len - 1 }), length: len };
}

export async function downloadFinish(req: DownloadFinishRequest): Promise<{ transfer_id: string }> {
  const t = getTransfer(req.transfer_id, "download");
  await discardTransfer(t);
  return { transfer_id: t.id };
}

// ---------------------------------------------------------------------------
// Presigned URL relay (optional S3 mode)
// ---------------------------------------------------------------------------

function validateUrl(u: unknown): string {
  if (typeof u !== "string") throw badRequest("url is required");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw badRequest("url is not valid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw badRequest("url must be http(s)");
  return u;
}

export async function pull(state: AgentState, req: PullRequest): Promise<PullResponse> {
  const url = validateUrl(req.url);
  const dest = resolvePath(state, req.dest);
  const dir = ensureTransferDir(state);
  const file = path.join(dir, `${randomUUID()}.tar.gz`);
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new HttpError(502, "pull_failed", `GET ${res.status} from presigned url`);
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(file));
    const bytes = statSync(file).size;
    await extractArchive(state, file, dest);
    return { dest, bytes };
  } finally {
    await fsp.rm(file, { force: true });
  }
}

export async function push(state: AgentState, req: PushRequest): Promise<PushResponse> {
  const url = validateUrl(req.url);
  const src = resolvePath(state, req.src);
  const exclude = validateExcludes(req.exclude);
  const dir = ensureTransferDir(state);
  const file = path.join(dir, `${randomUUID()}.tar.gz`);
  try {
    await createArchive(state, src, file, exclude);
    const bytes = statSync(file).size;
    const body = await fsp.readFile(file);
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/gzip", "content-length": String(bytes) },
      body,
    });
    if (!res.ok) throw new HttpError(502, "push_failed", `PUT ${res.status} to presigned url`);
    return { src, bytes };
  } finally {
    await fsp.rm(file, { force: true });
  }
}
