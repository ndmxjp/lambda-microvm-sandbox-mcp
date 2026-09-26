import type { MicrovmApi } from "./aws.js";
import type { SandboxRecord } from "./registry.js";

export const SECRET_HEADER = "x-sandbox-secret";
export const PROXY_AUTH_HEADER = "x-aws-proxy-auth";
export const API_PORT = 8080;

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined = undefined,
    readonly code: string | undefined = undefined,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface ClientDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultDeps: ClientDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/** Mints and caches the Lambda auth token for one MicroVM, refreshing ahead of expiry. */
export class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private readonly ports = new Set<number>([API_PORT]);
  private portsChanged = false;

  constructor(
    private readonly api: MicrovmApi,
    private readonly microvmId: string,
    private readonly ttlMin: number,
    private readonly refreshMarginS: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Allow another VM port (for port forwarding). The next token covers it. */
  addPort(port: number): void {
    if (!this.ports.has(port)) {
      this.ports.add(port);
      this.portsChanged = true;
    }
  }

  allowedPorts(): number[] {
    return [...this.ports].sort((a, b) => a - b);
  }

  async get(): Promise<string> {
    if (this.token && !this.portsChanged && this.now() < this.expiresAt - this.refreshMarginS * 1000) return this.token;
    return this.refresh();
  }

  async refresh(): Promise<string> {
    const issuedAt = this.now();
    this.token = await this.api.createAuthToken(this.microvmId, this.ttlMin, this.allowedPorts());
    this.expiresAt = issuedAt + this.ttlMin * 60_000;
    this.portsChanged = false;
    return this.token;
  }

  /** Seconds until the cached token expires (0 when none). */
  secondsLeft(): number {
    return this.token ? Math.max(0, Math.round((this.expiresAt - this.now()) / 1000)) : 0;
  }
}

export interface RequestOptions {
  json?: unknown;
  body?: Uint8Array;
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
  /** Give up on 502/connection errors after this long (auto-resume window). */
  resumeWaitMs?: number;
}

const BACKOFF_MS = [500, 1000, 2000, 3000, 5000];

/** HTTP client for one sandbox: adds auth headers, retries while the VM resumes. */
export class SandboxClient {
  constructor(
    readonly record: SandboxRecord,
    readonly tokens: TokenManager,
    private readonly deps: ClientDeps,
    private readonly defaultResumeWaitMs: number,
  ) {}

  private url(path: string, query?: Record<string, string | number>): string {
    const u = new URL(path, this.record.endpoint.endsWith("/") ? this.record.endpoint : `${this.record.endpoint}/`);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async requestRaw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const deadline = this.deps.now() + (opts.resumeWaitMs ?? this.defaultResumeWaitMs);
    let attempt = 0;
    let refreshedToken = false;
    for (;;) {
      const headers: Record<string, string> = {
        [PROXY_AUTH_HEADER]: await this.tokens.get(),
        [SECRET_HEADER]: this.record.secret,
        ...(opts.headers ?? {}),
      };
      let body: RequestInit["body"] | undefined;
      if (opts.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.json);
      } else if (opts.body !== undefined) {
        headers["content-type"] = "application/octet-stream";
        body = opts.body as unknown as RequestInit["body"];
      }
      let res: Response | undefined;
      let netErr: unknown;
      try {
        res = await this.deps.fetch(this.url(path, opts.query), { method, headers, ...(body !== undefined ? { body } : {}) });
      } catch (err) {
        netErr = err;
      }
      // 403: token rejected (expired or revoked). Mint a new one once.
      if (res?.status === 403 && !refreshedToken) {
        refreshedToken = true;
        await this.tokens.refresh();
        continue;
      }
      // 502: Lambda could not reach the app, typically while a suspended VM auto-resumes.
      // 503 not_ready: agent up but /run not yet delivered. Both are worth waiting on.
      const retryable = netErr !== undefined || res?.status === 502 || res?.status === 503 || res?.status === 429;
      if (retryable && this.deps.now() < deadline) {
        await this.deps.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] as number);
        attempt++;
        continue;
      }
      if (netErr !== undefined) {
        throw new SandboxError(`could not reach sandbox ${this.record.sandbox_id}: ${String(netErr)}`);
      }
      return res as Response;
    }
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.requestRaw(method, path, opts);
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const err = parsed as { error?: string; message?: string } | undefined;
      const detail = err?.message ?? (text ? text.slice(0, 500) : res.statusText);
      throw new SandboxError(
        `sandbox ${this.record.sandbox_id}: ${method} ${path} -> ${res.status} ${err?.error ?? ""} ${detail}`.trim(),
        res.status,
        err?.error,
      );
    }
    return parsed as T;
  }

  async requestBytes(method: string, path: string, opts: RequestOptions = {}): Promise<Uint8Array> {
    const res = await this.requestRaw(method, path, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new SandboxError(`sandbox ${this.record.sandbox_id}: ${method} ${path} -> ${res.status} ${text.slice(0, 500)}`, res.status);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}
