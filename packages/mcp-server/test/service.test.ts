import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULTS, imageArnFor, loadConfig, parseArgs, type Config } from "../src/config.js";
import { Registry } from "../src/registry.js";
import { SandboxService } from "../src/service.js";
import { SandboxClient, TokenManager } from "../src/client.js";
import { createMcpServer } from "../src/server.js";
import { FakeMicrovmApi, FakeTransferStore } from "./fake-aws.js";

const IMAGE_ARN = "arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:sandbox-agent";

const accountId = async (): Promise<string> => "123456789012";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(["--image-arn", IMAGE_ARN], {}),
    readyTimeoutS: 10,
    resumeWaitS: 5,
    ...overrides,
  };
}

let scratch: string;
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-test-")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("config", () => {
  it("parses flags and env with sensible defaults", () => {
    const c = loadConfig(["--image-arn", IMAGE_ARN, "--no-internet-egress", "--idle=30"], { SANDBOX_MAX_DURATION_S: "600" });
    expect(c.region).toBe("ap-northeast-1");
    expect(c.internetEgress).toBe(false);
    expect(c.idleS).toBe(30);
    expect(c.maxDurationS).toBe(600);
    expect(c.suspendedS).toBe(DEFAULTS.suspendedS);
    expect(c.imageVersion).toBeUndefined();
    expect(c.stateFile.endsWith(path.join(".lambda-sandbox", "sandboxes.json"))).toBe(true);
  });

  it("works without an image arn, needing only a region, and rejects bad values", () => {
    expect(() => loadConfig([], {})).toThrow(/region/);
    const byName = loadConfig(["--region", "eu-west-1"], {});
    expect(byName.imageArn).toBeUndefined();
    expect(byName.imageName).toBe("sandbox-agent");
    expect(imageArnFor(byName, "111122223333")).toBe("arn:aws:lambda:eu-west-1:111122223333:microvm-image:sandbox-agent");
    expect(loadConfig([], { SANDBOX_IMAGE_NAME: "x" }, "ap-south-1").region).toBe("ap-south-1");
    expect(loadConfig([], { AWS_REGION: "us-east-2" }, "ap-south-1").region).toBe("us-east-2");
    expect(parseArgs(["--dry-run", "--yes"]).values).toEqual({ "dry-run": true, yes: true });
    expect(() => loadConfig(["--image-arn", IMAGE_ARN, "--token-ttl", "90"], {})).toThrow(/60 minutes/);
    expect(() => loadConfig(["--image-arn", IMAGE_ARN, "--max-duration", "99999"], {})).toThrow(/28800/);
    expect(() => parseArgs(["--image-arn"])).toThrow(/missing value/);
    expect(() => parseArgs(["oops"])).toThrow(/unexpected/);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("takes the region from the image arn unless --region overrides it", () => {
    expect(loadConfig(["--image-arn", IMAGE_ARN, "--region", "us-east-1"], {}).region).toBe("us-east-1");
    expect(loadConfig(["--image-arn", IMAGE_ARN], { AWS_REGION: "eu-west-1" }).region).toBe("ap-northeast-1");
  });
});

describe("registry", () => {
  it("persists records with restrictive permissions and reloads them", () => {
    const file = path.join(scratch, "state", "sandboxes.json");
    const r1 = new Registry(file);
    r1.put({
      sandbox_id: "microvm-a",
      microvm_id: "microvm-a",
      name: "one",
      endpoint: "https://a.example",
      secret: "s".repeat(32),
      image_arn: IMAGE_ARN,
      image_version: "1.0",
      created_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      max_duration_s: 100,
    });
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const r2 = new Registry(file);
    expect(r2.get("microvm-a")?.name).toBe("one");
    expect(r2.remove("microvm-a")).toBe(true);
    expect(new Registry(file).all()).toEqual([]);
    expect(() => r2.require("nope")).toThrow(/unknown sandbox_id/);
  });

  it("ignores a corrupt state file", () => {
    const file = path.join(scratch, "corrupt.json");
    writeFileSync(file, "{not json");
    expect(new Registry(file).all()).toEqual([]);
  });
});

