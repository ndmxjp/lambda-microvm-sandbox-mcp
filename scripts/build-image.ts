#!/usr/bin/env -S npx tsx
/**
 * Build (or update) the sandbox MicroVM image.
 *
 *   npm run build-image -- --dry-run                 # show what would be sent, no AWS calls
 *   npm run build-image -- --yes                     # zip -> S3 -> create/update image -> wait
 *   npm run build-image -- --yes --memory-mib 4096   # bigger VM (one image = one size)
 *   npm run build-image -- --prune-versions 2 --yes  # delete all but the newest 2 ACTIVE versions
 *
 * Creating an image builds a snapshot that is billed for storage (minimum one
 * week), so nothing is sent to AWS without --yes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateMicrovmImageCommand,
  DeleteMicrovmImageVersionCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListMicrovmImageVersionsCommand,
  type CreateMicrovmImageCommandInput,
  type UpdateMicrovmImageCommandInput,
  UpdateMicrovmImageCommand,
} from "@aws-sdk/client-lambda-microvms";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

interface Args {
  region: string;
  imageName: string;
  bucket: string;
  buildRoleArn: string;
  baseImageArn: string;
  memoryMib: number;
  architecture: "ARM_64";
  dryRun: boolean;
  yes: boolean;
  pruneVersions: number | null;
  skipBuild: boolean;
  timeoutMin: number;
}

function parse(argv: string[]): Args {
  const env = process.env;
  const a: Args = {
    region: env.AWS_REGION ?? "ap-northeast-1",
    imageName: env.SANDBOX_IMAGE_NAME ?? "sandbox-agent",
    bucket: env.SANDBOX_ARTIFACT_BUCKET ?? "",
    buildRoleArn: env.SANDBOX_BUILD_ROLE_ARN ?? "",
    baseImageArn: "",
    memoryMib: 2048,
    architecture: "ARM_64",
    dryRun: false,
    yes: false,
    pruneVersions: null,
    skipBuild: false,
    timeoutMin: 40,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] as string;
    const v = (): string => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`missing value for ${k}`);
      return x;
    };
    switch (k) {
      case "--region": a.region = v(); break;
      case "--name": a.imageName = v(); break;
      case "--bucket": a.bucket = v(); break;
      case "--build-role-arn": a.buildRoleArn = v(); break;
      case "--base-image-arn": a.baseImageArn = v(); break;
      case "--memory-mib": a.memoryMib = Number(v()); break;
            case "--dry-run": a.dryRun = true; break;
      case "--yes": a.yes = true; break;
      case "--prune-versions": a.pruneVersions = Number(v()); break;
      case "--skip-build": a.skipBuild = true; break;
      case "--timeout-min": a.timeoutMin = Number(v()); break;
      case "-h": case "--help":
        console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  if (!a.baseImageArn) a.baseImageArn = `arn:aws:lambda:${a.region}:aws:microvm-image:al2023-1`;
  return a;
}

const HOOKS = {
  port: 9000,
  microvmImageHooks: { ready: "ENABLED", readyTimeoutInSeconds: 120, validate: "ENABLED", validateTimeoutInSeconds: 300 },
  microvmHooks: {
    run: "ENABLED", runTimeoutInSeconds: 10,
    resume: "ENABLED", resumeTimeoutInSeconds: 10,
    suspend: "ENABLED", suspendTimeoutInSeconds: 10,
    terminate: "ENABLED", terminateTimeoutInSeconds: 10,
  },
} as const;

function log(msg: string): void {
  console.log(`[build-image] ${msg}`);
}

function bundleAgent(): string {
  const dist = path.join(repoRoot, "packages", "sandbox-agent", "dist", "image");
  log("building sandbox-agent bundle");
  execFileSync("npm", ["run", "build", "-w", "packages/sandbox-agent"], { cwd: repoRoot, stdio: "inherit" });
  if (!existsSync(path.join(dist, "agent.mjs")) || !existsSync(path.join(dist, "Dockerfile"))) {
    throw new Error(`bundle missing in ${dist}`);
  }
  return dist;
}

function zipDir(dir: string): { file: string; sha: string; cleanup(): void } {
  const tmp = mkdtempSync(path.join(tmpdir(), "microvm-image-"));
  const file = path.join(tmp, "code-artifact.zip");
  execFileSync("zip", ["-q", "-X", "-r", file, "."], { cwd: dir, stdio: "inherit" });
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  return { file, sha, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

async function imageExists(client: LambdaMicrovmsClient, arn: string): Promise<boolean> {
  try {
    await client.send(new GetMicrovmImageCommand({ imageIdentifier: arn }));
    return true;
  } catch (err) {
    if (/ResourceNotFound/.test(String(err))) return false;
    throw err;
  }
}

async function tailBuildLog(region: string, imageName: string): Promise<void> {
  const logs = new CloudWatchLogsClient({ region });
  try {
    const r = await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/microvms/${imageName}`, limit: 60 }));
    for (const e of r.events ?? []) console.log(`  ${new Date(e.timestamp ?? 0).toISOString()} ${e.message?.trimEnd()}`);
  } catch (err) {
    log(`could not read build log: ${String(err)}`);
  }
}

async function waitForVersion(client: LambdaMicrovmsClient, arn: string, version: string, timeoutMin: number): Promise<string> {
  const deadline = Date.now() + timeoutMin * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await client.send(new GetMicrovmImageVersionCommand({ imageIdentifier: arn, imageVersion: version }));
    const state = String(r.state);
    if (state !== last) {
      log(`version ${version}: ${state}${r.stateReason ? ` (${r.stateReason})` : ""}`);
      last = state;
    }
    // Observed 2026-09-26: a finished version reports SUCCESSFUL (not ACTIVE) and the
    // image's latestActiveImageVersion points at it.
    if (state === "SUCCESSFUL" || state === "ACTIVE") return state;
    if (state === "FAILED" || state === "DELETING" || state === "DELETED") {
      throw new Error(`image version ${version} ended in ${state}: ${r.stateReason ?? "no reason"}`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error(`timed out after ${timeoutMin} minutes waiting for version ${version}`);
}

async function prune(client: LambdaMicrovmsClient, arn: string, keep: number, yes: boolean): Promise<void> {
  const r = await client.send(new ListMicrovmImageVersionsCommand({ imageIdentifier: arn }));
  const versions = (r.items ?? [])
    .filter((v) => ["SUCCESSFUL", "ACTIVE", "FAILED"].includes(String(v.state)))
    .sort((a, b) => Number(b.imageVersion?.split(".")[0]) - Number(a.imageVersion?.split(".")[0]));
  const doomed = versions.slice(keep);
  if (doomed.length === 0) return log("nothing to prune");
  for (const v of doomed) log(`would delete version ${v.imageVersion} (${v.state})`);
  if (!yes) return log("pass --yes to delete");
  for (const v of doomed) {
    await client.send(new DeleteMicrovmImageVersionCommand({ imageIdentifier: arn, imageVersion: v.imageVersion }));
    log(`deleted version ${v.imageVersion}`);
  }
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  // Dry runs make no AWS calls at all, so the account id is left symbolic.
  const sts = a.dryRun
    ? undefined
    : await (async () => {
        const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
        return new STSClient({ region: a.region }).send(new GetCallerIdentityCommand({}));
      })().catch(() => undefined);
  const account = sts?.Account ?? "<account>";
  const imageArn = `arn:aws:lambda:${a.region}:${account}:microvm-image:${a.imageName}`;
  const client = new LambdaMicrovmsClient({ region: a.region });

  if (a.pruneVersions !== null) {
    await prune(client, imageArn, a.pruneVersions, a.yes);
    if (a.skipBuild) return;
  }

  if (!a.bucket || !a.buildRoleArn) {
    throw new Error("set SANDBOX_ARTIFACT_BUCKET/--bucket and SANDBOX_BUILD_ROLE_ARN/--build-role-arn");
  }

  const dist = bundleAgent();
  const zip = zipDir(dist);
  const key = `microvm-images/${a.imageName}/${zip.sha}.zip`;
  const common = {
    baseImageArn: a.baseImageArn,
    buildRoleArn: a.buildRoleArn,
    codeArtifact: { uri: `s3://${a.bucket}/${key}` },
    resources: [{ minimumMemoryInMiB: a.memoryMib }],
    cpuConfigurations: [{ architecture: a.architecture }],
    egressNetworkConnectors: [`arn:aws:lambda:${a.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`],
    hooks: HOOKS,
    description: `AI coding agent sandbox (agent ${zip.sha})`,
  };

  log(`image: ${imageArn}`);
  log(`artifact: ${common.codeArtifact.uri}`);
  log(`params: ${JSON.stringify({ ...common, hooks: "(see script)" }, null, 2)}`);

  if (a.dryRun || !a.yes) {
    log(a.dryRun ? "dry run: not calling AWS" : "pass --yes to upload and build (this creates billable snapshot storage)");
    zip.cleanup();
    return;
  }

  try {
    log("uploading artifact");
    await new S3Client({ region: a.region }).send(new PutObjectCommand({ Bucket: a.bucket, Key: key, Body: readFileSync(zip.file) }));
  } finally {
    zip.cleanup();
  }

  let version: string;
  if (await imageExists(client, imageArn)) {
    const input: UpdateMicrovmImageCommandInput = { imageIdentifier: imageArn, ...common };
    const r = await client.send(new UpdateMicrovmImageCommand(input));
    const vs = await client.send(new ListMicrovmImageVersionsCommand({ imageIdentifier: imageArn }));
    const newest = (vs.items ?? []).map((v) => v.imageVersion ?? "0.0").sort((x, y) => Number(y.split(".")[0]) - Number(x.split(".")[0]))[0];
    version = newest ?? r.latestActiveImageVersion ?? "1.0";
    log(`update requested, newest version ${version}`);
  } else {
    const input: CreateMicrovmImageCommandInput = { name: a.imageName, ...common };
    await client.send(new CreateMicrovmImageCommand(input));
    version = "1.0";
    log("create requested");
  }

  try {
    await waitForVersion(client, imageArn, version, a.timeoutMin);
  } catch (err) {
    log(String(err));
    log("last build log lines:");
    await tailBuildLog(a.region, a.imageName);
    process.exit(1);
  }

  console.log("\nImage ready. Configure the MCP server with:\n");
  console.log(`  export SANDBOX_IMAGE_ARN=${imageArn}`);
  console.log(`  export SANDBOX_IMAGE_VERSION=${version}   # optional, defaults to latest ACTIVE\n`);
}

main().catch((err) => {
  console.error(`[build-image] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
