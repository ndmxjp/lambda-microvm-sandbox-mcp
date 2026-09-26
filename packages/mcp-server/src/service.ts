import { randomBytes, randomUUID } from "node:crypto";
import type { MicrovmApi, MicrovmInfo, TransferStore } from "./aws.js";
import { SandboxClient, SandboxError, TokenManager, defaultDeps, type ClientDeps } from "./client.js";
import { connectorArn, imageArnFor, setupHint, type Config } from "./config.js";
import type { Registry, SandboxRecord } from "./registry.js";
import { DEFAULT_EXCLUDES, downloadPath, uploadDirectory, type DownloadResult, type UploadResult } from "./transfer.js";
import { startPortForward, type PortForward } from "./forward.js";
import type * as P from "@lambda-microvm-sandbox/agent/protocol";

export interface ServiceDeps {
  config: Config;
  api: MicrovmApi;
  /** Caller's AWS account id, used to derive the image ARN when none is configured. */
  accountId: () => Promise<string>;
  registry: Registry;
  store?: TransferStore | null;
  client?: Partial<ClientDeps>;
  log?: (msg: string) => void;
}

export interface CreateOptions {
  name?: string;
  max_duration_s?: number;
  internet_egress?: boolean;
}

export interface SandboxSummary {
  sandbox_id: string;
  name: string | null;
  endpoint: string;
  state: string;
  state_reason?: string;
  created_at: string;
  expires_at: string;
  image_version: string;
  /** Active local port forwards (local URL -> VM port). */
  port_forwards?: Array<{ url: string; remote_port: number }>;
}

export interface PortForwardResult {
  sandbox_id: string;
  remote_port: number;
  local_port: number;
  url: string;
  note: string;
}

export interface CreateResult extends SandboxSummary {
  ready_after_ms: number;
  token_expires_in_s: number;
}

export interface ListResult {
  sandboxes: SandboxSummary[];
  /** MicroVMs in the account that this MCP server has no record of (started elsewhere). */
  unmanaged: Array<{ microvm_id: string; state: string; image_arn?: string; started_at?: string }>;
}

function iso(d: Date | undefined): string | undefined {
  return d ? d.toISOString() : undefined;
}

