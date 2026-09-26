import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { startPortForward, type PortForward } from "../src/forward.js";

/** Stands in for the MicroVM endpoint: requires the Lambda headers and echoes them. */
function fakeEndpoint(expectedToken: () => string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.headers["x-aws-proxy-auth"] !== expectedToken()) return void res.writeHead(403).end("bad token");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(
        JSON.stringify({
          port: req.headers["x-aws-proxy-port"],
          host: req.headers.host,
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString(),
          hasToken: Boolean(req.headers["x-aws-proxy-auth"]),
        }),
      );
    });
  });
  server.on("upgrade", (req, socket) => {
    const protos = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((s) => s.trim());
    const ok =
      protos.includes("lambda-microvms") &&
      protos.includes(`lambda-microvms.authentication.${expectedToken()}`) &&
      protos.includes("lambda-microvms.port.3000");
    if (!ok) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const app = protos.filter((p) => !p.startsWith("lambda-microvms"));
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: lambda-microvms, ${app.join(", ")}\r\n\r\n`,
    );
    socket.on("data", (d: Buffer) => socket.write(d)); // raw echo
    socket.on("end", () => socket.end()); // http upgrade sockets allow half-open; close when the peer does
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })),
  );
}

describe("port forward", () => {
  let endpoint: { server: Server; url: string };
  let fw: PortForward;
  let token = "tok-1";
  let tokenCalls = 0;

  beforeAll(async () => {
    endpoint = await fakeEndpoint(() => token);
    fw = await startPortForward({
      endpoint: endpoint.url,
      remotePort: 3000,
      getToken: async () => {
        tokenCalls++;
        return token;
      },
    });
  });
  afterAll(async () => {
    await fw.close();
    endpoint.server.closeAllConnections();
    await new Promise<void>((r) => endpoint.server.close(() => r()));
  });

  it("relays HTTP with the Lambda headers injected and upstream headers preserved", async () => {
    const res = await fetch(`${fw.url}/api/x?y=1`, { method: "POST", body: "hello", headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("yes");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.port).toBe("3000");
    expect(body.method).toBe("POST");
    expect(body.url).toBe("/api/x?y=1");
    expect(body.body).toBe("hello");
    expect(body.host).toBe("127.0.0.1");
    expect(tokenCalls).toBeGreaterThan(0);
  });

  it("uses the latest token for each request", async () => {
    token = "tok-2";
    const res = await fetch(`${fw.url}/`);
    expect(res.status).toBe(200);
  });

  it("tunnels WebSocket upgrades and hides the lambda subprotocols from the client", async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(fw.local_port, "127.0.0.1");
      let buf = "";
      sock.on("error", reject);
      sock.on("data", (d: Buffer) => {
        buf += d.toString("latin1");
        if (buf.includes("\r\n\r\n")) {
          sock.end();
          resolve(buf);
        }
      });
      sock.write(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n",
      );
    });
    expect(reply.startsWith("HTTP/1.1 101")).toBe(true);
    const protoLine = reply.split("\r\n").find((l) => /^sec-websocket-protocol/i.test(l));
    expect(protoLine).toBe("Sec-WebSocket-Protocol: vite-hmr");
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const dead = await startPortForward({ endpoint: "http://127.0.0.1:1", remotePort: 3000, getToken: async () => "t" });
    try {
      const res = await fetch(`${dead.url}/`);
      expect(res.status).toBe(502);
    } finally {
      await dead.close();
    }
  });
});
