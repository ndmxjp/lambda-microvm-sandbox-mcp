import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors.js";
import type { ErrorResponse } from "./protocol.js";

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "payload_too_large", `body exceeds ${limit} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new HttpError(413, "payload_too_large", `body exceeds ${limit} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(req: IncomingMessage, limit: number): Promise<T> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {} as T;
  try {
    const parsed: unknown = JSON.parse(buf.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "bad_request", "body must be a JSON object");
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "bad_request", "body is not valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  res.end(data);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    const body: ErrorResponse = { error: err.code, message: err.message };
    sendJson(res, err.status, body);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[sandbox-agent] unhandled error:", err);
  const body: ErrorResponse = { error: "internal", message };
  sendJson(res, 500, body);
}
