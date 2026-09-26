/**
 * `lambda-microvm-sandbox-mcp setup`: provision everything the MCP server
 * needs in the caller's AWS account, idempotently:
 *
 *   1. an S3 bucket for the image code artifact (private, encrypted, objects
 *      expire after 30 days)
 *   2. an IAM role Lambda assumes while building the image
 *   3. the MicroVM image itself, built from the Dockerfile + agent bundle that
 *      ship inside this npm package
 *
 * Every AWS call goes through the SetupClients interface so the flow can be
 * tested with fakes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createZip } from "./zip.js";

export interface SetupOptions {
  region: string;
  imageName: string;
  /** Existing bucket to use; default lambda-microvm-sandbox-<account>-<region>. */
  bucket?: string;
  /** Existing build role ARN to use instead of creating one. */
  buildRoleArn?: string;
  buildRoleName: string;
  memoryMib: number;
  dryRun: boolean;
  /** Skip the interactive confirmation. */
  yes: boolean;
  timeoutMin: number;
  /** Directory holding Dockerfile, agent.mjs and sudo.mjs. */
  imageDir: string;
}

export const SETUP_DEFAULTS = {
  imageName: "sandbox-agent",
  buildRoleName: "LambdaMicrovmSandboxBuildRole",
  memoryMib: 2048,
  timeoutMin: 30,
} as const;

export interface ImageBuildInput {
  name: string;
  imageArn: string;
  baseImageArn: string;
  buildRoleArn: string;
  codeArtifactUri: string;
  memoryMib: number;
  region: string;
  description: string;
}

export interface SetupClients {
  accountId(): Promise<string>;
  regionSupported(): Promise<boolean>;
  bucketExists(name: string): Promise<boolean>;
  createBucket(name: string): Promise<void>;
  hardenBucket(name: string): Promise<void>;
  putObject(bucket: string, key: string, body: Uint8Array): Promise<void>;
  getRoleArn(name: string): Promise<string | undefined>;
  createRole(name: string, trustPolicy: string, inlinePolicy: string): Promise<string>;
  imageExists(imageArn: string): Promise<boolean>;
  createImage(input: ImageBuildInput): Promise<void>;
  /** Returns the newly created version. */
  updateImage(input: ImageBuildInput): Promise<string>;
  getVersionState(imageArn: string, version: string): Promise<{ state: string; reason?: string }>;
  buildLogTail(imageName: string): Promise<string[]>;
}

export interface SetupIo {
  log(msg: string): void;
  confirm(question: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface SetupResult {
  imageArn: string;
  imageVersion: string;
  bucket: string;
  buildRoleArn: string;
  created: { bucket: boolean; role: boolean; image: boolean };
  dryRun: boolean;
}

export const HOOKS = {
  port: 9000,
  microvmImageHooks: { ready: "ENABLED", readyTimeoutInSeconds: 120, validate: "ENABLED", validateTimeoutInSeconds: 300 },
  microvmHooks: {
    run: "ENABLED",
    runTimeoutInSeconds: 10,
    resume: "ENABLED",
    resumeTimeoutInSeconds: 10,
    suspend: "ENABLED",
    suspendTimeoutInSeconds: 10,
    terminate: "ENABLED",
    terminateTimeoutInSeconds: 10,
  },
} as const;

export function defaultBucketName(account: string, region: string): string {
  return `lambda-microvm-sandbox-${account}-${region}`;
}

export function trustPolicy(account: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: ["sts:AssumeRole", "sts:TagSession"],
        Condition: { StringEquals: { "aws:SourceAccount": account } },
      },
    ],
  });
}

export function buildRolePolicy(bucket: string, region: string, account: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:GetObject"], Resource: `arn:aws:s3:::${bucket}/microvm-images/*` },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/microvms/*`,
      },
    ],
  });
}

export function readImageAssets(imageDir: string): { entries: Array<{ name: string; data: Uint8Array; mode: number }>; sha: string } {
  const names = ["Dockerfile", "agent.mjs", "sudo.mjs"];
  const entries = names.map((name) => ({ name, data: new Uint8Array(readFileSync(`${imageDir}/${name}`)), mode: 0o644 }));
  const h = createHash("sha256");
  for (const e of entries) h.update(e.name).update(e.data);
  return { entries, sha: h.digest("hex").slice(0, 16) };
}

const TERMINAL_OK = new Set(["SUCCESSFUL", "ACTIVE"]);
const TERMINAL_BAD = new Set(["FAILED", "DELETING", "DELETED"]);

