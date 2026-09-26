import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ExecResponse,
  ErrorResponse,
  HealthResponse,
  ListFilesResponse,
  ReadFileResponse,
  WriteFileResponse,
  DownloadStartResponse,
  UploadStartResponse,
  UploadFinishResponse,
  DeleteResponse,
} from "../src/protocol.js";
import { launchAgent, TEST_SECRET, type TestAgent } from "./helpers.js";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("startup and authentication", () => {
  let t: TestAgent;
  beforeAll(async () => {
    t = await launchAgent();
  });
  afterAll(() => t.close());

  it("serves /health without a secret and reports not ready before /run", async () => {
    const res = await fetch(`${t.api}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(false);
    expect(body.workspace).toBe(t.workspace);
  });

  it("rejects API calls with 503 before the run hook delivers the secret", async () => {
    const r = await t.call<ErrorResponse>("POST", "/exec", { command: "true" });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("not_ready");
  });

  it("answers /ready with 200 once listening", async () => {
    expect((await t.hook("ready")).status).toBe(200);
  });

  it("rejects a run payload without a secret", async () => {
    const r = await t.hook("run", { microvmId: "x", runHookPayload: JSON.stringify({}) });
    expect(r.status).toBe(400);
  });

  it("accepts the secret from /run and then reports ready", async () => {
    await t.deliverSecret(TEST_SECRET, { SANDBOX_TEST_VAR: "from-run-hook" });
    const body = (await (await fetch(`${t.api}/health`)).json()) as HealthResponse;
    expect(body.ready).toBe(true);
  });

  it("rejects wrong or missing secrets with 401", async () => {
    const wrong = await t.call<ErrorResponse>("POST", "/exec", { command: "true" }, { "x-sandbox-secret": "nope-nope-nope-nope" });
    expect(wrong.status).toBe(401);
    const res = await fetch(`${t.api}/exec`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("exposes env from the run payload to commands", async () => {
    const r = await t.call<ExecResponse>("POST", "/exec", { command: "echo $SANDBOX_TEST_VAR" });
    expect(r.json.stdout.trim()).toBe("from-run-hook");
  });

  it("returns 404 for unknown routes", async () => {
    const r = await t.call<ErrorResponse>("POST", "/nope", {});
    expect(r.status).toBe(404);
  });

  it("answers resume, suspend and terminate hooks", async () => {
    for (const h of ["resume", "suspend", "terminate"]) expect((await t.hook(h)).status, h).toBe(200);
    expect((await t.hook("unknown")).status).toBe(404);
  });
});

describe("exec", () => {
  let t: TestAgent;
  beforeAll(async () => {
    t = await launchAgent();
    await t.deliverSecret();
  });
  afterAll(() => t.close());

  it("runs a command in the workspace and captures streams", async () => {
    const r = await t.call<ExecResponse>("POST", "/exec", { command: "pwd; echo out; echo err 1>&2; exit 3" });
    expect(r.status).toBe(200);
    expect(r.json.exit_code).toBe(3);
    expect(r.json.stdout).toBe(`${t.workspace}\nout\n`);
    expect(r.json.stderr).toBe("err\n");
    expect(r.json.timed_out).toBe(false);
    expect(r.json.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("honours cwd relative to the workspace and env overrides", async () => {
    mkdirSync(path.join(t.workspace, "sub"));
    const r = await t.call<ExecResponse>("POST", "/exec", { command: "basename $PWD; echo $FOO", cwd: "sub", env: { FOO: "bar" } });
    expect(r.json.stdout).toBe("sub\nbar\n");
  });

  it("rejects a missing cwd", async () => {
    const r = await t.call<ErrorResponse>("POST", "/exec", { command: "true", cwd: "does-not-exist" });
    expect(r.status).toBe(400);
  });

  it("feeds stdin", async () => {
    const r = await t.call<ExecResponse>("POST", "/exec", { command: "cat", stdin: "hello stdin" });
    expect(r.json.stdout).toBe("hello stdin");
  });

  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    const r = await t.call<ExecResponse>("POST", "/exec", { command: "sleep 30 & sleep 30; echo done", timeout_s: 1 });
    expect(r.json.timed_out).toBe(true);
    expect(r.json.exit_code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.agent.state.running.size).toBe(0);
  });

  it("truncates oversized output", async () => {
    const r = await t.call<ExecResponse>("POST", "/exec", { command: "head -c 3000000 /dev/zero | tr '\\0' 'a'" });
    expect(r.json.truncated).toBe(true);
    expect(r.json.stdout.length).toBe(1024 * 1024);
    expect(r.json.exit_code).toBe(0);
  });

  it("validates the request", async () => {
    const r = await t.call<ErrorResponse>("POST", "/exec", {});
    expect(r.status).toBe(400);
    const bad = await fetch(`${t.api}/exec`, { method: "POST", headers: { "x-sandbox-secret": TEST_SECRET }, body: "not json" });
    expect(bad.status).toBe(400);
  });
});

describe("files", () => {
  let t: TestAgent;
  beforeAll(async () => {
    t = await launchAgent();
    await t.deliverSecret();
  });
  afterAll(() => t.close());

  it("writes and reads utf-8 text, creating parent directories", async () => {
    const w = await t.call<WriteFileResponse>("POST", "/files/write", { path: "a/b/hello.txt", content: "こんにちは\n" });
    expect(w.status).toBe(200);
    expect(w.json.path).toBe(path.join(t.workspace, "a/b/hello.txt"));
    const r = await t.call<ReadFileResponse>("POST", "/files/read", { path: "a/b/hello.txt" });
    expect(r.json.content).toBe("こんにちは\n");
    expect(r.json.truncated).toBe(false);
  });

  it("round-trips binary via base64 and applies mode", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 253]);
    await t.call("POST", "/files/write", { path: "bin.dat", content: bytes.toString("base64"), encoding: "base64", mode: "600" });
    const r = await t.call<ReadFileResponse>("POST", "/files/read", { path: "bin.dat", encoding: "base64" });
    expect(Buffer.from(r.json.content, "base64")).toEqual(bytes);
    const st = statSync(path.join(t.workspace, "bin.dat"));
    expect(st.size).toBe(6);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("truncates reads with max_bytes", async () => {
    await t.call("POST", "/files/write", { path: "big.txt", content: "x".repeat(100) });
    const r = await t.call<ReadFileResponse>("POST", "/files/read", { path: "big.txt", max_bytes: 10 });
    expect(r.json.content).toBe("xxxxxxxxxx");
    expect(r.json.truncated).toBe(true);
    expect(r.json.size).toBe(100);
  });

  it("404s on missing files and 400s on directories", async () => {
    expect((await t.call("POST", "/files/read", { path: "missing" })).status).toBe(404);
    expect((await t.call("POST", "/files/read", { path: "a" })).status).toBe(400);
  });

  it("lists directories, hiding dotfiles unless asked, with recursion and limits", async () => {
    writeFileSync(path.join(t.workspace, ".hidden"), "");
    const flat = await t.call<ListFilesResponse>("POST", "/files/list", { path: "." });
    const names = flat.json.entries.map((e) => e.path);
    expect(names).toContain("a");
    expect(names).not.toContain(".hidden");
    expect(flat.json.entries.find((e) => e.path === "a")?.type).toBe("dir");

    const hidden = await t.call<ListFilesResponse>("POST", "/files/list", { path: ".", include_hidden: true });
    expect(hidden.json.entries.map((e) => e.path)).toContain(".hidden");

    const rec = await t.call<ListFilesResponse>("POST", "/files/list", { path: ".", recursive: true });
    expect(rec.json.entries.map((e) => e.path)).toContain(path.join("a", "b", "hello.txt"));

    const limited = await t.call<ListFilesResponse>("POST", "/files/list", { path: ".", recursive: true, max_entries: 2 });
    expect(limited.json.entries.length).toBe(2);
    expect(limited.json.truncated).toBe(true);
  });

  it("deletes files and directories, refusing the workspace root", async () => {
    const f = await t.call<DeleteResponse>("POST", "/files/delete", { path: "bin.dat" });
    expect(f.json.deleted).toBe(true);
    const dirNoRec = await t.call<ErrorResponse>("POST", "/files/delete", { path: "a" });
    expect(dirNoRec.status).toBe(400);
    const dir = await t.call<DeleteResponse>("POST", "/files/delete", { path: "a", recursive: true });
    expect(dir.json.deleted).toBe(true);
    const gone = await t.call<DeleteResponse>("POST", "/files/delete", { path: "a" });
    expect(gone.json.deleted).toBe(false);
    expect((await t.call("POST", "/files/delete", { path: ".", recursive: true })).status).toBe(400);
  });
});

describe("archive transfers", () => {
  let t: TestAgent;
  beforeAll(async () => {
    t = await launchAgent();
    await t.deliverSecret();
  });
  afterAll(() => t.close());

  async function makeTarGz(dir: string): Promise<Buffer> {
    const r = await t.call<ExecResponse>("POST", "/exec", { command: `tar -czf - -C ${JSON.stringify(dir)} . | base64` });
    expect(r.json.exit_code).toBe(0);
    return Buffer.from(r.json.stdout.replace(/\s/g, ""), "base64");
  }

  it("uploads in chunks and extracts into dest", async () => {
    const srcDir = path.join(t.workspace, "srcproj");
    mkdirSync(path.join(srcDir, "nested"), { recursive: true });
    writeFileSync(path.join(srcDir, "README.md"), "# hi\n");
    writeFileSync(path.join(srcDir, "nested", "data.bin"), Buffer.alloc(300_000, 7));
    const archive = await makeTarGz(srcDir);

    const start = await t.call<UploadStartResponse>("POST", "/archive/upload/start", { dest: "uploaded/proj" });
    expect(start.status).toBe(200);
    const id = start.json.transfer_id;
    const chunk = 64 * 1024;
    for (let off = 0; off < archive.length; off += chunk) {
      const piece = archive.subarray(off, Math.min(off + chunk, archive.length));
      const r = await t.call<{ received: number }>("PUT", `/archive/upload/chunk?transfer_id=${id}&offset=${off}`, new Uint8Array(piece));
      expect(r.status).toBe(200);
      expect(r.json.received).toBe(off + piece.length);
    }
    const badOffset = await t.call<ErrorResponse>("PUT", `/archive/upload/chunk?transfer_id=${id}&offset=0`, new Uint8Array(1));
    expect(badOffset.status).toBe(400);

    const sha256 = createHash("sha256").update(archive).digest("hex");
    const fin = await t.call<UploadFinishResponse>("POST", "/archive/upload/finish", { transfer_id: id, sha256 });
    expect(fin.status).toBe(200);
    expect(fin.json.bytes).toBe(archive.length);
    expect(readFileSync(path.join(t.workspace, "uploaded/proj/README.md"), "utf8")).toBe("# hi\n");
    expect(readFileSync(path.join(t.workspace, "uploaded/proj/nested/data.bin")).length).toBe(300_000);
    expect((await t.call("POST", "/archive/upload/finish", { transfer_id: id })).status).toBe(404);
  });

  it("rejects a sha256 mismatch", async () => {
    const start = await t.call<UploadStartResponse>("POST", "/archive/upload/start", { dest: "bad" });
    await t.call("PUT", `/archive/upload/chunk?transfer_id=${start.json.transfer_id}&offset=0`, new Uint8Array([1, 2, 3]));
    const fin = await t.call<ErrorResponse>("POST", "/archive/upload/finish", { transfer_id: start.json.transfer_id, sha256: "00" });
    expect(fin.status).toBe(400);
  });

  it("downloads a directory in chunks with exclusions", async () => {
    const start = await t.call<DownloadStartResponse>("POST", "/archive/download/start", { path: "srcproj", exclude: ["./nested"] });
    expect(start.status).toBe(200);
    const { transfer_id, size, sha256 } = start.json;
    const parts: Buffer[] = [];
    for (let off = 0; off < size; off += 1000) {
      const res = await fetch(`${t.api}/archive/download/chunk?transfer_id=${transfer_id}&offset=${off}&length=1000`, {
        headers: { "x-sandbox-secret": TEST_SECRET },
      });
      expect(res.status).toBe(200);
      parts.push(Buffer.from(await res.arrayBuffer()));
    }
    const all = Buffer.concat(parts);
    expect(all.length).toBe(size);
    expect(createHash("sha256").update(all).digest("hex")).toBe(sha256);
    // Extract locally through the agent to check content and exclusion.
    const r = await t.call<ExecResponse>("POST", "/exec", {
      command: `mkdir -p out && echo ${JSON.stringify(all.toString("base64"))} | base64 -d | tar -xzf - -C out && find out -type f | sort`,
    });
    expect(r.json.stdout.trim()).toBe("out/README.md");
    expect((await t.call("POST", "/archive/download/finish", { transfer_id })).status).toBe(200);
    expect((await t.call("POST", "/archive/download/finish", { transfer_id })).status).toBe(404);
  });

  it("404s on a missing download path", async () => {
    expect((await t.call("POST", "/archive/download/start", { path: "nope" })).status).toBe(404);
  });
});

describe("presigned url relay", () => {
  let t: TestAgent;
  let relay: Server;
  let relayUrl: string;
  const store = new Map<string, Buffer>();

  beforeAll(async () => {
    t = await launchAgent();
    await t.deliverSecret();
    relay = createServer((req, res) => {
      const key = req.url ?? "/";
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          store.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        });
        return;
      }
      const data = store.get(key);
      if (!data) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-length": data.length }).end(data);
    });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    relay.close();
    await t.close();
  });

  it("pushes a directory to a URL and pulls it back", async () => {
    mkdirSync(path.join(t.workspace, "proj"));
    writeFileSync(path.join(t.workspace, "proj", "f.txt"), "relay");
    const push = await t.call<{ bytes: number }>("POST", "/files/push", { src: "proj", url: `${relayUrl}/obj1` });
    expect(push.status).toBe(200);
    expect(store.get("/obj1")?.length).toBe(push.json.bytes);

    const pull = await t.call<{ bytes: number }>("POST", "/files/pull", { url: `${relayUrl}/obj1`, dest: "restored" });
    expect(pull.status).toBe(200);
    expect(readFileSync(path.join(t.workspace, "restored", "f.txt"), "utf8")).toBe("relay");
  });

  it("reports upstream failures", async () => {
    const pull = await t.call<ErrorResponse>("POST", "/files/pull", { url: `${relayUrl}/missing`, dest: "x" });
    expect(pull.status).toBe(502);
    expect((await t.call("POST", "/files/pull", { url: "ftp://x", dest: "x" })).status).toBe(400);
  });
});

describe("validate hook", () => {
  it("runs the toolchain smoke test", async () => {
    const t = await launchAgent();
    try {
      const r = await t.hook("validate");
      // git/python3/node exist on the dev machine; if not this surfaces the reason.
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe("root relay and sudo shim", () => {
  let t: TestAgent;
  const shim = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "image", "sudo.mjs");
  beforeAll(async () => {
    t = await launchAgent();
    await t.deliverSecret();
  });
  afterAll(() => t.close());

  function relay(req: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const sock = connect(t.rootSocket);
      const chunks: Buffer[] = [];
      sock.on("error", reject);
      sock.on("data", (c: Buffer) => chunks.push(c));
      sock.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(new Error(`relay returned no JSON: ${String(err)}`));
        }
      });
      sock.end(typeof req === "string" ? req : JSON.stringify(req));
    });
  }

  it("runs argv over the socket with cwd, env and stdin", async () => {
    const r = await relay({
      argv: ["bash", "-c", "cat; echo; pwd; echo $X"],
      stdin: Buffer.from("in").toString("base64"),
      env: { X: "y" },
    });
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toBe(`in\n${t.workspace}\ny\n`);
  });

  it("rejects malformed requests", async () => {
    expect((await relay({ argv: [] })).error).toBe("bad_request");
    expect((await relay("not json")).error).toBe("bad_request");
  });

  // The agent runs in this very process, so the shim must be spawned
  // asynchronously: spawnSync would block the event loop the relay needs.
  function runShim(
    args: string[],
    input?: string,
    socket = t.rootSocket,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [shim, ...args], { env: { ...process.env, SANDBOX_ROOT_SOCKET: socket }, cwd: t.workspace });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
  }

  it("works through the sudo shim like a CI runner's sudo", async () => {
    const ok = await runShim(["-n", "bash", "-c", "echo $HOME; exit 4"]);
    expect(ok.stdout).toBe("/root\n");
    expect(ok.status).toBe(4);
    const shell = await runShim(["-s"], "echo from-stdin");
    expect(shell.stdout).toBe("from-stdin\n");
    const piped = await runShim(["tee", path.join(t.workspace, "teed.txt")], "piped");
    expect(piped.stdout).toBe("piped");
    expect(readFileSync(path.join(t.workspace, "teed.txt"), "utf8")).toBe("piped");
    const keep = await runShim(["-E", "bash", "-c", "echo $KEEP_ME"]);
    expect(keep.stdout).toBe("\n");
    const other = await runShim(["-u", "nobody", "true"]);
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(/only -u root/);
    const noSocket = await runShim(["true"], undefined, "/nonexistent.sock");
    expect(noSocket.status).toBe(1);
    expect(noSocket.stderr).toMatch(/cannot reach/);
  });
});

describe("background exec", () => {
  let t: TestAgent;
  beforeAll(async () => {
    t = await launchAgent();
    await t.deliverSecret();
  });
  afterAll(() => t.close());

  it("starts a detached server, returns immediately, and keeps it alive across other calls", async () => {
    const started = Date.now();
    const r = await t.call<{ background: true; pid: number; log_path: string }>("POST", "/exec", {
      command:
        "echo starting; node -e \"require('http').createServer((q,s)=>s.end('served')).listen(process.argv[1],'127.0.0.1',()=>console.log('listening'))\" 0 & wait",
      background: true,
      timeout_s: 1,
    });
    expect(r.status).toBe(200);
    expect(r.json.background).toBe(true);
    expect(r.json.pid).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.agent.state.running.size).toBe(0);
    expect(t.agent.state.background.size).toBe(1);

    // Wait for the log to show it is up; a normal exec with a 1s timeout must not kill it.
    for (let i = 0; i < 50 && !readFileSync(r.json.log_path, "utf8").includes("listening"); i++)
      await new Promise((res) => setTimeout(res, 100));
    expect(readFileSync(r.json.log_path, "utf8")).toContain("starting");
    await t.call("POST", "/exec", { command: "sleep 2", timeout_s: 1 });
    const alive = await t.call<ExecResponse>("POST", "/exec", { command: `kill -0 ${r.json.pid} && echo alive` });
    expect(alive.json.stdout).toBe("alive\n");

    // terminate hook signals background processes
    await t.hook("terminate");
    for (let i = 0; i < 50 && t.agent.state.background.size > 0; i++) await new Promise((res) => setTimeout(res, 100));
    expect(t.agent.state.background.size).toBe(0);
  });
});