function normalizeEndpoint(endpoint: string | undefined, microvmId: string): string {
  if (!endpoint) throw new SandboxError(`RunMicrovm for ${microvmId} returned no endpoint`);
  return /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`;
}

/** Everything the MCP tools do, independent of the MCP transport so it can be tested directly. */
export class SandboxService {
  private readonly clients = new Map<string, SandboxClient>();
  private readonly clientDeps: ClientDeps;
  private readonly log: (msg: string) => void;
  private readonly store: { s3: TransferStore; prefix: string } | null;
  private imageArnCache: string | undefined;
  private readonly forwards = new Map<string, Map<number, PortForward>>();

  constructor(private readonly deps: ServiceDeps) {
    this.clientDeps = { ...defaultDeps, ...(deps.client ?? {}) };
    this.log = deps.log ?? ((m) => console.error(`[lambda-sandbox] ${m}`));
    this.store = deps.store ? { s3: deps.store, prefix: deps.config.transferPrefix } : null;
  }

  get config(): Config {
    return this.deps.config;
  }

  private client(id: string): SandboxClient {
    const existing = this.clients.get(id);
    if (existing) return existing;
    const record = this.deps.registry.require(id);
    const tokens = new TokenManager(
      this.deps.api,
      record.microvm_id,
      this.config.tokenTtlMin,
      this.config.tokenRefreshMarginS,
      this.clientDeps.now,
    );
    const client = new SandboxClient(record, tokens, this.clientDeps, this.config.resumeWaitS * 1000);
    this.clients.set(id, client);
    return client;
  }

  private summary(record: SandboxRecord, info?: Partial<MicrovmInfo>): SandboxSummary {
    const s: SandboxSummary = {
      sandbox_id: record.sandbox_id,
      name: record.name,
      endpoint: record.endpoint,
      state: info?.state ?? "UNKNOWN",
      created_at: record.created_at,
      expires_at: record.expires_at,
      image_version: record.image_version,
    };
    if (info?.stateReason) s.state_reason = info.stateReason;
    const fw = this.forwards.get(record.sandbox_id);
    if (fw && fw.size > 0) s.port_forwards = [...fw.values()].map((f) => ({ url: f.url, remote_port: f.remote_port }));
    return s;
  }

  /** Expose a port inside the sandbox as http://127.0.0.1:<local_port>. */
  async portForward(id: string, remotePort: number, localPort?: number): Promise<PortForwardResult> {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new SandboxError("remote_port must be 1-65535");
    if (remotePort === 9000) throw new SandboxError("port 9000 is the agent's lifecycle hook port and cannot be forwarded");
    const client = this.client(id);
    const existing = this.forwards.get(id)?.get(remotePort);
    if (existing) {
      return { sandbox_id: id, remote_port: remotePort, local_port: existing.local_port, url: existing.url, note: "already forwarding" };
    }
    client.tokens.addPort(remotePort);
    await client.tokens.get();
    const fw = await startPortForward({
      endpoint: client.record.endpoint,
      remotePort,
      ...(localPort !== undefined ? { localPort } : {}),
      getToken: () => client.tokens.get(),
      log: this.log,
    });
    if (!this.forwards.has(id)) this.forwards.set(id, new Map());
    this.forwards.get(id)!.set(remotePort, fw);
    return {
      sandbox_id: id,
      remote_port: remotePort,
      local_port: fw.local_port,
      url: fw.url,
      note: `The process inside the sandbox must listen on 0.0.0.0:${remotePort} (not 127.0.0.1). The forward lives as long as this MCP server runs.`,
    };
  }

  async stopPortForward(id: string, remotePort?: number): Promise<{ sandbox_id: string; stopped: number[] }> {
    const fw = this.forwards.get(id);
    if (!fw) return { sandbox_id: id, stopped: [] };
    const targets = remotePort === undefined ? [...fw.keys()] : fw.has(remotePort) ? [remotePort] : [];
    for (const p of targets) {
      await fw.get(p)?.close();
      fw.delete(p);
    }
    if (fw.size === 0) this.forwards.delete(id);
    return { sandbox_id: id, stopped: targets };
  }

  async resolveImageArn(): Promise<string> {
    if (this.imageArnCache) return this.imageArnCache;
    this.imageArnCache = this.config.imageArn ?? imageArnFor(this.config, await this.deps.accountId());
    return this.imageArnCache;
  }

  async resolveImageVersion(imageArn: string): Promise<string> {
    if (this.config.imageVersion) return this.config.imageVersion;
    let v: string | undefined;
    try {
      v = await this.deps.api.latestActiveImageVersion(imageArn);
    } catch (err) {
      if (/NotFound/i.test(String((err as { name?: string }).name ?? err))) {
        throw new SandboxError(`MicroVM image ${imageArn} does not exist; ${setupHint(this.config)}`);
      }
      throw err;
    }
    if (!v) throw new SandboxError(`image ${imageArn} has no ACTIVE version yet; ${setupHint(this.config)}`);
    return v;
  }

  async create(opts: CreateOptions = {}): Promise<CreateResult> {
    const cfg = this.config;
    const maxDuration = Math.min(opts.max_duration_s ?? cfg.maxDurationS, 28_800);
    const egress = opts.internet_egress ?? cfg.internetEgress;
    const imageArn = await this.resolveImageArn();
    const imageVersion = await this.resolveImageVersion(imageArn);
    const secret = randomBytes(32).toString("base64url");
    const payload: P.RunHookPayload = { secret };
    const started = this.clientDeps.now();

    const info = await this.deps.api.runMicrovm({
      imageArn,
      imageVersion,
      runHookPayload: JSON.stringify(payload),
      maximumDurationInSeconds: maxDuration,
      idlePolicy: { maxIdleDurationSeconds: cfg.idleS, suspendedDurationSeconds: cfg.suspendedS, autoResumeEnabled: true },
      ingressNetworkConnectors: [connectorArn(cfg.region, "ALL_INGRESS")],
      egressNetworkConnectors: egress ? [connectorArn(cfg.region, "INTERNET_EGRESS")] : [],
      clientToken: randomUUID(),
    });
    const createdAt = info.startedAt ?? new Date(started);
    const record: SandboxRecord = {
      sandbox_id: info.microvmId,
      microvm_id: info.microvmId,
      name: opts.name ?? null,
      endpoint: normalizeEndpoint(info.endpoint, info.microvmId),
      secret,
      image_arn: imageArn,
      image_version: imageVersion,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + maxDuration * 1000).toISOString(),
      max_duration_s: maxDuration,
    };
    this.deps.registry.put(record);
    this.log(`started ${record.sandbox_id} (${record.endpoint})`);

    try {
      await this.waitUntilReady(record.sandbox_id, cfg.readyTimeoutS * 1000);
    } catch (err) {
      // Do not leave a VM billing with nobody able to reach it.
      this.log(`sandbox ${record.sandbox_id} never became ready, terminating: ${String(err)}`);
      await this.deps.api.terminateMicrovm(record.microvm_id).catch(() => undefined);
      this.deps.registry.remove(record.sandbox_id);
      this.clients.delete(record.sandbox_id);
      throw err;
    }
    return {
      ...this.summary(record, { state: "RUNNING" }),
      ready_after_ms: this.clientDeps.now() - started,
      token_expires_in_s: this.client(record.sandbox_id).tokens.secondsLeft(),
    };
  }

  /** Poll /health until the agent reports the secret was delivered. */
  async waitUntilReady(id: string, timeoutMs: number): Promise<void> {
    const client = this.client(id);
    const deadline = this.clientDeps.now() + timeoutMs;
    let lastErr = "";
    while (this.clientDeps.now() < deadline) {
      try {
        const remaining = Math.max(1000, deadline - this.clientDeps.now());
        const h = await client.request<P.HealthResponse>("GET", "/health", { resumeWaitMs: Math.min(remaining, 15_000) });
        if (h.ready) return;
        lastErr = "agent up, waiting for /run hook";
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await this.clientDeps.sleep(500);
    }
    throw new SandboxError(`sandbox ${id} not ready after ${Math.round(timeoutMs / 1000)}s: ${lastErr}`);
  }

  async exec(id: string, req: P.ExecRequest): Promise<P.ExecResponse | P.BackgroundExecResponse> {
    return this.client(id).request<P.ExecResponse | P.BackgroundExecResponse>("POST", "/exec", {
      json: req,
      resumeWaitMs: this.config.resumeWaitS * 1000,
    });
  }

  async readFile(id: string, req: P.ReadFileRequest): Promise<P.ReadFileResponse> {
    return this.client(id).request("POST", "/files/read", { json: req });
  }

  async writeFile(id: string, req: P.WriteFileRequest): Promise<P.WriteFileResponse> {
    return this.client(id).request("POST", "/files/write", { json: req });
  }

  async listFiles(id: string, req: P.ListFilesRequest): Promise<P.ListFilesResponse> {
    return this.client(id).request("POST", "/files/list", { json: req });
  }

  async deletePath(id: string, req: P.DeleteRequest): Promise<P.DeleteResponse> {
    return this.client(id).request("POST", "/files/delete", { json: req });
  }

  async uploadDir(id: string, localPath: string, remotePath: string, exclude?: string[]): Promise<UploadResult> {
    return uploadDirectory(this.client(id), localPath, remotePath, exclude ?? DEFAULT_EXCLUDES, this.store);
  }

  async download(id: string, remotePath: string, localPath: string, exclude?: string[]): Promise<DownloadResult> {
    return downloadPath(this.client(id), remotePath, localPath, exclude ?? DEFAULT_EXCLUDES, this.store);
  }

  async suspend(id: string): Promise<SandboxSummary> {
    const record = this.deps.registry.require(id);
    const state = await this.deps.api.suspendMicrovm(record.microvm_id);
    return this.summary(record, { state });
  }

  async resume(id: string): Promise<SandboxSummary> {
    const record = this.deps.registry.require(id);
    const state = await this.deps.api.resumeMicrovm(record.microvm_id);
    return this.summary(record, { state });
  }

  async destroy(id: string): Promise<{ sandbox_id: string; state: string }> {
    const record = this.deps.registry.require(id);
    let state = "TERMINATED";
    try {
      state = await this.deps.api.terminateMicrovm(record.microvm_id);
    } catch (err) {
      // Already gone (8h limit, idle policy) is fine; anything else should surface.
      if (!/ResourceNotFound|not found|TERMINATED/i.test(String(err))) throw err;
    }
    await this.stopPortForward(id);
    this.deps.registry.remove(id);
    this.clients.delete(id);
    this.log(`terminated ${id}`);
    return { sandbox_id: id, state };
  }

  async status(id: string): Promise<SandboxSummary> {
    const record = this.deps.registry.require(id);
    const info = await this.deps.api.getMicrovm(record.microvm_id);
    return this.summary(record, info);
  }

  async list(): Promise<ListResult> {
    const remote = await this.deps.api.listMicrovms();
    const byId = new Map(remote.map((m) => [m.microvmId, m]));
    const sandboxes: SandboxSummary[] = [];
    for (const record of this.deps.registry.all()) {
      const m = byId.get(record.microvm_id);
      byId.delete(record.microvm_id);
      if (!m || m.state === "TERMINATED") {
        // Fetch the reason once so the agent can see why it disappeared, then forget it.
        let reason: string | undefined;
        try {
          reason = (await this.deps.api.getMicrovm(record.microvm_id)).stateReason;
        } catch {
          reason = undefined;
        }
        this.deps.registry.remove(record.sandbox_id);
        this.clients.delete(record.sandbox_id);
        sandboxes.push(
          this.summary(record, {
            state: "TERMINATED",
            stateReason: reason ?? "no longer listed by Lambda (max duration, idle policy or external terminate)",
          }),
        );
        continue;
      }
      sandboxes.push(this.summary(record, { state: m.state }));
    }
    const unmanaged = [...byId.values()]
      .filter((m) => m.state !== "TERMINATED")
      .map((m) => {
        const u: ListResult["unmanaged"][number] = { microvm_id: m.microvmId, state: m.state };
        if (m.imageArn) u.image_arn = m.imageArn;
        const s = iso(m.startedAt);
        if (s) u.started_at = s;
        return u;
      });
    return { sandboxes, unmanaged };
  }
}
