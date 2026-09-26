import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  type RunMicrovmCommandInput,
} from "@aws-sdk/client-lambda-microvms";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type MicrovmState = "PENDING" | "RUNNING" | "SUSPENDING" | "SUSPENDED" | "TERMINATING" | "TERMINATED" | string;

export interface MicrovmInfo {
  microvmId: string;
  state: MicrovmState;
  endpoint: string | undefined;
  imageArn: string | undefined;
  imageVersion: string | undefined;
  startedAt: Date | undefined;
  terminatedAt: Date | undefined;
  stateReason: string | undefined;
  maximumDurationInSeconds: number | undefined;
}

export interface MicrovmSummary {
  microvmId: string;
  state: MicrovmState;
  imageArn: string | undefined;
  imageVersion: string | undefined;
  startedAt: Date | undefined;
}

export interface RunMicrovmParams {
  imageArn: string;
  imageVersion: string;
  runHookPayload: string;
  maximumDurationInSeconds: number;
  idlePolicy: { maxIdleDurationSeconds: number; suspendedDurationSeconds: number; autoResumeEnabled: boolean };
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  clientToken: string;
}

/** The subset of the Lambda MicroVMs API the server uses. Swapped for a fake in tests. */
export interface MicrovmApi {
  runMicrovm(params: RunMicrovmParams): Promise<MicrovmInfo>;
  getMicrovm(id: string): Promise<MicrovmInfo>;
  listMicrovms(): Promise<MicrovmSummary[]>;
  suspendMicrovm(id: string): Promise<MicrovmState>;
  resumeMicrovm(id: string): Promise<MicrovmState>;
  terminateMicrovm(id: string): Promise<MicrovmState>;
  createAuthToken(id: string, expirationInMinutes: number, ports: number[]): Promise<string>;
  latestActiveImageVersion(imageArn: string): Promise<string | undefined>;
}

export interface TransferStore {
  presignPut(key: string, expiresS: number): Promise<string>;
  presignGet(key: string, expiresS: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

function req<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`AWS response is missing ${name}`);
  return v;
}

export class RealMicrovmApi implements MicrovmApi {
  private readonly client: LambdaMicrovmsClient;

  constructor(region: string) {
    this.client = new LambdaMicrovmsClient({ region });
  }

  async runMicrovm(p: RunMicrovmParams): Promise<MicrovmInfo> {
    const input: RunMicrovmCommandInput = {
      imageIdentifier: p.imageArn,
      imageVersion: p.imageVersion,
      runHookPayload: p.runHookPayload,
      maximumDurationInSeconds: p.maximumDurationInSeconds,
      idlePolicy: p.idlePolicy,
      ingressNetworkConnectors: p.ingressNetworkConnectors,
      egressNetworkConnectors: p.egressNetworkConnectors,
      clientToken: p.clientToken,
    };
    const r = await this.client.send(new RunMicrovmCommand(input));
    return {
      microvmId: req(r.microvmId, "microvmId"),
      state: req(r.state, "state"),
      endpoint: r.endpoint,
      imageArn: r.imageArn,
      imageVersion: r.imageVersion,
      startedAt: r.startedAt,
      terminatedAt: r.terminatedAt,
      stateReason: r.stateReason,
      maximumDurationInSeconds: r.maximumDurationInSeconds,
    };
  }

  async getMicrovm(id: string): Promise<MicrovmInfo> {
    const r = await this.client.send(new GetMicrovmCommand({ microvmIdentifier: id }));
    return {
      microvmId: req(r.microvmId, "microvmId"),
      state: req(r.state, "state"),
      endpoint: r.endpoint,
      imageArn: r.imageArn,
      imageVersion: r.imageVersion,
      startedAt: r.startedAt,
      terminatedAt: r.terminatedAt,
      stateReason: r.stateReason,
      maximumDurationInSeconds: r.maximumDurationInSeconds,
    };
  }

  async listMicrovms(): Promise<MicrovmSummary[]> {
    const out: MicrovmSummary[] = [];
    let nextToken: string | undefined;
    do {
      const r = await this.client.send(new ListMicrovmsCommand(nextToken ? { nextToken } : {}));
      for (const it of r.items ?? []) {
        if (!it.microvmId) continue;
        out.push({
          microvmId: it.microvmId,
          state: it.state ?? "UNKNOWN",
          imageArn: it.imageArn,
          imageVersion: it.imageVersion,
          startedAt: it.startedAt,
        });
      }
      nextToken = r.nextToken;
    } while (nextToken);
    return out;
  }

  async suspendMicrovm(id: string): Promise<MicrovmState> {
    await this.client.send(new SuspendMicrovmCommand({ microvmIdentifier: id }));
    return "SUSPENDING";
  }

  async resumeMicrovm(id: string): Promise<MicrovmState> {
    await this.client.send(new ResumeMicrovmCommand({ microvmIdentifier: id }));
    return "RUNNING";
  }

  async terminateMicrovm(id: string): Promise<MicrovmState> {
    await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
    return "TERMINATING";
  }

  async createAuthToken(id: string, expirationInMinutes: number, ports: number[]): Promise<string> {
    const r = await this.client.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: id,
        expirationInMinutes,
        allowedPorts: ports.map((port) => ({ port })),
      }),
    );
    const token = r.authToken?.["X-aws-proxy-auth"];
    if (!token) throw new Error("CreateMicrovmAuthToken returned no X-aws-proxy-auth value");
    return token;
  }

  async latestActiveImageVersion(imageArn: string): Promise<string | undefined> {
    const r = await this.client.send(new GetMicrovmImageCommand({ imageIdentifier: imageArn }));
    return r.latestActiveImageVersion;
  }
}

export class S3TransferStore implements TransferStore {
  private readonly client: S3Client;

  constructor(
    region: string,
    private readonly bucket: string,
  ) {
    this.client = new S3Client({ region });
  }

  presignPut(key: string, expiresS: number): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: "application/gzip" }), {
      expiresIn: expiresS,
    });
  }

  presignGet(key: string, expiresS: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresS });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
