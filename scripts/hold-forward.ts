// Keep a port forward open for an existing sandbox (from the registry) until killed.
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { RealMicrovmApi } from "../packages/mcp-server/src/aws.ts";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { Registry } from "../packages/mcp-server/src/registry.ts";
import { SandboxService } from "../packages/mcp-server/src/service.ts";
const [sandboxId, remote, local] = process.argv.slice(2, 5);
const config = loadConfig(process.argv.slice(5));
const sts = new STSClient({ region: config.region });
const service = new SandboxService({
  config,
  api: new RealMicrovmApi(config.region),
  accountId: async () => (await sts.send(new GetCallerIdentityCommand({}))).Account as string,
  registry: new Registry(config.stateFile),
});
const fw = await service.portForward(sandboxId as string, Number(remote), Number(local));
console.log(`forwarding ${fw.url} -> ${sandboxId}:${remote}`);
await new Promise(() => undefined);
