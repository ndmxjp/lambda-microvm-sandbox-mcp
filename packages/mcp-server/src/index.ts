#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RealMicrovmApi, S3TransferStore } from "./aws.js";
import { loadConfig, parseArgs, USAGE } from "./config.js";
import { Registry } from "./registry.js";
import { createMcpServer } from "./server.js";
import { SandboxService } from "./service.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    console.error(USAGE);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  let config;
  try {
    config = loadConfig(argv);
  } catch (err) {
    console.error(`lambda-microvm-sandbox-mcp: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (parsed.printConfig) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  const service = new SandboxService({
    config,
    api: new RealMicrovmApi(config.region),
    registry: new Registry(config.stateFile),
    store: config.transferBucket ? new S3TransferStore(config.region, config.transferBucket) : null,
  });
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[lambda-sandbox] ready (region=${config.region}, image=${config.imageArn}, state=${config.stateFile})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
