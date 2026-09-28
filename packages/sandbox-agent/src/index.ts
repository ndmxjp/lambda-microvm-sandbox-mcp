import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiServer } from "./api.js";
import { createHookServer } from "./hooks.js";
import { sweepTransfers } from "./files.js";
import { listenRootRelay } from "./root-relay.js";
import type { Server as NetServer } from "node:net";
import { AgentState, type AgentOptions } from "./state.js";
import { isRoot, lookupUser } from "./users.js";
import { DEFAULT_API_PORT, DEFAULT_HOOK_PORT } from "./protocol.js";

export const AGENT_VERSION = "0.2.1";

export interface RunningAgent {
  apiPort: number;
  hookPort: number;
  state: AgentState;
  close(): Promise<void>;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentOptions {
  return {
    apiPort: Number(env.SANDBOX_API_PORT ?? DEFAULT_API_PORT),
    hookPort: Number(env.SANDBOX_HOOK_PORT ?? DEFAULT_HOOK_PORT),
    bindAddress: env.SANDBOX_BIND ?? "0.0.0.0",
    workspace: env.SANDBOX_WORKSPACE ?? "/workspace",
    execUser: env.SANDBOX_EXEC_USER === "" ? null : (env.SANDBOX_EXEC_USER ?? "sandbox"),
    presetSecret: env.SANDBOX_SECRET ?? null,
    transferDir: env.SANDBOX_TRANSFER_DIR ?? "/tmp/sandbox-agent/transfers",
    rootSocket: env.SANDBOX_ROOT_SOCKET === "" ? null : (env.SANDBOX_ROOT_SOCKET ?? "/run/sandbox-agent/root.sock"),
    version: AGENT_VERSION,
  };
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

export async function startAgent(options: AgentOptions): Promise<RunningAgent> {
  const execUser = options.execUser ? lookupUser(options.execUser) : null;
  if (options.execUser && !execUser && isRoot()) {
    console.error(`[sandbox-agent] warning: exec user "${options.execUser}" not found; commands will run as root`);
  }
  const state = new AgentState(options, execUser);
  const api = createApiServer(state);
  const hooks = createHookServer(state);
  const apiPort = await listen(api, options.apiPort, options.bindAddress);
  state.apiReady = true;
  const hookPort = await listen(hooks, options.hookPort, options.bindAddress);
  let relay: NetServer | null = null;
  if (options.rootSocket) {
    try {
      relay = await listenRootRelay(state, options.rootSocket);
    } catch (err) {
      console.error(`[sandbox-agent] root relay disabled: ${String(err)}`);
    }
  }
  const sweeper = setInterval(sweepTransfers, 60_000);
  sweeper.unref();
  console.error(
    `[sandbox-agent] v${options.version} api=${options.bindAddress}:${apiPort} hooks=${options.bindAddress}:${hookPort} ` +
      `workspace=${options.workspace} exec_user=${execUser?.name ?? "(current)"} root=${isRoot()} ` +
      `secret=${state.ready ? "preset" : "waiting for /run"} root_relay=${relay ? options.rootSocket : "off"}`,
  );
  return {
    apiPort,
    hookPort,
    state,
    async close() {
      clearInterval(sweeper);
      await Promise.all([closeServer(api), closeServer(hooks)]);
      if (relay) await new Promise<void>((r) => relay?.close(() => r()));
    },
  };
}

export type { AgentOptions } from "./state.js";
export { AgentState } from "./state.js";
