import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, promises as fsp, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxClient } from "./client.js";
import { SandboxError } from "./client.js";
import type { TransferStore } from "./aws.js";

export const DEFAULT_EXCLUDES = [".git", "node_modules", ".venv", "__pycache__", ".DS_Store", "._*", "dist", "target"];
const CHUNK_BYTES = 8 * 1024 * 1024;

function runLocal(argv: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    // COPYFILE_DISABLE stops macOS bsdtar from adding AppleDouble "._*" entries.
    const child = spawn(cmd as string, args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new SandboxError(`${cmd} exited ${code}: ${stderr.trim()}`))));
  });
}

export async function createLocalArchive(
  localPath: string,
  excludes: string[],
): Promise<{ file: string; size: number; sha256: string; cleanup(): Promise<void> }> {
  const resolved = path.resolve(localPath);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new SandboxError(`local path does not exist: ${resolved}`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "lambda-sandbox-"));
  const file = path.join(dir, "upload.tar.gz");
  const args = ["tar", "-czf", file];
  for (const e of excludes) args.push(`--exclude=${e}`);
  if (st.isDirectory()) args.push("-C", resolved, ".");
  else args.push("-C", path.dirname(resolved), path.basename(resolved));
  await runLocal(args, resolved.length > 0 && st.isDirectory() ? resolved : path.dirname(resolved));
  const data = await fsp.readFile(file);
  return {
    file,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }),
  };
}

export async function extractLocalArchive(file: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await runLocal(["tar", "-xzf", file, "-C", dest], dest);
}

export interface UploadResult {
  remote_path: string;
  bytes: number;
  mode: "chunked" | "s3";
  chunks?: number;
}

export async function uploadDirectory(
  client: SandboxClient,
  localPath: string,
  remotePath: string,
  excludes: string[],
  store: { s3: TransferStore; prefix: string } | null,
): Promise<UploadResult> {
  const archive = await createLocalArchive(localPath, excludes);
  try {
    if (store) {
      const key = `${store.prefix}${client.record.sandbox_id}/${Date.now()}-upload.tar.gz`;
      const putUrl = await store.s3.presignPut(key, 900);
      const body = await fsp.readFile(archive.file);
      const put = await fetch(putUrl, { method: "PUT", headers: { "content-type": "application/gzip" }, body });
      if (!put.ok) throw new SandboxError(`S3 upload failed: ${put.status}`);
      try {
        const getUrl = await store.s3.presignGet(key, 900);
        const r = await client.request<{ dest: string; bytes: number }>("POST", "/files/pull", { json: { url: getUrl, dest: remotePath } });
        return { remote_path: r.dest, bytes: r.bytes, mode: "s3" };
      } finally {
        await store.s3.deleteObject(key).catch(() => undefined);
      }
    }
    const start = await client.request<{ transfer_id: string }>("POST", "/archive/upload/start", { json: { dest: remotePath } });
    const data = await fsp.readFile(archive.file);
    let chunks = 0;
    for (let off = 0; off < data.length; off += CHUNK_BYTES) {
      const piece = data.subarray(off, Math.min(off + CHUNK_BYTES, data.length));
      await client.request("PUT", "/archive/upload/chunk", {
        query: { transfer_id: start.transfer_id, offset: off },
        body: new Uint8Array(piece),
      });
      chunks++;
    }
    if (data.length === 0) chunks = 0;
    const fin = await client.request<{ dest: string; bytes: number }>("POST", "/archive/upload/finish", {
      json: { transfer_id: start.transfer_id, sha256: archive.sha256 },
    });
    return { remote_path: fin.dest, bytes: fin.bytes, mode: "chunked", chunks };
  } finally {
    await archive.cleanup();
  }
}

export interface DownloadResult {
  local_path: string;
  bytes: number;
  mode: "chunked" | "s3";
}

export async function downloadPath(
  client: SandboxClient,
  remotePath: string,
  localPath: string,
  excludes: string[],
  store: { s3: TransferStore; prefix: string } | null,
): Promise<DownloadResult> {
  const dest = path.resolve(localPath);
  const dir = mkdtempSync(path.join(tmpdir(), "lambda-sandbox-"));
  const file = path.join(dir, "download.tar.gz");
  try {
    if (store) {
      const key = `${store.prefix}${client.record.sandbox_id}/${Date.now()}-download.tar.gz`;
      const putUrl = await store.s3.presignPut(key, 900);
      try {
        const pushed = await client.request<{ bytes: number }>("POST", "/files/push", {
          json: { src: remotePath, url: putUrl, exclude: excludes },
        });
        const getUrl = await store.s3.presignGet(key, 900);
        const res = await fetch(getUrl);
        if (!res.ok) throw new SandboxError(`S3 download failed: ${res.status}`);
        await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
        await extractLocalArchive(file, dest);
        return { local_path: dest, bytes: pushed.bytes, mode: "s3" };
      } finally {
        await store.s3.deleteObject(key).catch(() => undefined);
      }
    }
    const start = await client.request<{ transfer_id: string; size: number; sha256: string }>("POST", "/archive/download/start", {
      json: { path: remotePath, exclude: excludes },
    });
    const parts: Uint8Array[] = [];
    try {
      for (let off = 0; off < start.size; off += CHUNK_BYTES) {
        parts.push(
          await client.requestBytes("GET", "/archive/download/chunk", {
            query: { transfer_id: start.transfer_id, offset: off, length: CHUNK_BYTES },
          }),
        );
      }
    } finally {
      await client.request("POST", "/archive/download/finish", { json: { transfer_id: start.transfer_id } }).catch(() => undefined);
    }
    const data = Buffer.concat(parts);
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== start.sha256) throw new SandboxError(`download corrupted: sha256 ${sha} != ${start.sha256}`);
    await fsp.writeFile(file, data);
    await extractLocalArchive(file, dest);
    return { local_path: dest, bytes: data.length, mode: "chunked" };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
