// Collect article evidence that `yarn install` for Excalidraw really runs inside a MicroVM:
// VM identity (kernel, DMI product, endpoint), the install log, and the CloudWatch stream.
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
const ex = async (id: string, command: string, timeout_s = 900) => {
  const r = await service.exec(id, { command, timeout_s });
  if ("background" in r) throw new Error("bg");
  return r;
};
const show = (title: string, body: string) => console.log(`\n### ${title}\n${body.trimEnd()}`);

let id: string | undefined;
try {
  const c = await service.create({ name: "evidence", max_duration_s: 1200 });
  id = c.sandbox_id;
  show("sandbox_create の結果", JSON.stringify(c, null, 2));
  const who = await ex(
    id,
    "hostname; uname -a; cat /sys/devices/virtual/dmi/id/product_name /sys/devices/virtual/dmi/id/sys_vendor 2>/dev/null; nproc; free -m | sed -n 2p; cat /etc/os-release | head -2; ip -4 -o addr show scope global | awk '{print $2, $4}'",
  );
  show("VM の中身（sandbox_exec）", who.stdout);
  const dmesg = await ex(id, "sudo dmesg 2>/dev/null | head -5");
  show("dmesg（起動ログの先頭）", dmesg.stdout || dmesg.stderr);
  const clone = await ex(id, "date -u +%FT%TZ; git clone --depth 1 https://github.com/excalidraw/excalidraw.git 2>&1 | tail -2");
  show("git clone", clone.stdout);
  const t0 = Date.now();
  const inst = await ex(
    id,
    "cd excalidraw && date -u +%FT%TZ && yarn install --frozen-lockfile 2>&1 | grep -vE 'warning' | tail -12 && date -u +%FT%TZ && echo \"host=$(hostname) pid=$$ user=$(whoami)\"",
    1200,
  );
  show(`yarn install（exit ${inst.exit_code}、${Math.round((Date.now() - t0) / 1000)} 秒）`, inst.stdout);
  await new Promise((r) => setTimeout(r, 20_000));
  const logs = await service.vmLogs(id, 50);
  show(`CloudWatch Logs ${logs.log_group} / ${logs.log_stream}`, logs.events.map((e) => `${e.time} ${e.message}`).join("\n"));
} finally {
  if (id) {
    const d = await service.destroy(id);
    show("sandbox_destroy", JSON.stringify(d));
  }
}
