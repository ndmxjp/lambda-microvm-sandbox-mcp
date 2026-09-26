import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, createZip } from "../src/zip.js";
import {
  buildRolePolicy,
  defaultBucketName,
  runSetup,
  trustPolicy,
  type ImageBuildInput,
  type SetupClients,
  type SetupOptions,
} from "../src/setup.js";

describe("zip writer", () => {
  it("computes crc32 like everyone else", () => {
    expect(crc32(new Uint8Array(Buffer.from("hello"))).toString(16)).toBe("3610a686");
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("produces an archive that unzip accepts and that round-trips content", () => {
    const zip = createZip([
      { name: "Dockerfile", data: new Uint8Array(Buffer.from("FROM x\n")), mode: 0o644 },
      { name: "agent.mjs", data: new Uint8Array(Buffer.from("console.log(1)\n")), mode: 0o644 },
      { name: "empty.txt", data: new Uint8Array(0) },
    ]);
    const dir = mkdtempSync(path.join(tmpdir(), "zip-"));
    const file = path.join(dir, "a.zip");
    writeFileSync(file, zip);
    const listing = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    expect(listing).toMatch(/No errors detected/);
    const content = execFileSync("unzip", ["-p", file, "agent.mjs"], { encoding: "utf8" });
    expect(content).toBe("console.log(1)\n");
  });
});

function imageDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "image-"));
  writeFileSync(path.join(dir, "Dockerfile"), "FROM public.ecr.aws/lambda/microvms:al2023-minimal\n");
  writeFileSync(path.join(dir, "agent.mjs"), "// agent\n");
  writeFileSync(path.join(dir, "sudo.mjs"), "// sudo\n");
  return dir;
}

class FakeSetupClients implements SetupClients {
  buckets = new Set<string>();
  hardened: string[] = [];
  objects = new Map<string, Uint8Array>();
  roles = new Map<string, string>();
  images = new Map<string, string[]>(); // arn -> versions
  versionStates = new Map<string, string[]>(); // "arn@version" -> state sequence
  createImageFailures = 0;
  supported = true;
  calls: string[] = [];

  async accountId() {
    return "111122223333";
  }
  async regionSupported() {
    return this.supported;
  }
  async bucketExists(name: string) {
    return this.buckets.has(name);
  }
  async createBucket(name: string) {
    this.calls.push(`createBucket ${name}`);
    this.buckets.add(name);
  }
  async hardenBucket(name: string) {
    this.hardened.push(name);
  }
  async putObject(bucket: string, key: string, body: Uint8Array) {
    this.calls.push(`put ${bucket}/${key}`);
    this.objects.set(`${bucket}/${key}`, body);
  }
  async getRoleArn(name: string) {
    return this.roles.get(name);
  }
  async createRole(name: string, trust: string, policy: string) {
    this.calls.push(`createRole ${name}`);
    JSON.parse(trust);
    JSON.parse(policy);
    const arn = `arn:aws:iam::111122223333:role/${name}`;
    this.roles.set(name, arn);
    return arn;
  }
  async imageExists(arn: string) {
    return this.images.has(arn);
  }
  async createImage(input: ImageBuildInput) {
    if (this.createImageFailures > 0) {
      this.createImageFailures--;
      throw new Error("InvalidParameterValueException: The role defined for the image cannot be assumed by Lambda.");
    }
    this.calls.push(`createImage ${input.name} ${input.codeArtifactUri}`);
    this.images.set(input.imageArn, ["1.0"]);
  }
  async updateImage(input: ImageBuildInput) {
    const versions = this.images.get(input.imageArn) ?? [];
    const next = `${versions.length + 1}.0`;
    versions.push(next);
    this.calls.push(`updateImage ${input.name} -> ${next}`);
    return next;
  }
  async getVersionState(arn: string, version: string) {
    const seq = this.versionStates.get(`${arn}@${version}`) ?? ["SUCCESSFUL"];
    const state = seq.length > 1 ? (seq.shift() as string) : (seq[0] as string);
    return { state };
  }
  async buildLogTail() {
    return ["build log line 1", "build log line 2"];
  }
}

const io = (confirmAnswer = true) => {
  const lines: string[] = [];
  return {
    lines,
    io: { log: (m: string) => lines.push(m), confirm: async () => confirmAnswer, sleep: async () => undefined },
  };
};

function opts(over: Partial<SetupOptions> = {}): SetupOptions {
  return {
    region: "ap-northeast-1",
    imageName: "sandbox-agent",
    buildRoleName: "LambdaMicrovmSandboxBuildRole",
    memoryMib: 2048,
    dryRun: false,
    yes: true,
    timeoutMin: 1,
    imageDir: imageDir(),
    ...over,
  };
}

