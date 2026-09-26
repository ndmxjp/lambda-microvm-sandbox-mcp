import type { ChildProcess } from "node:child_process";
import { timingSafeEqual } from "node:crypto";

export interface ExecUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export interface AgentOptions {
  apiPort: number;
  hookPort: number;
  bindAddress: string;
  workspace: string;
  /** Name of the non-root user to run commands as. Ignored when the agent is not root. */
  execUser: string | null;
  /** Pre-shared secret for local development only. In production it arrives via `/run`. */
  presetSecret: string | null;
  /** Directory for archive transfer temp files. */
  transferDir: string;
  /**
   * Unix socket on which the (root) agent accepts run-as-root requests from the
   * exec user. Backs the `sudo` shim, because the container runs with
   * no_new_privileges and real setuid sudo cannot work. null disables it.
   */
  rootSocket: string | null;
  version: string;
}

export class AgentState {
  readonly startedAt = Date.now();
  private secret: Buffer | null = null;
  apiReady = false;
  readonly running = new Set<ChildProcess>();
  /** Extra env from the run hook payload. */
  runEnv: Record<string, string> = {};
  readonly execUser: ExecUser | null;

  constructor(
    readonly options: AgentOptions,
    execUser: ExecUser | null,
  ) {
    this.execUser = execUser;
    if (options.presetSecret) this.setSecret(options.presetSecret);
  }

  get ready(): boolean {
    return this.secret !== null;
  }

  setSecret(secret: string): void {
    this.secret = Buffer.from(secret, "utf8");
  }

  checkSecret(candidate: string | undefined): boolean {
    if (this.secret === null || candidate === undefined) return false;
    const buf = Buffer.from(candidate, "utf8");
    if (buf.length !== this.secret.length) return false;
    return timingSafeEqual(buf, this.secret);
  }

  uptimeSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }
}
