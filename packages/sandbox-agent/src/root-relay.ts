import { chownSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { HttpError } from "./errors.js";
import { runProcess } from "./executor.js";
import type { RootRelayRequest, RootRelayResponse } from "./protocol.js";
import type { AgentState } from "./state.js";
import { isRoot } from "./users.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const debug = (msg: string): void => {
  if (process.env.SANDBOX_DEBUG) console.error(`[sandbox-agent] relay: ${msg}`);
};

/**
 * Equivalent of NOPASSWD sudo for the exec user. The container runs with the
 * no_new_privileges flag, so setuid binaries cannot elevate; instead the exec
 * user talks to this socket (mode 0660, group = exec user's group) and the root
 * agent runs the command on its behalf. Non-interactive only.
 */
export function createRootRelay(state: AgentState): Server {
  // allowHalfOpen: the client half-closes after sending its request; we must
  // still be able to write the reply afterwards.
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let handled = false;
    const reply = (res: RootRelayResponse): void => {
      if (handled) return;
      handled = true;
      conn.end(`${JSON.stringify(res)}\n`);
    };
    debug("connection");
    conn.on("data", (c: Buffer) => {
      debug(`data ${c.length}`);
      total += c.length;
      if (total > MAX_REQUEST_BYTES) return reply({ error: "payload_too_large", message: "request too large" });
      chunks.push(c);
    });
    conn.on("error", () => conn.destroy());
    conn.on("close", () => debug("close"));
    conn.on("end", () => {
      debug(`end, ${total} bytes`);
      void (async () => {
        let req: RootRelayRequest;
        try {
          req = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RootRelayRequest;
          if (!Array.isArray(req.argv) || req.argv.length === 0 || !req.argv.every((a) => typeof a === "string")) {
            throw new HttpError(400, "bad_request", "argv must be a non-empty string array");
          }
        } catch (err) {
          return reply({ error: "bad_request", message: err instanceof Error ? err.message : String(err) });
        }
        try {
          const res = await runProcess(state, req.argv, {
            as_root: true,
            ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
            ...(req.env !== undefined ? { env: req.env } : {}),
            ...(req.timeout_s !== undefined ? { timeout_s: req.timeout_s } : {}),
            ...(req.stdin !== undefined ? { stdin: Buffer.from(req.stdin, "base64") } : {}),
          });
          debug(`done exit=${res.exit_code}`);
          reply(res);
        } catch (err) {
          debug(`failed ${String(err)}`);
          if (err instanceof HttpError) reply({ error: err.code, message: err.message });
          else reply({ error: "internal", message: err instanceof Error ? err.message : String(err) });
        }
      })();
    });
  });
  return server;
}

export function listenRootRelay(state: AgentState, socketPath: string): Promise<Server> {
  const server = createRootRelay(state);
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o755 });
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      try {
        if (isRoot() && state.execUser) chownSync(socketPath, 0, state.execUser.gid);
        chmodSync(socketPath, 0o660);
      } catch (err) {
        console.error(`[sandbox-agent] could not set permissions on ${socketPath}: ${String(err)}`);
      }
      resolve(server);
    });
  });
}
