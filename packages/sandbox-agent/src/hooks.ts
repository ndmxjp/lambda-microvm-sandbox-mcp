import { createServer, type Server } from "node:http";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { drainRunning, killRunning, runCommand } from "./executor.js";
import { readJson, sendError, sendJson } from "./http.js";
import { HttpError } from "./errors.js";
import { HOOK_PATH_PREFIX, LIMITS, type RunHookPayload } from "./protocol.js";
import type { AgentState } from "./state.js";

interface RunHookBody {
  microvmId?: string;
  runHookPayload?: string;
}

const log = (msg: string): void => console.error(`[sandbox-agent] hook: ${msg}`);

/**
 * Smoke-test the toolchain from the snapshot. Lambda samples what the VM
 * touches during /validate and prefetches it on later runs, so exercise the
 * things a coding agent will do first.
 */
export async function runValidation(state: AgentState): Promise<string[]> {
  const failures: string[] = [];
  const checks: Array<[string, string]> = [
    ["git", "git --version"],
    ["python3", "python3 -c 'import json, sys; print(sys.version)'"],
    ["node", "node -e 'console.log(process.version)'"],
    ["shell", "echo hello | tr a-z A-Z && pwd && ls -la"],
  ];
  for (const [name, command] of checks) {
    try {
      const r = await runCommand(state, { command, timeout_s: 30 });
      if ("background" in r) continue;
      if (r.exit_code !== 0) failures.push(`${name}: exit ${r.exit_code} ${r.stderr.trim()}`);
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const probe = path.join(state.options.workspace, ".sandbox-validate");
  try {
    await fsp.writeFile(probe, "ok");
    const back = await fsp.readFile(probe, "utf8");
    if (back !== "ok") failures.push("file roundtrip mismatch");
  } catch (err) {
    failures.push(`file roundtrip: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await fsp.rm(probe, { force: true });
  }
  return failures;
}

export function applyRunPayload(state: AgentState, body: RunHookBody): void {
  if (typeof body.runHookPayload !== "string" || body.runHookPayload.length === 0) {
    throw new HttpError(400, "bad_request", "runHookPayload is required");
  }
  let payload: RunHookPayload;
  try {
    payload = JSON.parse(body.runHookPayload) as RunHookPayload;
  } catch {
    throw new HttpError(400, "bad_request", "runHookPayload is not JSON");
  }
  if (typeof payload.secret !== "string" || payload.secret.length < 16) {
    throw new HttpError(400, "bad_request", "runHookPayload.secret must be a string of at least 16 chars");
  }
  state.setSecret(payload.secret);
  state.runEnv = payload.env && typeof payload.env === "object" ? { ...payload.env } : {};
}

export function createHookServer(state: AgentState): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method !== "POST" || !url.pathname.startsWith(`${HOOK_PATH_PREFIX}/`)) {
          throw new HttpError(404, "not_found", `no hook at ${req.method} ${url.pathname}`);
        }
        const hook = url.pathname.slice(HOOK_PATH_PREFIX.length + 1);
        switch (hook) {
          case "ready": {
            if (!state.apiReady) throw new HttpError(503, "not_ready", "api server not listening yet");
            log("ready");
            sendJson(res, 200, {});
            return;
          }
          case "validate": {
            const failures = await runValidation(state);
            if (failures.length > 0) {
              log(`validate failed: ${failures.join("; ")}`);
              throw new HttpError(500, "validate_failed", failures.join("; "));
            }
            log("validate ok");
            sendJson(res, 200, {});
            return;
          }
          case "run": {
            const body = await readJson<RunHookBody>(req, LIMITS.jsonBodyBytes);
            applyRunPayload(state, body);
            log(`run: microvmId=${body.microvmId ?? "?"} secret received`);
            sendJson(res, 200, {});
            return;
          }
          case "resume": {
            log("resume");
            sendJson(res, 200, {});
            return;
          }
          case "suspend": {
            const left = await drainRunning(state, 4000);
            log(`suspend (${left} commands still running)`);
            sendJson(res, 200, {});
            return;
          }
          case "terminate": {
            const n = killRunning(state, "SIGTERM");
            log(`terminate (signalled ${n} commands)`);
            sendJson(res, 200, {});
            return;
          }
          default:
            throw new HttpError(404, "not_found", `unknown hook ${hook}`);
        }
      } catch (err) {
        if (!res.headersSent) sendError(res, err);
        else res.destroy();
      }
    })();
  });
  return server;
}