describe("setup", () => {
  it("dry run reports the plan and creates nothing", async () => {
    const c = new FakeSetupClients();
    const { io: i, lines } = io();
    const r = await runSetup(opts({ dryRun: true }), c, i);
    expect(r.dryRun).toBe(true);
    expect(r.created).toEqual({ bucket: true, role: true, image: true });
    expect(c.calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/will create: private/);
    expect(lines.join("\n")).toMatch(/will create version 1.0/);
  });

  it("creates bucket, role and image from scratch, retrying while IAM propagates", async () => {
    const c = new FakeSetupClients();
    c.createImageFailures = 2;
    const { io: i, lines } = io();
    const r = await runSetup(opts(), c, i);
    expect(r.bucket).toBe(defaultBucketName("111122223333", "ap-northeast-1"));
    expect(r.buildRoleArn).toBe("arn:aws:iam::111122223333:role/LambdaMicrovmSandboxBuildRole");
    expect(r.imageArn).toBe("arn:aws:lambda:ap-northeast-1:111122223333:microvm-image:sandbox-agent");
    expect(r.imageVersion).toBe("1.0");
    expect(c.calls[0]).toMatch(/^createBucket lambda-microvm-sandbox-111122223333-ap-northeast-1$/);
    expect(c.calls[1]).toMatch(/^createRole/);
    expect(c.calls[2]).toMatch(
      /^put lambda-microvm-sandbox-111122223333-ap-northeast-1\/microvm-images\/sandbox-agent\/[0-9a-f]{16}\.zip$/,
    );
    expect(c.calls[3]).toMatch(/^createImage sandbox-agent s3:\/\//);
    expect(c.hardened).toEqual([r.bucket]);
    expect(lines.filter((l) => l.includes("waiting for IAM")).length).toBe(2);
    const zip = [...c.objects.values()][0] as Uint8Array;
    expect(Buffer.from(zip.subarray(0, 4)).readUInt32LE(0)).toBe(0x04034b50);
  });

  it("reuses existing bucket and role and builds a new version of an existing image", async () => {
    const c = new FakeSetupClients();
    c.buckets.add("my-bucket");
    c.images.set("arn:aws:lambda:ap-northeast-1:111122223333:microvm-image:sandbox-agent", ["1.0", "2.0"]);
    const { io: i } = io();
    const r = await runSetup(opts({ bucket: "my-bucket", buildRoleArn: "arn:aws:iam::111122223333:role/Existing" }), c, i);
    expect(r.created).toEqual({ bucket: false, role: false, image: false });
    expect(r.imageVersion).toBe("3.0");
    expect(r.buildRoleArn).toBe("arn:aws:iam::111122223333:role/Existing");
    expect(c.calls.some((x) => x.startsWith("createRole"))).toBe(false);
    expect(c.calls.some((x) => x.startsWith("createBucket"))).toBe(false);
  });

  it("stops when the user declines, when the region is unsupported, and surfaces failed builds with the log", async () => {
    const declined = new FakeSetupClients();
    await expect(runSetup(opts({ yes: false }), declined, io(false).io)).rejects.toThrow(/aborted/);
    expect(declined.calls).toEqual([]);

    const unsupported = new FakeSetupClients();
    unsupported.supported = false;
    await expect(runSetup(opts(), unsupported, io().io)).rejects.toThrow(/not available in ap-northeast-1/);

    const failing = new FakeSetupClients();
    failing.versionStates.set("arn:aws:lambda:ap-northeast-1:111122223333:microvm-image:sandbox-agent@1.0", [
      "PENDING",
      "IN_PROGRESS",
      "FAILED",
    ]);
    const { io: i, lines } = io();
    await expect(runSetup(opts(), failing, i)).rejects.toThrow(/ended in FAILED/);
    expect(lines.join("\n")).toMatch(/build log line 2/);
  });

  it("writes least-privilege policies with a confused-deputy guard", () => {
    const trust = JSON.parse(trustPolicy("111122223333")) as { Statement: Array<{ Condition: unknown; Principal: unknown }> };
    expect(trust.Statement[0]?.Principal).toEqual({ Service: "lambda.amazonaws.com" });
    expect(trust.Statement[0]?.Condition).toEqual({ StringEquals: { "aws:SourceAccount": "111122223333" } });
    const policy = JSON.parse(buildRolePolicy("b", "ap-northeast-1", "111122223333")) as { Statement: Array<{ Resource: string }> };
    expect(policy.Statement[0]?.Resource).toBe("arn:aws:s3:::b/microvm-images/*");
    expect(policy.Statement[1]?.Resource).toBe("arn:aws:logs:ap-northeast-1:111122223333:log-group:/aws/lambda/microvms/*");
  });
});
