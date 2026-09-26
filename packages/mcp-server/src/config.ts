import os from "node:os";
import path from "node:path";

export interface Config {
  region: string;
  imageArn: string;
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

export const USAGE = `lambda-microvm-sandbox-mcp [options]

Options (each also settable via the environment variable in parentheses):
  --image-arn <arn>          MicroVM image ARN (SANDBOX_IMAGE_ARN)          [required]
  --image-version <ver>      Image version, e.g. 1.0 (SANDBOX_IMAGE_VERSION) [default: latest ACTIVE]
  --region <region>          Override the region taken from the image ARN
  --max-duration <sec>       maximumDurationInSeconds (SANDBOX_MAX_DURATION_S) [default: ${DEFAULTS.maxDurationS}]
  --idle <sec>               idlePolicy.maxIdleDurationSeconds (SANDBOX_IDLE_S) [default: ${DEFAULTS.idleS}]
  --suspended <sec>          idlePolicy.suspendedDurationSeconds (SANDBOX_SUSPENDED_S) [default: ${DEFAULTS.suspendedS}]
  --no-internet-egress       Do not attach INTERNET_EGRESS (SANDBOX_INTERNET_EGRESS=false)
  --transfer-bucket <name>   S3 bucket for large transfers (SANDBOX_TRANSFER_BUCKET) [default: direct chunked transfer]
  --state-file <path>        Sandbox registry (SANDBOX_STATE_FILE) [default: ~/.lambda-sandbox/sandboxes.json]
  --token-ttl <min>          Auth token lifetime 1-60 (SANDBOX_TOKEN_TTL_MIN) [default: ${DEFAULTS.tokenTtlMin}]
  --print-config             Print the resolved configuration and exit
  -h, --help                 Show this help
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

export function loadConfig(argv: string[] = [], env: NodeJS.ProcessEnv = process.env): Config {
  const { values } = parseArgs(argv);
  const str = (k: string, e: string): string | undefined => {
    const v = values[k];
    if (typeof v === "string") return v;
    const ev = env[e];
    return ev === "" ? undefined : ev;
  };
  const imageArn = str("image-arn", "SANDBOX_IMAGE_ARN");
  if (!imageArn) throw new Error("SANDBOX_IMAGE_ARN (or --image-arn) is required");
  // The image ARN decides the region: MicroVMs must be run where the image lives.
  // --region only overrides it explicitly; AWS_REGION is a fallback for odd ARNs.
  const explicitRegion = typeof values["region"] === "string" ? (values["region"] as string) : undefined;
  const region = explicitRegion ?? regionFromArn(imageArn) ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("could not determine region; set --region");
  const egressFlag = values["internet-egress"];
  const internetEgress =
    typeof egressFlag === "boolean" ? egressFlag : env.SANDBOX_INTERNET_EGRESS === undefined ? DEFAULTS.internetEgress : env.SANDBOX_INTERNET_EGRESS !== "false";
  const tokenTtlMin = num(str("token-ttl", "SANDBOX_TOKEN_TTL_MIN"), DEFAULTS.tokenTtlMin, "token ttl");
  if (tokenTtlMin > 60) throw new Error("token ttl must be 60 minutes or less");
  const maxDurationS = num(str("max-duration", "SANDBOX_MAX_DURATION_S"), DEFAULTS.maxDurationS, "max duration");
  if (maxDurationS > 28_800) throw new Error("max duration must be 28800 seconds (8 hours) or less");
  return {
    region,
    imageArn,
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