export async function waitForImageVersion(
  clients: SetupClients,
  io: SetupIo,
  imageArn: string,
  version: string,
  timeoutMin: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMin * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const { state, reason } = await clients.getVersionState(imageArn, version);
    if (state !== last) {
      io.log(`image version ${version}: ${state}${reason ? ` (${reason})` : ""}`);
      last = state;
    }
    if (TERMINAL_OK.has(state)) return;
    if (TERMINAL_BAD.has(state)) throw new Error(`image version ${version} ended in ${state}: ${reason ?? "no reason given"}`);
    await io.sleep(10_000);
  }
  throw new Error(`timed out after ${timeoutMin} minutes waiting for image version ${version}`);
}

/** Retry an image create/update while IAM propagates the freshly created role. */
async function withIamRetry<T>(io: SetupIo, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err);
      const iamRace = /assume|not authorized|AccessDenied|InvalidParameterValue|role/i.test(msg);
      if (!iamRace || attempt >= 8) throw err;
      io.log(`waiting for IAM to propagate (${attempt}/8): ${msg.split("\n")[0]}`);
      await io.sleep(10_000);
    }
  }
}

export async function runSetup(opts: SetupOptions, clients: SetupClients, io: SetupIo): Promise<SetupResult> {
  if (!(await clients.regionSupported())) {
    throw new Error(`Lambda MicroVMs is not available in ${opts.region} (ListManagedMicrovmImages failed); pick another --region`);
  }
  const account = await clients.accountId();
  const bucket = opts.bucket ?? defaultBucketName(account, opts.region);
  const imageArn = `arn:aws:lambda:${opts.region}:${account}:microvm-image:${opts.imageName}`;
  const baseImageArn = `arn:aws:lambda:${opts.region}:aws:microvm-image:al2023-1`;

  const bucketExists = await clients.bucketExists(bucket);
  const existingRole = opts.buildRoleArn ?? (await clients.getRoleArn(opts.buildRoleName));
  const imageExists = await clients.imageExists(imageArn);
  const assets = readImageAssets(opts.imageDir);
  const key = `microvm-images/${opts.imageName}/${assets.sha}.zip`;

  io.log(`account ${account}, region ${opts.region}`);
  io.log(`S3 bucket      ${bucket} ${bucketExists ? "(exists)" : "(will create: private, SSE-S3, 30-day expiry)"}`);
  io.log(
    `build role     ${existingRole ?? `${opts.buildRoleName} (will create: trusts lambda.amazonaws.com, reads the bucket, writes build logs)`}`,
  );
  io.log(`image          ${imageArn} ${imageExists ? "(exists: will build a new version)" : "(will create version 1.0)"}`);
  io.log(`artifact       s3://${bucket}/${key} (${assets.entries.map((e) => e.name).join(", ")})`);
  io.log(`size           ${opts.memoryMib} MiB memory, ARM64, INTERNET_EGRESS during build`);
  io.log("cost           image snapshots are billed for storage (about $0.08/GB-month, minimum one week)");

  const created = { bucket: !bucketExists, role: !existingRole, image: !imageExists };
  if (opts.dryRun) {
    return { imageArn, imageVersion: "(dry run)", bucket, buildRoleArn: existingRole ?? "(to be created)", created, dryRun: true };
  }
  if (!opts.yes && !(await io.confirm("Proceed?"))) throw new Error("aborted");

  if (!bucketExists) {
    io.log(`creating bucket ${bucket}`);
    await clients.createBucket(bucket);
  }
  await clients.hardenBucket(bucket);

  let buildRoleArn = existingRole;
  if (!buildRoleArn) {
    io.log(`creating role ${opts.buildRoleName}`);
    buildRoleArn = await clients.createRole(opts.buildRoleName, trustPolicy(account), buildRolePolicy(bucket, opts.region, account));
  }

  io.log(`uploading ${key}`);
  await clients.putObject(bucket, key, createZip(assets.entries));

  const input: ImageBuildInput = {
    name: opts.imageName,
    imageArn,
    baseImageArn,
    buildRoleArn,
    codeArtifactUri: `s3://${bucket}/${key}`,
    memoryMib: opts.memoryMib,
    region: opts.region,
    description: `lambda-microvm-sandbox-mcp agent ${assets.sha}`,
  };
  let version: string;
  if (imageExists) {
    version = await withIamRetry(io, () => clients.updateImage(input));
    io.log(`update requested: version ${version}`);
  } else {
    await withIamRetry(io, () => clients.createImage(input));
    version = "1.0";
    io.log("create requested: version 1.0");
  }
  try {
    await waitForImageVersion(clients, io, imageArn, version, opts.timeoutMin);
  } catch (err) {
    io.log(String(err instanceof Error ? err.message : err));
    io.log("last build log lines:");
    for (const line of await clients.buildLogTail(opts.imageName)) io.log(`  ${line}`);
    throw err;
  }
  return { imageArn, imageVersion: version, bucket, buildRoleArn, created, dryRun: false };
}
