import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgent, type RunningAgent } from "../src/index.js";
import { HOOK_PATH_PREFIX, SECRET_HEADER } from "../src/protocol.js";

export const TEST_SECRET = "test-secret-0123456789abcdef";

export interface TestAgent {
  agent: RunningAgent;
  workspace: string;
  api: string;
  hooks: string;
  rootSocket: string;
  /** Call an API route with the secret header. */
  call<T = unknown>(
    method: string,
    route: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; json: T }>;
  /** POST a lifecycle hook. */
  hook(name: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  /** Deliver the secret through the /run hook (what Lambda does after RunMicrovm). */
  deliverSecret(secret?: string, env?: Record<string, string>): Promise<void>;
  close(): Promise<void>;
}

export async function launchAgent(opts: { presetSecret?: string | null } = {}): Promise<TestAgent> {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-ws-")));
  const transferDir = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-xfer-")));
  const agent = await startAgent({
    apiPort: 0,
    hookPort: 0,
    bindAddress: "127.0.0.1",
    workspace,
    execUser: null,
    presetSecret: opts.presetSecret ?? null,
    transferDir,
    rootSocket: path.join(transferDir, "root.sock"),
    version: "test",
  });
  const api = `http://127.0.0.1:${agent.apiPort}`;
  const hooks = `http://127.0.0.1:${agent.hookPort}`;
  let secret = opts.presetSecret ?? TEST_SECRET;

  const t: TestAgent = {
    agent,
    workspace,
    api,
    hooks,
    rootSocket: path.join(transferDir, "root.sock"),
    async call(method, route, body, extraHeaders = {}) {
      const headers: Record<string, string> = { [SECRET_HEADER]: secret, ...extraHeaders };
      let payload: BodyInit | undefined;
      if (body instanceof Uint8Array) {
        headers["content-type"] = "application/octet-stream";
        payload = body as unknown as BodyInit;
      } else if (body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const res = await fetch(`${api}${route}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
      const ct = res.headers.get("content-type") ?? "";
      const json = ct.includes("json") ? await res.json() : await res.arrayBuffer();
      return { status: res.status, json: json as never };
    },
    async hook(name, body) {
      const res = await fetch(`${hooks}${HOOK_PATH_PREFIX}/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? "" : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    },
    async deliverSecret(s = TEST_SECRET, env) {
      secret = s;
      const r = await t.hook("run", { microvmId: "microvm-test", runHookPayload: JSON.stringify({ secret: s, env }) });
      if (r.status !== 200) throw new Error(`run hook failed: ${JSON.stringify(r.json)}`);
    },
    async close() {
      await agent.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(transferDir, { recursive: true, force: true });
    },
  };
  return t;
}