describe("token manager and retries", () => {
  const record = {
    sandbox_id: "microvm-t",
    microvm_id: "microvm-t",
    name: null,
    endpoint: "http://sandbox.test",
    secret: "secret-secret-secret-secret",
    image_arn: IMAGE_ARN,
    image_version: "1.0",
    created_at: "",
    expires_at: "",
    max_duration_s: 1,
  };

  it("refreshes the token only when it is about to expire", async () => {
    const api = new FakeMicrovmApi();
    let now = 1_000_000;
    const tm = new TokenManager(api, "microvm-t", 30, 300, () => now);
    const t1 = await tm.get();
    expect(await tm.get()).toBe(t1);
    now += 24 * 60_000; // 24 min later: still > 5 min margin
    expect(await tm.get()).toBe(t1);
    now += 2 * 60_000; // 26 min: inside the margin
    expect(await tm.get()).not.toBe(t1);
    expect(api.tokenCalls).toBe(2);
  });

  it("retries on 502 while the VM resumes and refreshes on 403", async () => {
    const api = new FakeMicrovmApi();
    const responses: Array<() => Response> = [
      () => new Response("bad gateway", { status: 502 }),
      () => new Response("bad gateway", { status: 502 }),
      () => new Response("forbidden", { status: 403 }),
      () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    const seen: Array<Record<string, string>> = [];
    const client = new SandboxClient(
      record,
      new TokenManager(api, "microvm-t", 30, 300),
      {
        fetch: async (_url, init) => {
          seen.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
          return (responses.shift() as () => Response)();
        },
        sleep: async () => undefined,
        now: () => Date.now(),
      },
      60_000,
    );
    const r = await client.request<{ ok: boolean }>("GET", "/health");
    expect(r.ok).toBe(true);
    expect(seen.length).toBe(4);
    expect(seen[0]?.["x-sandbox-secret"]).toBe(record.secret);
    expect(seen[3]?.["x-aws-proxy-auth"]).not.toBe(seen[2]?.["x-aws-proxy-auth"]);
    expect(api.tokenCalls).toBe(2);
  });

  it("gives up after the resume window and surfaces agent errors", async () => {
    const api = new FakeMicrovmApi();
    let now = 0;
    const client = new SandboxClient(
      record,
      new TokenManager(api, "microvm-t", 30, 300),
      {
        fetch: async () => {
          now += 1000;
          return new Response("bad gateway", { status: 502 });
        },
        sleep: async () => undefined,
        now: () => now,
      },
      3000,
    );
    await expect(client.request("GET", "/health")).rejects.toMatchObject({ status: 502 });

    const c2 = new SandboxClient(
      record,
      new TokenManager(api, "microvm-t", 30, 300),
      {
        fetch: async () => new Response(JSON.stringify({ error: "bad_request", message: "cwd does not exist" }), { status: 400 }),
        sleep: async () => undefined,
        now: () => Date.now(),
      },
      1000,
    );
    await expect(c2.request("POST", "/exec", { json: {} })).rejects.toThrow(/cwd does not exist/);
  });
});

describe("SandboxService end to end against an in-process agent", () => {
  let api: FakeMicrovmApi;
  let service: SandboxService;
  let registryFile: string;

  beforeAll(() => {
    api = new FakeMicrovmApi();
    registryFile = path.join(scratch, "e2e", "sandboxes.json");
    service = new SandboxService({ config: testConfig(), api, accountId, registry: new Registry(registryFile), log: () => undefined });
  });
  afterAll(() => api.cleanup());

  let id: string;

  it("creates a sandbox, waits for the run hook, and stores the record", async () => {
    const created = await service.create({ name: "e2e", max_duration_s: 1800 });
    id = created.sandbox_id;
    expect(id).toMatch(/^microvm-/);
    expect(created.state).toBe("RUNNING");
    expect(created.token_expires_in_s).toBeGreaterThan(0);
    const run = api.runCalls[0];
    expect(run?.maximumDurationInSeconds).toBe(1800);
    expect(run?.idlePolicy.autoResumeEnabled).toBe(true);
    expect(run?.ingressNetworkConnectors[0]).toContain("ALL_INGRESS");
    expect(run?.egressNetworkConnectors[0]).toContain("INTERNET_EGRESS");
    expect(JSON.parse(run?.runHookPayload ?? "{}").secret.length).toBeGreaterThanOrEqual(32);
    expect(run?.runHookPayload.length).toBeLessThan(16 * 1024);
    const stored = new Registry(registryFile).get(id);
    expect(stored?.name).toBe("e2e");
  });

  it("runs commands and manipulates files", async () => {
    const r = await service.exec(id, { command: "echo hi && exit 2" });
    expect(r.exit_code).toBe(2);
    expect(r.stdout).toBe("hi\n");
    await service.writeFile(id, { path: "src/app.py", content: "print('x')\n" });
    const read = await service.readFile(id, { path: "src/app.py" });
    expect(read.content).toBe("print('x')\n");
    const ls = await service.listFiles(id, { path: ".", recursive: true });
    expect(ls.entries.map((e) => e.path)).toContain(path.join("src", "app.py"));
    expect((await service.deletePath(id, { path: "src", recursive: true })).deleted).toBe(true);
  });

  it("uploads a local directory in chunks and downloads it back", async () => {
    const local = path.join(scratch, "proj");
    mkdirSync(path.join(local, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(local, "lib"), { recursive: true });
    writeFileSync(path.join(local, "lib", "index.js"), "module.exports = 1;\n");
    writeFileSync(path.join(local, "node_modules", "dep", "x.js"), "skip me");
    writeFileSync(path.join(local, "big.bin"), Buffer.alloc(200_000, 1));

    const up = await service.uploadDir(id, local, "proj");
    expect(up.mode).toBe("chunked");
    expect(up.bytes).toBeGreaterThan(0);
    const listing = await service.exec(id, { command: "find proj -type f | sort" });
    expect(listing.stdout.trim().split("\n")).toEqual(["proj/big.bin", "proj/lib/index.js"]);

    await service.exec(id, { command: "echo generated > proj/out.txt" });
    const dest = path.join(scratch, "downloaded");
    const down = await service.download(id, "proj", dest);
    expect(down.mode).toBe("chunked");
    expect(readFileSync(path.join(dest, "out.txt"), "utf8")).toBe("generated\n");
    expect(readFileSync(path.join(dest, "lib", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("forwards a sandbox port to localhost and widens the token to that port", async () => {
    const before = api.tokenCalls;
    const fw = await service.portForward(id, 8080);
    expect(fw.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(api.tokenCalls).toBe(before); // 8080 is already in the token: no new token needed
    // The fake VM's agent is what listens on "port 8080": its /health answers through the forward.
    const res = await fetch(`${fw.url}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ready: boolean }).ready).toBe(true);
    const again = await service.portForward(id, 8080);
    expect(again.local_port).toBe(fw.local_port);
    expect(again.note).toBe("already forwarding");
    expect((await service.status(id)).port_forwards).toEqual([{ url: fw.url, remote_port: 8080 }]);

    const other = await service.portForward(id, 3000);
    expect(api.tokenCalls).toBe(before + 1); // new port -> token re-minted with [3000, 8080]
    expect((await service.stopPortForward(id)).stopped.sort()).toEqual([3000, 8080]);
    expect((await service.status(id)).port_forwards).toBeUndefined();
    await expect(fetch(`${other.url}/`)).rejects.toThrow();
  });

  it("suspends, resumes, reports status and lists", async () => {
    expect((await service.suspend(id)).state).toBe("SUSPENDING");
    expect((await service.status(id)).state).toBe("SUSPENDED");
    expect((await service.resume(id)).state).toBe("RUNNING");
    const list = await service.list();
    expect(list.sandboxes.map((s) => s.sandbox_id)).toEqual([id]);
    expect(list.unmanaged).toEqual([]);
  });

  it("reports and forgets sandboxes that Lambda terminated behind our back", async () => {
    const other = await service.create({ name: "short-lived" });
    await api.expire(other.sandbox_id, "Maximum duration reached");
    const list = await service.list();
    const gone = list.sandboxes.find((s) => s.sandbox_id === other.sandbox_id);
    expect(gone?.state).toBe("TERMINATED");
    expect(gone?.state_reason).toBe("Maximum duration reached");
    expect((await service.list()).sandboxes.map((s) => s.sandbox_id)).toEqual([id]);
  });

  it("destroys the sandbox and forgets it", async () => {
    const d = await service.destroy(id);
    expect(d.sandbox_id).toBe(id);
    expect(new Registry(registryFile).get(id)).toBeUndefined();
    await expect(service.exec(id, { command: "true" })).rejects.toThrow(/unknown sandbox_id/);
    // destroying again (already gone in AWS) is not an error path we want to blow up on
    await expect(service.destroy(id)).rejects.toThrow(/unknown sandbox_id/);
  });

  it("terminates a VM whose agent never becomes ready", async () => {
    const slow = new FakeMicrovmApi();
    slow.runHookDelayMs = 60_000;
    const svc = new SandboxService({
      config: testConfig({ readyTimeoutS: 2 }),
      api: slow,
      accountId,
      registry: new Registry(null),
      log: () => undefined,
    });
    await expect(svc.create()).rejects.toThrow(/not ready/);
    const vm = [...slow.vms.values()][0];
    expect(vm?.info.state).toBe("TERMINATED");
    await slow.cleanup();
  });

  it("passes the execution role through and serves CloudWatch logs only when configured", async () => {
    const noRole = new SandboxService({ config: testConfig(), api, accountId, registry: new Registry(null), log: () => undefined });
    const a = await noRole.create();
    expect(api.runCalls.at(-1)?.executionRoleArn).toBeUndefined();
    await expect(noRole.vmLogs(a.sandbox_id)).rejects.toThrow(/no execution role/);
    expect((await noRole.status(a.sandbox_id)).cloudwatch_logs).toBeUndefined();
    await noRole.destroy(a.sandbox_id);

    const roleArn = "arn:aws:iam::123456789012:role/LambdaMicrovmSandboxExecutionRole";
    const tailed: unknown[] = [];
    const withRole = new SandboxService({
      config: testConfig({ executionRoleArn: roleArn }),
      api,
      accountId,
      registry: new Registry(null),
      logs: {
        findStream: async (_group, microvmId) => `2026/09/26[5.0]${microvmId}`,
        tail: async (group, stream, limit) => {
          tailed.push([group, stream, limit]);
          return [{ timestamp: 1_700_000_000_000, message: "[sandbox-agent] hook: run" }];
        },
      },
      log: () => undefined,
    });
    const b = await withRole.create();
    expect(api.runCalls.at(-1)?.executionRoleArn).toBe(roleArn);
    expect((await withRole.status(b.sandbox_id)).cloudwatch_logs?.log_group).toBe("/aws/lambda-microvms/sandbox-agent");
    const logs = await withRole.vmLogs(b.sandbox_id, 50);
    expect(tailed).toEqual([["/aws/lambda-microvms/sandbox-agent", `2026/09/26[5.0]${b.sandbox_id}`, 50]]);
    expect(logs.log_stream).toBe(`2026/09/26[5.0]${b.sandbox_id}`);
    expect(logs.events[0]?.message).toContain("hook: run");
    await withRole.destroy(b.sandbox_id);
  });

  it("fails clearly when the image has no active version", async () => {
    const noImage = new FakeMicrovmApi();
    noImage.latestVersion = undefined;
    const svc = new SandboxService({ config: testConfig(), api: noImage, accountId, registry: new Registry(null), log: () => undefined });
    await expect(svc.create()).rejects.toThrow(/no ACTIVE version yet; run `npx lambda-microvm-sandbox-mcp setup --region ap-northeast-1`/);
  });

  it("derives the image arn from the account when none is configured and explains a missing image", async () => {
    const missing = new FakeMicrovmApi();
    missing.latestActiveImageVersion = async () => {
      const err = new Error("not found");
      err.name = "ResourceNotFoundException";
      throw err;
    };
    const cfg = loadConfig(["--region", "us-east-1", "--image-name", "custom"], {});
    const svc = new SandboxService({ config: cfg, api: missing, accountId, registry: new Registry(null), log: () => undefined });
    expect(await svc.resolveImageArn()).toBe("arn:aws:lambda:us-east-1:123456789012:microvm-image:custom");
    await expect(svc.create()).rejects.toThrow(
      /does not exist; run `npx lambda-microvm-sandbox-mcp setup --region us-east-1 --image-name custom`/,
    );
  });
});

describe("S3 relay mode", () => {
  let relay: Server;
  const store = new Map<string, Buffer>();
  let api: FakeMicrovmApi;
  let service: SandboxService;

  beforeAll(async () => {
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
      if (!data) return void res.writeHead(404).end();
      res.writeHead(200, { "content-length": data.length }).end(data);
    });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    api = new FakeMicrovmApi();
    service = new SandboxService({
      config: testConfig({ transferBucket: "fake-bucket" }),
      api,
      accountId,
      registry: new Registry(null),
      store: new FakeTransferStore(base),
      log: () => undefined,
    });
  });
  afterAll(async () => {
    relay.close();
    await api.cleanup();
  });

  it("relays uploads and downloads through presigned URLs", async () => {
    const { sandbox_id } = await service.create();
    const local = path.join(scratch, "relay-src");
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, "a.txt"), "via s3");
    const up = await service.uploadDir(sandbox_id, local, "relayed");
    expect(up.mode).toBe("s3");
    expect((await service.readFile(sandbox_id, { path: "relayed/a.txt" })).content).toBe("via s3");
    const dest = path.join(scratch, "relay-dst");
    const down = await service.download(sandbox_id, "relayed", dest);
    expect(down.mode).toBe("s3");
    expect(readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("via s3");
    await service.destroy(sandbox_id);
  });
});

describe("MCP surface", () => {
  let api: FakeMicrovmApi;
  let client: Client;

  beforeAll(async () => {
    api = new FakeMicrovmApi();
    const service = new SandboxService({ config: testConfig(), api, accountId, registry: new Registry(null), log: () => undefined });
    const server = createMcpServer(service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });
  afterAll(async () => {
    await client.close();
    await api.cleanup();
  });

  it("exposes the expected tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "sandbox_create",
        "sandbox_delete_path",
        "sandbox_destroy",
        "sandbox_download",
        "sandbox_exec",
        "sandbox_list",
        "sandbox_list_files",
        "sandbox_port_forward",
        "sandbox_port_forward_stop",
        "sandbox_read_file",
        "sandbox_resume",
        "sandbox_status",
        "sandbox_suspend",
        "sandbox_upload_dir",
        "sandbox_vm_logs",
        "sandbox_write_file",
      ].sort(),
    );
    const exec = tools.find((t) => t.name === "sandbox_exec");
    expect(exec?.inputSchema.required).toEqual(expect.arrayContaining(["sandbox_id", "command"]));
  });

  it("runs the create -> exec -> destroy flow through MCP and reports errors as isError", async () => {
    const created = await client.callTool({ name: "sandbox_create", arguments: { name: "mcp" } });
    const sc = created.structuredContent as { sandbox_id: string };
    expect(sc.sandbox_id).toMatch(/^microvm-/);

    const exec = await client.callTool({ name: "sandbox_exec", arguments: { sandbox_id: sc.sandbox_id, command: "echo from-mcp" } });
    expect((exec.structuredContent as { stdout: string }).stdout).toBe("from-mcp\n");
    expect(exec.isError).toBeFalsy();

    const bad = await client.callTool({ name: "sandbox_exec", arguments: { sandbox_id: "microvm-nope", command: "true" } });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0]?.text).toMatch(/unknown sandbox_id/);

    const invalid = await client.callTool({ name: "sandbox_exec", arguments: { sandbox_id: sc.sandbox_id } });
    expect(invalid.isError).toBe(true);

    const destroyed = await client.callTool({ name: "sandbox_destroy", arguments: { sandbox_id: sc.sandbox_id } });
    expect((destroyed.structuredContent as { sandbox_id: string }).sandbox_id).toBe(sc.sandbox_id);
    expect(api.vms.get(sc.sandbox_id)?.info.state).toBe("TERMINATED");
  });
});
