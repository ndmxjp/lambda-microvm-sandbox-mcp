import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createTlsServer, type Server as TlsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { startPortForward, type PortForward } from "../src/forward.js";

/**
 * The real MicroVM endpoint is HTTPS. A TLS socket emits both "connect" and
 * "secureConnect"; an earlier version wrote the WebSocket handshake on both,
 * so the app received the request twice and the second copy arrived as a bogus
 * frame with RSV1 set ("G" = 0x47), crashing ws-based servers such as Vite.
 * This test drives the forward against a self-signed HTTPS endpoint and counts
 * what the endpoint actually receives.
 */
describe("port forward over TLS", () => {
  let server: TlsServer;
  let fw: PortForward;
  const upgrades: string[] = [];
  const framesAfterHandshake: Buffer[] = [];
  let http502sBeforeOk = 0;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fw-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${dir}/key.pem`,
        "-out",
        `${dir}/cert.pem`,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const ca = readFileSync(`${dir}/cert.pem`, "utf8");
    server = createTlsServer({ key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) }, (req, res) => {
      if (req.url === "/resuming" && http502sBeforeOk > 0) {
        http502sBeforeOk--;
        res.writeHead(502).end("resuming");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end(`ok ${req.headers["x-aws-proxy-port"]}`);
    });
    server.on("upgrade", (req, socket) => {
      upgrades.push(req.url ?? "");
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: lambda-microvms, vite-hmr\r\n\r\n`,
      );
      socket.on("data", (d: Buffer) => framesAfterHandshake.push(Buffer.from(d)));
      socket.on("end", () => socket.end());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    fw = await startPortForward({
      endpoint: `https://127.0.0.1:${(server.address() as { port: number }).port}`,
      remotePort: 5173,
      getToken: async () => "tok",
      ca,
      resumeWaitMs: 10_000,
    });
  });
  afterAll(async () => {
    await fw.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("relays HTTPS requests", async () => {
    const res = await fetch(`${fw.url}/x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok 5173");
  });

  it("retries idempotent requests that get 502 while the VM resumes", async () => {
    http502sBeforeOk = 2;
    const started = Date.now();
    const res = await fetch(`${fw.url}/resuming`);
    expect(res.status).toBe(200);
    expect(http502sBeforeOk).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it("sends the WebSocket handshake exactly once and relays only real frames", async () => {
    await new Promise<void>((resolve, reject) => {
      const sock = connect(fw.local_port, "127.0.0.1");
      let buf = "";
      sock.on("error", reject);
      sock.on("data", (d: Buffer) => {
        buf += d.toString("latin1");
        if (buf.includes("\r\n\r\n")) {
          expect(buf.startsWith("HTTP/1.1 101")).toBe(true);
          // one masked text frame "hi" from the client
          sock.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x68 ^ 1, 0x69 ^ 2]));
          setTimeout(() => {
            sock.end();
            resolve();
          }, 300);
        }
      });
      sock.write(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n",
      );
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(upgrades).toEqual(["/ws"]);
    const received = Buffer.concat(framesAfterHandshake);
    // Only our 8-byte frame; no stray "GET ..." bytes (0x47 would have RSV1 set).
    expect(received.length).toBe(8);
    expect(received[0]).toBe(0x81);
    expect(received[0]! & 0x40).toBe(0);
  });
});
