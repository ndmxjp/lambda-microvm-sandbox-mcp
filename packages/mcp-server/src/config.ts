import os from "node:os";
import path from "node:path";

export interface Config {
  region: string;
  /** Explicit image ARN. When absent it is derived from region + account + imageName. */
  imageArn: string | undefined;
  imageName: string;
  /** Explicit image version such as "1.0". When absent the latest ACTIVE version is used. */
  imageVersion: string | undefined;
  maxDurationS: number;
  idleS: number;
  suspendedS: number;
  internetEgress: boolean;
  transferBucket: string | undefined;
  transferPrefix: string;
  stateFile: string;
  tokenTtlMin: number;
  tokenRefreshMarginS: number;
  readyTimeoutS: number;
  /** How long to keep retrying 502 while a suspended VM auto-resumes. */
  resumeWaitS: number;
}

export const DEFAULTS = {
  imageName: "sandbox-agent",
  maxDurationS: 4 * 3600,
  idleS: 600,
  suspendedS: 3600,
  internetEgress: true,
  transferPrefix: "lambda-sandbox-transfers/",
  tokenTtlMin: 30,
  tokenRefreshMarginS: 300,
  readyTimeoutS: 180,
  resumeWaitS: 90,
} as const;

export const USAGE = `lambda-microvm-sandbox-mcp [command] [options]

Commands:
  (none)                     Run the MCP server on stdio (what your agent's MCP config should launch)
  setup                      One-time: create the S3 bucket, build role and MicroVM image in your account
  doctor                     Check credentials, region support, image state and configuration

Server options (each also settable via the environment variable in parentheses):
  --image-name <name>        MicroVM image name (SANDBOX_IMAGE_NAME)          [default: ${DEFAULTS.imageName}]
  --image-arn <arn>          Full image ARN instead of name lookup (SANDBOX_IMAGE_ARN)
  --image-version <ver>      Image version, e.g. 1.0 (SANDBOX_IMAGE_VERSION)  [default: latest ACTIVE]
  --region <region>          AWS region (AWS_REGION / profile default / image ARN)
  --max-duration <sec>       maximumDurationInSeconds (SANDBOX_MAX_DURATION_S) [default: ${DEFAULTS.maxDurationS}]
  --idle <sec>               idlePolicy.maxIdleDurationSeconds (SANDBOX_IDLE_S) [default: ${DEFAULTS.idleS}]
  --suspended <sec>          idlePolicy.suspendedDurationSeconds (SANDBOX_SUSPENDED_S) [default: ${DEFAULTS.suspendedS}]
  --no-internet-egress       Do not attach INTERNET_EGRESS (SANDBOX_INTERNET_EGRESS=false)
  --transfer-bucket <name>   S3 bucket for large transfers (SANDBOX_TRANSFER_BUCKET) [default: direct chunked transfer]
  --state-file <path>        Sandbox registry (SANDBOX_STATE_FILE) [default: ~/.lambda-sandbox/sandboxes.json]
  --token-ttl <min>          Auth token lifetime 1-60 (SANDBOX_TOKEN_TTL_MIN) [default: ${DEFAULTS.tokenTtlMin}]
  --print-config             Print the resolved configuration and exit
  -h, --help                 Show this help

Setup options:
  --region <region>          Region to build in (required unless AWS_REGION or a profile default is set)
  --image-name <name>        Image name                                     [default: ${DEFAULTS.imageName}]
  --bucket <name>            Existing bucket for the artifact                [default: lambda-microvm-sandbox-<account>-<region>]
  --build-role-arn <arn>     Existing build role instead of creating one
  --build-role-name <name>   Name of the role to create                      [default: LambdaMicrovmSandboxBuildRole]
  --memory-mib <n>           VM size; one image has one size                 [default: 2048]
  --dry-run                  Show what would be created and exit
  --yes                      Do not ask for confirmation
`;

function regionFromArn(arn: string): string | undefined {
  const m = /^arn:aws[a-z-]*:lambda:([a-z0-9-]+):/.exec(arn);
  return m?.[1];
}

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${value}"`);
  return n;
}

