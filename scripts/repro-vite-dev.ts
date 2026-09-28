#!/usr/bin/env -S npx tsx
/**
 * Dev-server check: scaffold a Vite React app inside a sandbox, run `vite` in the
 * background, forward its port, and verify HTTP + HMR over WebSocket through the
 * forward, including a live update after editing a file. Billable; needs --yes.
 *
 *   npx tsx scripts/repro-vite-dev.ts --yes --region ap-northeast-1 [--keep]
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
const keep = argv.includes("--keep");
const config = loadConfig(argv.filter((a) => a !== "--yes" && a !== "--keep"));
const sts = new STSClient({ region: config.region });
const service = new SandboxService({
  config,
  api: new RealMicrovmApi(config.region),
  accountId: async () => (await sts.send(new GetCallerIdentityCommand({}))).Account as string,
  registry: new Registry(keep ? config.stateFile : null),
  logs: config.executionRoleArn ? new RealLogsApi(config.region) : null,
});
const log = (m: string): void => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ex = async (id: string, command: string, cwd?: string, timeout_s = 600) => {
  const r = await service.exec(id, { command, timeout_s, ...(cwd ? { cwd } : {}) });
  if ("background" in r) throw new Error("unexpected background result");
  return r;
};

let id: string | undefined;
try {
  const c = await service.create({ name: "vite-dev", max_duration_s: 1800 });
  id = c.sandbox_id;
  log(`created ${id} (ready in ${c.ready_after_ms} ms)`);

  const r = await ex(
    id,
    "npm create vite@latest hmr-demo -- --template react-ts 2>&1 | tail -3 && cd hmr-demo && npm install 2>&1 | tail -2",
    undefined,
    600,
  );
  log(`scaffold+install exit=${r.exit_code}\n${r.stdout.trim()}`);
  if (r.exit_code !== 0) throw new Error(r.stderr);

  // Requests arrive with the MicroVM endpoint as Host, so Vite's host check must allow it.
  await service.writeFile(id, {
    path: "hmr-demo/vite.config.ts",
    content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], server: { host: true, port: 5173, allowedHosts: true } });
`,
  });
  const bg = await service.exec(id, { command: "npx vite", cwd: "hmr-demo", background: true });
  if (!("background" in bg)) throw new Error("expected background");
  log(`vite started pid=${bg.pid} log=${bg.log_path}`);
  for (let i = 0; i < 30; i++) {
    const l = await service.readFile(id, { path: bg.log_path });
    if (/ready in|Local:/.test(l.content)) {
      log(`vite log:\n${l.content.trim()}`);
      break;
    }
    await sleep(1000);
  }

  const fw = await service.portForward(id, 5173);
  log(`forward ${fw.url}`);
  const page = await fetch(`${fw.url}/`);
  const html = await page.text();
  log(`GET / -> ${page.status}, has /@vite/client: ${html.includes("/@vite/client")}`);
  const mod = await fetch(`${fw.url}/src/App.tsx`);
  log(`GET /src/App.tsx (transformed by vite) -> ${mod.status} ${mod.headers.get("content-type")}`);

  // HMR websocket through the forward: expect {"type":"connected"}, then an update after editing App.tsx.
  const wsUrl = fw.url.replace("http://", "ws://");
  const messages: string[] = [];
  const ws = new WebSocket(`${wsUrl}/?token=${/"?token"?\s*[:=]\s*"([^"]+)"/.exec(html)?.[1] ?? ""}`, ["vite-hmr"]);
  const connected = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no HMR 'connected' message within 15s")), 15_000);
    ws.onopen = () => log(`ws open, protocol=${ws.protocol}`);
    ws.onerror = (e) => reject(new Error(`ws error ${String((e as { message?: string }).message ?? e)}`));
    ws.onmessage = (m) => {
      messages.push(String(m.data));
      if (String(m.data).includes('"connected"')) {
        clearTimeout(t);
        resolve(String(m.data));
      }
    };
  });
  log(`HMR handshake: ${connected}`);

  const updated = new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no HMR update within 20s")), 20_000);
    ws.onmessage = (m) => {
      messages.push(String(m.data));
      if (/"type":"(update|full-reload)"/.test(String(m.data))) {
        clearTimeout(t);
        resolve(String(m.data));
      }
    };
  });
  await sleep(1000);
  const app = await service.readFile(id, { path: "hmr-demo/src/App.tsx" });
  await service.writeFile(id, {
    path: "hmr-demo/src/App.tsx",
    content: app.content.replace("Vite + React", "Vite + React inside a MicroVM"),
  });
  log(`edited App.tsx -> HMR message: ${(await updated).slice(0, 200)}`);
  ws.close();

  if (keep) {
    log(`keeping sandbox ${id}; open ${fw.url} in a browser. Destroy with sandbox_destroy.`);
    await new Promise(() => undefined);
  }
} finally {
  if (id && !keep) {
    await service.destroy(id);
    log("destroyed");
  }
}
