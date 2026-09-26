// Reproduce the Excalidraw scenario with CloudWatch logging: build, serve, port-forward,
// let the VM idle-suspend, then trigger auto-resume through the forwarded port (like a browser would).
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { RealLogsApi, RealMicrovmApi } from "../packages/mcp-server/src/aws.ts";
import { loadConfig } from "../packages/mcp-server/src/config.ts";
import { Registry } from "../packages/mcp-server/src/registry.ts";
import { SandboxService } from "../packages/mcp-server/src/service.ts";

const config = loadConfig(process.argv.slice(2));
const sts = new STSClient({ region: config.region });
const service = new SandboxService({
  config,
  api: new RealMicrovmApi(config.region),
  accountId: async () => (await sts.send(new GetCallerIdentityCommand({}))).Account as string,
  registry: new Registry(null),
  logs: new RealLogsApi(config.region),
});
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ex = async (id: string, command: string, timeout_s = 600) => {
  const r = await service.exec(id, { command, timeout_s });
  if ("background" in r) throw new Error("bg");
  return r;
};

let id: string | undefined;
try {
  const c = await service.create({ name: "repro-excalidraw", max_duration_s: 3000 });
  id = c.sandbox_id;
  log(`created ${id}`);
  let r = await ex(id, "git clone --depth 1 https://github.com/excalidraw/excalidraw.git 2>&1 | tail -1");
  log(`clone exit=${r.exit_code}`);
  r = await ex(id, "cd excalidraw && yarn install --frozen-lockfile 2>&1 | tail -2", 1200);
  log(`install exit=${r.exit_code} ${r.stdout.trim().slice(-80)}`);
  r = await ex(id, "cd excalidraw && yarn build:app 2>&1 | tail -3; free -m | head -2", 1200);
  log(`build exit=${r.exit_code}\n${r.stdout}`);
  const bg = await service.exec(id, {
    command: "python3 -m http.server 3000 --bind 0.0.0.0",
    cwd: "excalidraw/excalidraw-app/build",
    background: true,
  });
  log(`bg ${JSON.stringify(bg)}`);
  await sleep(2000);
  const fw = await service.portForward(id, 3000);
  log(`forward ${fw.url}`);
  const res = await fetch(`${fw.url}/`);
  log(`via forward: ${res.status} ${(await res.text()).includes("Excalidraw") ? "excalidraw ok" : "?"}`);
  const waitS = config.idleS + 150;
  log(`idle wait ${waitS}s`);
  const deadline = Date.now() + waitS * 1000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const st = await service.status(id);
      if (st.state !== last) {
        log(`state=${st.state}${st.state_reason ? ` (${st.state_reason})` : ""}`);
        last = st.state;
      }
      if (st.state === "TERMINATED") break;
    } catch (e) {
      log(`status poll failed (transient?): ${String(e).slice(0, 120)}`);
    }
    await sleep(20_000);
  }
  log("resume via forwarded port 3000 (browser-like)...");
  const t0 = Date.now();
  try {
    const r2 = await fetch(`${fw.url}/`);
    log(`forward after suspend: ${r2.status} in ${Date.now() - t0} ms`);
  } catch (e) {
    log(`forward fetch failed: ${String(e)}`);
  }
  await sleep(5000);
  const st = await service.status(id);
  log(`state=${st.state}${st.state_reason ? ` (${st.state_reason})` : ""}`);
  try {
    const r3 = await ex(id, "uptime; ps -o pid,rss,cmd -p 1 | tail -1");
    log(`exec after: ${JSON.stringify(r3.stdout)}`);
  } catch (e) {
    log(`exec after failed: ${String(e).slice(0, 200)}`);
  }
  await sleep(20_000);
  try {
    const logs = await service.vmLogs(id, 200);
    log(`--- ${logs.log_stream}`);
    for (const e of logs.events) console.log(`  ${e.time} ${e.message}`);
  } catch (e) {
    log(`vm logs: ${String(e)}`);
  }
} finally {
  for (let attempt = 1; id && attempt <= 5; attempt++) {
    try {
      await service.destroy(id);
      log("destroyed");
      break;
    } catch (e) {
      log(`destroy attempt ${attempt}: ${String(e).slice(0, 120)}`);
      await sleep(10_000);
    }
  }
}
