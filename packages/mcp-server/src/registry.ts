import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SandboxRecord {
  sandbox_id: string;
  microvm_id: string;
  name: string | null;
  endpoint: string;
  secret: string;
  image_arn: string;
  image_version: string;
  created_at: string;
  /** Hard deadline after which Lambda terminates the VM. */
  expires_at: string;
  max_duration_s: number;
  /** Set when the VM was started with an execution role (CloudWatch logging). */
  execution_role_arn?: string;
}

interface RegistryFile {
  version: 1;
  sandboxes: Record<string, SandboxRecord>;
}

/**
 * Persists sandbox records (including the per-VM secret) so a restarted MCP
 * server can reconnect to running VMs. File is created with mode 0600.
 */
export class Registry {
  private data: RegistryFile = { version: 1, sandboxes: {} };

  constructor(private readonly file: string | null) {
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RegistryFile>;
      if (parsed.version === 1 && parsed.sandboxes && typeof parsed.sandboxes === "object") {
        this.data = { version: 1, sandboxes: parsed.sandboxes };
      }
    } catch (err) {
      console.error(`[lambda-sandbox] ignoring unreadable state file ${this.file}: ${String(err)}`);
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(id: string): SandboxRecord | undefined {
    return this.data.sandboxes[id];
  }

  require(id: string): SandboxRecord {
    const r = this.get(id);
    if (!r) throw new Error(`unknown sandbox_id "${id}" (run sandbox_list to see known sandboxes)`);
    return r;
  }

  all(): SandboxRecord[] {
    return Object.values(this.data.sandboxes).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  put(record: SandboxRecord): void {
    this.data.sandboxes[record.sandbox_id] = record;
    this.save();
  }

  remove(id: string): boolean {
    const had = id in this.data.sandboxes;
    delete this.data.sandboxes[id];
    if (had) this.save();
    return had;
  }
}
