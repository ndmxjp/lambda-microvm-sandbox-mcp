/**
 * Local port forwarding into a sandbox.
 *
 * Lambda routes traffic to the VM's port 8080 unless the request carries an
 * `X-aws-proxy-port` header, and every request needs `X-aws-proxy-auth`.
 * Browsers cannot add headers, so this starts a plain HTTP server on
 * 127.0.0.1 that injects them and relays to the MicroVM endpoint. WebSocket
 * upgrades are tunnelled too, using the subprotocol-based authentication
 * (`lambda-microvms.authentication.<token>`, `lambda-microvms.port.<n>`).
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";

export interface ForwardOptions {
  endpoint: string;
  remotePort: number;
  localPort?: number;
  getToken: () => Promise<string>;
  log?: (msg: string) => void;
}

export interface PortForward {
  local_port: number;
  remote_port: number;
  url: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function endpointParts(endpoint: string): { host: string; port: number; secure: boolean } {
  const u = new URL(endpoint);
  const secure = u.protocol === "https:";
  return { host: u.hostname, port: u.port ? Number(u.port) : secure ? 443 : 80, secure };
}

export async function startPortForward(opts: ForwardOptions): Promise<PortForward> {
  const { host, port, secure } = endpointParts(opts.endpoint);
  const log = opts.log ?? (() => undefined);
  const requestFn = secure ? httpsRequest : httpRequest;
  // Upgraded sockets leave the http.Server's bookkeeping, so track them to close cleanly.
  const tunnels = new Set<Socket>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let token: string;
      try {
        token = await opts.getToken();
      } catch (err) {
        res.writeHead(502, { "content-type": "text/plain" }).end(`port forward: cannot mint token: ${String(err)}`);
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
      }
      headers["host"] = host;
      headers["x-aws-proxy-auth"] = token;
      headers["x-aws-proxy-port"] = String(opts.remotePort);
      const upstream = requestFn({ host, port, method: req.method, path: req.url, headers }, (up) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && k !== "connection") outHeaders[k] = v;
        res.writeHead(up.statusCode ?? 502, outHeaders);
        up.pipe(res);
      });
      upstream.on("error", (err) => {
        log(`forward ${opts.remotePort}: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`port forward error: ${err.message}`);
      });
      req.pipe(upstream);
    })();
  });

  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    void (async () => {
      let token: string;
      try {
        token = await opts.getToken();
      } catch (err) {
        client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${String(err)}`);
        return;
      }
      const clientProtocols = (req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const protocols = [
        "lambda-microvms",
        `lambda-microvms.authentication.${token}`,
        `lambda-microvms.port.${opts.remotePort}`,
        ...clientProtocols,
      ];
      const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${host}`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "host" || k === "sec-websocket-protocol" || v === undefined) continue;
        lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      }
      lines.push(`Sec-WebSocket-Protocol: ${protocols.join(", ")}`);
      const upstream = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
      tunnels.add(client);
      tunnels.add(upstream);
      client.on("close", () => {
        tunnels.delete(client);
        upstream.destroy();
      });
      upstream.on("close", () => {
        tunnels.delete(upstream);
        client.destroy();
      });
      upstream.on("error", (err) => {
        log(`forward ws ${opts.remotePort}: ${err.message}`);
        client.destroy();
      });
      client.on("error", () => upstream.destroy());
      upstream.on("connect", () => upstream.write(`${lines.join("\r\n")}\r\n\r\n`));
      upstream.on("secureConnect", () => upstream.write(`${lines.join("\r\n")}\r\n\r\n`));
      // Read the upstream handshake, strip the lambda-* subprotocols the client
      // never asked for, then splice the sockets together.
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        upstream.off("data", onData);
        const rawHead = buf.subarray(0, end).toString("latin1");
        const rest = buf.subarray(end + 4);
        const headLines = rawHead.split("\r\n").map((l) => {
          const m = /^sec-websocket-protocol:\s*(.*)$/i.exec(l);
          if (!m) return l;
          const kept = m[1]!
            .split(",")
            .map((s) => s.trim())
            .filter((p) => p && !p.startsWith("lambda-microvms"));
          return kept.length ? `Sec-WebSocket-Protocol: ${kept.join(", ")}` : null;
        });
        client.write(`${headLines.filter((l) => l !== null).join("\r\n")}\r\n\r\n`);
        if (rest.length) client.write(rest);
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      };
      upstream.on("data", onData);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.localPort ?? 0, "127.0.0.1", () => resolve());
  });
  const localPort = (server.address() as AddressInfo).port;
  log(`forwarding http://127.0.0.1:${localPort} -> ${opts.endpoint} port ${opts.remotePort}`);
  return {
    local_port: localPort,
    remote_port: opts.remotePort,
    url: `http://127.0.0.1:${localPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of tunnels) s.destroy();
        tunnels.clear();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
