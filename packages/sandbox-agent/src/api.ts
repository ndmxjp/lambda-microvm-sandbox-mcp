import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { HttpError, notFound } from "./errors.js";
import { runCommand } from "./executor.js";
import * as files from "./files.js";
import { readBody, readJson, sendError, sendJson } from "./http.js";
import { LIMITS, SECRET_HEADER, type HealthResponse } from "./protocol.js";
import type * as P from "./protocol.js";
import type { AgentState } from "./state.js";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

function json<TReq extends object, TRes>(fn: (body: TReq) => Promise<TRes>): Handler {
  return async (req, res) => {
    const body = await readJson<TReq>(req, LIMITS.jsonBodyBytes);
    sendJson(res, 200, await fn(body));
  };
}

export function createApiServer(state: AgentState): Server {
  const routes = new Map<string, Handler>();
  const route = (method: string, path: string, h: Handler): void => {
    routes.set(`${method} ${path}`, h);
  };

  route("GET", "/health", async (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      ready: state.ready,
      uptime_s: state.uptimeSeconds(),
      workspace: state.options.workspace,
      exec_user: state.execUser?.name ?? null,
      version: state.options.version,
    };
    sendJson(res, 200, body);
  });

  route("POST", "/exec", json((b: P.ExecRequest) => runCommand(state, b)));
  route("POST", "/files/read", json((b: P.ReadFileRequest) => files.readFile(state, b)));
  route("POST", "/files/write", json((b: P.WriteFileRequest) => files.writeFile(state, b)));
  route("POST", "/files/list", json((b: P.ListFilesRequest) => files.listFiles(state, b)));
  route("POST", "/files/delete", json((b: P.DeleteRequest) => files.deletePath(state, b)));
  route("POST", "/files/pull", json((b: P.PullRequest) => files.pull(state, b)));
  route("POST", "/files/push", json((b: P.PushRequest) => files.push(state, b)));

  route("POST", "/archive/upload/start", json((b: P.UploadStartRequest) => files.uploadStart(state, b)));
  route("PUT", "/archive/upload/chunk", async (req, res, url) => {
    const body = await readBody(req, LIMITS.chunkBytes);
    const out = await files.uploadChunk(url.searchParams.get("transfer_id"), url.searchParams.get("offset"), body);
    sendJson(res, 200, out);
  });
  route("POST", "/archive/upload/finish", json((b: P.UploadFinishRequest) => files.uploadFinish(state, b)));
  route("POST", "/archive/download/start", json((b: P.DownloadStartRequest) => files.downloadStart(state, b)));
  route("GET", "/archive/download/chunk", async (_req, res, url) => {
    const { stream, length } = files.downloadChunk(
      url.searchParams.get("transfer_id"),
      url.searchParams.get("offset") ?? undefined,
      url.searchParams.get("length") ?? undefined,
    );
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": length });
    await pipeline(stream, res);
  });
  route("POST", "/archive/download/finish", json((b: P.DownloadFinishRequest) => files.downloadFinish(b)));

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const handler = routes.get(`${req.method ?? "GET"} ${url.pathname}`);
        if (!handler) throw notFound(`no route for ${req.method} ${url.pathname}`);
        if (url.pathname !== "/health") {
          if (!state.ready) throw new HttpError(503, "not_ready", "run hook has not delivered the secret yet");
          const header = req.headers[SECRET_HEADER];
          const candidate = Array.isArray(header) ? header[0] : header;
          if (!state.checkSecret(candidate)) throw new HttpError(401, "unauthorized", "missing or invalid sandbox secret");
        }
        await handler(req, res, url);
      } catch (err) {
        if (!res.headersSent) sendError(res, err);
        else res.destroy();
      }
    })();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return server;
}