export interface ParsedArgs {
  values: Record<string, string | boolean>;
  help: boolean;
  printConfig: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string | boolean> = {};
  let help = false;
  let printConfig = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-h" || a === "--help") help = true;
    else if (a === "--print-config") printConfig = true;
    else if (a === "--no-internet-egress") values["internet-egress"] = false;
    else if (a === "--dry-run" || a === "--yes") values[a.slice(2)] = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (val === undefined) throw new Error(`missing value for --${key}`);
      values[key] = val;
    } else throw new Error(`unexpected argument: ${a}`);
  }
  return { values, help, printConfig };
}

export function loadConfig(argv: string[] = [], env: NodeJS.ProcessEnv = process.env, defaultRegion?: string): Config {
  const { values } = parseArgs(argv);
  const str = (k: string, e: string): string | undefined => {
    const v = values[k];
    if (typeof v === "string") return v;
    const ev = env[e];
    return ev === "" ? undefined : ev;
  };
  const imageArn = str("image-arn", "SANDBOX_IMAGE_ARN");
  // Region precedence: --region, then the image ARN (a VM must run where its
  // image lives), then the environment, then whatever the caller resolved from
  // the AWS profile (passed in as defaultRegion).
  const explicitRegion = typeof values["region"] === "string" ? (values["region"] as string) : undefined;
  const region =
    explicitRegion ?? (imageArn ? regionFromArn(imageArn) : undefined) ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? defaultRegion;
  if (!region) throw new Error("could not determine the AWS region; pass --region or set AWS_REGION");
  const egressFlag = values["internet-egress"];
  const internetEgress =
    typeof egressFlag === "boolean"
      ? egressFlag
      : env.SANDBOX_INTERNET_EGRESS === undefined
        ? DEFAULTS.internetEgress
        : env.SANDBOX_INTERNET_EGRESS !== "false";
  const tokenTtlMin = num(str("token-ttl", "SANDBOX_TOKEN_TTL_MIN"), DEFAULTS.tokenTtlMin, "token ttl");
  if (tokenTtlMin > 60) throw new Error("token ttl must be 60 minutes or less");
  const maxDurationS = num(str("max-duration", "SANDBOX_MAX_DURATION_S"), DEFAULTS.maxDurationS, "max duration");
  if (maxDurationS > 28_800) throw new Error("max duration must be 28800 seconds (8 hours) or less");
  return {
    region,
    imageArn,
    imageName: str("image-name", "SANDBOX_IMAGE_NAME") ?? DEFAULTS.imageName,
    imageVersion: str("image-version", "SANDBOX_IMAGE_VERSION"),
    maxDurationS,
    idleS: num(str("idle", "SANDBOX_IDLE_S"), DEFAULTS.idleS, "idle"),
    suspendedS: num(str("suspended", "SANDBOX_SUSPENDED_S"), DEFAULTS.suspendedS, "suspended"),
    internetEgress,
    transferBucket: str("transfer-bucket", "SANDBOX_TRANSFER_BUCKET"),
    transferPrefix: env.SANDBOX_TRANSFER_PREFIX ?? DEFAULTS.transferPrefix,
    stateFile: str("state-file", "SANDBOX_STATE_FILE") ?? path.join(os.homedir(), ".lambda-sandbox", "sandboxes.json"),
    tokenTtlMin,
    tokenRefreshMarginS: DEFAULTS.tokenRefreshMarginS,
    readyTimeoutS: num(env.SANDBOX_READY_TIMEOUT_S, DEFAULTS.readyTimeoutS, "ready timeout"),
    resumeWaitS: num(env.SANDBOX_RESUME_WAIT_S, DEFAULTS.resumeWaitS, "resume wait"),
  };
}

export function connectorArn(region: string, name: "ALL_INGRESS" | "NO_INGRESS" | "INTERNET_EGRESS" | "SHELL_INGRESS"): string {
  return `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${name}`;
}

/** Build the image ARN the server will use, given the caller's account. */
export function imageArnFor(config: Config, account: string): string {
  return config.imageArn ?? `arn:aws:lambda:${config.region}:${account}:microvm-image:${config.imageName}`;
}

export function setupHint(config: Config): string {
  const name = config.imageName === DEFAULTS.imageName ? "" : ` --image-name ${config.imageName}`;
  return `run \`npx lambda-microvm-sandbox-mcp setup --region ${config.region}${name}\` once to build it`;
}
