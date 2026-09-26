#!/usr/bin/env -S npx tsx
/**
 * Reproduce the "Resume lifecycle hook connection was refused" termination:
 * start a background server, let the VM idle-suspend, then talk to it again.
 * Streams the VM's logs to CloudWatch through an execution role so the agent's
 * own messages survive. Billable; needs --yes and --execution-role-arn.
 *
 *   npx tsx scripts/repro-idle-resume.ts --yes --region ap-northeast-1 --execution-role-arn arn:... [--idle 120]
 */
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { RealLogsApi, RealMicrovmApi } from "../packages/mcp-server/src/aws.ts";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { Registry } from "../packages/mcp-server/src/registry.ts";
import { SandboxService } from "../packages/mcp-server/src/service.ts";

const argv = process.argv.slice(2);
if (!argv.includes("--yes")) {
  console.error("this starts a billable MicroVM; pass --yes");
  process.exit(2);
}
const config = loadConfig(argv.filter((a) => a !== "--yes"));
if (!config.executionRoleArn) {
  console.error("pass --execution-role-arn so the VM logs reach CloudWatch");
  process.exit(2);
}
const sts = new STSClient({ region: config.region });
const service = new SandboxService({
  config,
  api: new RealMicrovmApi(config.region),
  accountId: async () => (await sts.send(new GetCallerIdentityCommand({}))).Account as string,
  registry: new Registry(null),
  logs: new RealLogsApi(config.region),
});
const log = (m: string): void => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let id: string | undefined;
try {
  const created = await service.create({ name: "repro-idle", max_duration_s: 2400 });
  id = created.sandbox_id;
  log(`created ${id} (idle ${config.idleS}s)`);
  const bg = await service.exec(id, { command: "python3 -m http.server 3000 --bind 0.0.0.0", background: true });
  log(`background: ${JSON.stringify(bg)}`);
  await sleep(2000);
  const probe = await service.exec(id, { command: "curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/" });
  log(`server answers: ${"stdout" in probe ? probe.stdout : "?"}`);

  // Wait past the idle window without touching the VM, watching its state via the control plane only.
  const waitS = config.idleS + 180;
  log(`waiting ${waitS}s for idle suspend (no traffic to the VM)...`);
  const deadline = Date.now() + waitS * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const st = await service.status(id);
    if (st.state !== last) {
      log(`state=${st.state}${st.state_reason ? ` (${st.state_reason})` : ""}`);
      last = st.state;
    }
    if (st.state === "TERMINATED") break;
    await sleep(30_000);
  }

  log("touching the VM again (auto-resume)...");
  const t0 = Date.now();
  try {
    const r = await service.exec(id, { command: "curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3000/; echo; uptime" });
    log(`after resume (${Date.now() - t0} ms): ${JSON.stringify(r)}`);
  } catch (err) {
    log(`exec after resume failed (${Date.now() - t0} ms): ${String(err)}`);
  }
  const st = await service.status(id);
  log(`final state=${st.state}${st.state_reason ? ` (${st.state_reason})` : ""}`);
  await sleep(15_000); // let CloudWatch catch up
  const logs = await service.vmLogs(id, 200);
  log(`--- CloudWatch ${logs.log_group} / ${logs.log_stream} (${logs.events.length} events)`);
  for (const e of logs.events) console.log(`  ${e.time} ${e.message}`);
} finally {
  if (id) {
    try {
      await service.destroy(id);
      log("destroyed");
    } catch (err) {
      log(`destroy: ${String(err)}`);
    }
  }
}
