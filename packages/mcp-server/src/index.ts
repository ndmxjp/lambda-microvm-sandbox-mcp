#!/usr/bin/env node
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { RealLogsApi, RealMicrovmApi, S3TransferStore } from "./aws.js";
import { RealSetupClients } from "./aws-setup.js";
import { loadConfig, parseArgs, USAGE, DEFAULTS } from "./config.js";
import { runDoctor } from "./doctor.js";
import { Registry } from "./registry.js";
import { createMcpServer } from "./server.js";
import { SandboxService } from "./service.js";
import { runSetup, SETUP_DEFAULTS } from "./setup.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Dockerfile + agent bundle shipped inside the npm package (copied at build time). */
export const IMAGE_DIR = join(here, "..", "image");

/** Region from the AWS profile / SDK defaults, without failing when none is set. */
async function sdkDefaultRegion(): Promise<string | undefined> {
  try {
    return await new STSClient({}).config.region();
  } catch {
    return undefined;
  }
}

function fail(msg: string, code = 2): never {
  console.error(`lambda-microvm-sandbox-mcp: ${msg}`);
  console.error(USAGE);
  process.exit(code);
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(`${question} [y/N] `, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    }),
  );
}

async function serve(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const config = loadConfig(argv, process.env, await sdkDefaultRegion());
  if (parsed.printConfig) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  const sts = new STSClient({ region: config.region });
  const service = new SandboxService({
    config,
    api: new RealMicrovmApi(config.region),
    accountId: async () => {
      const r = await sts.send(new GetCallerIdentityCommand({}));
      if (!r.Account) throw new Error("GetCallerIdentity returned no account");
      return r.Account;
    },
    registry: new Registry(config.stateFile),
    store: config.transferBucket ? new S3TransferStore(config.region, config.transferBucket) : null,
    logs: config.executionRoleArn ? new RealLogsApi(config.region) : null,
  });
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
  console.error(
    `[lambda-sandbox] ready (region=${config.region}, image=${config.imageArn ?? config.imageName}, state=${config.stateFile})`,
  );
}

async function setup(argv: string[]): Promise<void> {
  const { values } = parseArgs(argv);
  const str = (k: string): string | undefined => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  const region = str("region") ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? (await sdkDefaultRegion());
  if (!region) fail("setup needs a region: pass --region or set AWS_REGION");
  const bucket = str("bucket");
  const buildRoleArn = str("build-role-arn");
  const result = await runSetup(
    {
      region,
      imageName: str("image-name") ?? SETUP_DEFAULTS.imageName,
      ...(bucket ? { bucket } : {}),
      ...(buildRoleArn ? { buildRoleArn } : {}),
      buildRoleName: str("build-role-name") ?? SETUP_DEFAULTS.buildRoleName,
      executionRole: values["execution-role"] === true,
      executionRoleName: str("execution-role-name") ?? SETUP_DEFAULTS.executionRoleName,
      memoryMib: Number(str("memory-mib") ?? SETUP_DEFAULTS.memoryMib),
      skipImage: values["skip-image"] === true,
      dryRun: values["dry-run"] === true,
      yes: values["yes"] === true,
      timeoutMin: Number(str("timeout-min") ?? SETUP_DEFAULTS.timeoutMin),
      imageDir: IMAGE_DIR,
    },
    new RealSetupClients(region),
    { log: (m) => console.error(`[setup] ${m}`), confirm, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  );
  if (result.dryRun) {
    console.error("[setup] dry run: nothing was created");
    return;
  }
  if (result.imageVersion === "(skipped)") {
    console.error(`[setup] bucket and roles are ready${result.executionRoleArn ? `; execution role ${result.executionRoleArn}` : ""}`);
    return;
  }
  const nameFlag = result.imageArn.endsWith(`:${DEFAULTS.imageName}`) ? [] : ["--image-name", result.imageArn.split(":").pop() as string];
  const roleFlag = result.executionRoleArn ? ["--execution-role-arn", result.executionRoleArn] : [];
  console.log(`\nImage ${result.imageArn} version ${result.imageVersion} is ready.\n`);
  console.log("Add this to your agent's MCP configuration (Claude Code: .mcp.json / Kiro: .kiro/settings/mcp.json):\n");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "lambda-sandbox": {
            command: "npx",
            args: ["-y", "lambda-microvm-sandbox-mcp", "--region", region, ...nameFlag, ...roleFlag],
          },
        },
      },
      null,
      2,
    ),
  );
}

async function doctor(argv: string[]): Promise<void> {
  const config = loadConfig(argv, process.env, await sdkDefaultRegion());
  const ok = await runDoctor(config, (m) => console.log(m));
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
  const rest = command === "serve" && argv[0] !== "serve" ? argv : argv.slice(1);
  try {
    if (parseArgs(rest).help) {
      console.log(USAGE);
      return;
    }
    switch (command) {
      case "serve":
        return await serve(rest);
      case "setup":
        return await setup(rest);
      case "doctor":
        return await doctor(rest);
      default:
        fail(`unknown command "${command}"`);
    }
  } catch (err) {
    if (command === "serve" && /region|required|must be/i.test(String(err))) fail(err instanceof Error ? err.message : String(err));
    console.error(`lambda-microvm-sandbox-mcp ${command}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
