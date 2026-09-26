import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgent, type RunningAgent } from "@lambda-microvm-sandbox/agent";
import type { MicrovmApi, MicrovmInfo, MicrovmSummary, RunMicrovmParams, TransferStore } from "../src/aws.js";

interface FakeVm {
  info: MicrovmInfo;
  agent: RunningAgent | null;
  workspace: string;
  transferDir: string;
  payload: string;
}

/**
 * Stands in for the Lambda MicroVMs control plane: RunMicrovm launches a real
 * sandbox-agent in-process and delivers the run hook the way Lambda would.
 */
export class FakeMicrovmApi implements MicrovmApi {
  readonly vms = new Map<string, FakeVm>();
  tokenCalls = 0;
  runCalls: RunMicrovmParams[] = [];
  latestVersion: string | undefined = "1.0";
  /** Delay before the run hook is delivered, to exercise the ready wait. */
  runHookDelayMs = 50;
  private counter = 0;

  async runMicrovm(p: RunMicrovmParams): Promise<MicrovmInfo> {
    this.runCalls.push(p);
    const id = `microvm-${++this.counter}`;
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "fake-vm-ws-")));
    const transferDir = realpathSync(mkdtempSync(path.join(tmpdir(), "fake-vm-xfer-")));
    const agent = await startAgent({
      apiPort: 0,
      hookPort: 0,
      bindAddress: "127.0.0.1",
      workspace,
      execUser: null,
      presetSecret: null,
      transferDir,
      rootSocket: null,
      version: "fake",
    });
    const info: MicrovmInfo = {
      microvmId: id,
      state: "PENDING",
      endpoint: `http://127.0.0.1:${agent.apiPort}`,
      imageArn: p.imageArn,
      imageVersion: p.imageVersion,
      startedAt: new Date(),
      terminatedAt: undefined,
      stateReason: undefined,
      maximumDurationInSeconds: p.maximumDurationInSeconds,
    };
    const vm: FakeVm = { info, agent, workspace, transferDir, payload: p.runHookPayload };
    this.vms.set(id, vm);
    setTimeout(() => {
      void fetch(`http://127.0.0.1:${agent.hookPort}/aws/lambda-microvms/runtime/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ microvmId: id, runHookPayload: p.runHookPayload }),
      }).then(() => {
        vm.info.state = "RUNNING";
      });
    }, this.runHookDelayMs);
    return { ...info };
  }

  async getMicrovm(id: string): Promise<MicrovmInfo> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`ResourceNotFoundException: ${id}`);
    return { ...vm.info };
  }

  async listMicrovms(): Promise<MicrovmSummary[]> {
    return [...this.vms.values()].map((vm) => ({
      microvmId: vm.info.microvmId,
      state: vm.info.state,
      imageArn: vm.info.imageArn,
      imageVersion: vm.info.imageVersion,
      startedAt: vm.info.startedAt,
    }));
  }

  async suspendMicrovm(id: string): Promise<string> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`ResourceNotFoundException: ${id}`);
    vm.info.state = "SUSPENDED";
    return "SUSPENDING";
  }

  async resumeMicrovm(id: string): Promise<string> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`ResourceNotFoundException: ${id}`);
    vm.info.state = "RUNNING";
    return "RUNNING";
  }

  async terminateMicrovm(id: string): Promise<string> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`ResourceNotFoundException: ${id}`);
    vm.info.state = "TERMINATED";
    vm.info.stateReason = "Terminated by user";
    await vm.agent?.close();
    vm.agent = null;
    return "TERMINATING";
  }

  async createAuthToken(id: string, expirationInMinutes: number): Promise<string> {
    this.tokenCalls++;
    return `fake-token-${id}-${expirationInMinutes}-${this.tokenCalls}`;
  }

  async latestActiveImageVersion(): Promise<string | undefined> {
    return this.latestVersion;
  }

  /** Simulate Lambda killing a VM (max duration reached). */
  async expire(id: string, reason: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) return;
    vm.info.state = "TERMINATED";
    vm.info.stateReason = reason;
    await vm.agent?.close();
    vm.agent = null;
  }

  async cleanup(): Promise<void> {
    for (const vm of this.vms.values()) {
      await vm.agent?.close();
      rmSync(vm.workspace, { recursive: true, force: true });
      rmSync(vm.transferDir, { recursive: true, force: true });
    }
    this.vms.clear();
  }
}

/** In-memory stand-in for S3 presigned URLs, backed by a tiny HTTP server. */
export class FakeTransferStore implements TransferStore {
  constructor(readonly baseUrl: string) {}
  async presignPut(key: string): Promise<string> {
    return `${this.baseUrl}/${key}`;
  }
  async presignGet(key: string): Promise<string> {
    return `${this.baseUrl}/${key}`;
  }
  async deleteObject(): Promise<void> {}
}
