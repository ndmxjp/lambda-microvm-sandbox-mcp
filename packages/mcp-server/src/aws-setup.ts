import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
  ListMicrovmImageVersionsCommand,
  UpdateMicrovmImageCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CreateRoleCommand, GetRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { HOOKS, type ImageBuildInput, type SetupClients } from "./setup.js";

function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string }).name ?? "";
  return /NotFound|NoSuchEntity|ResourceNotFound|NoSuchBucket/.test(name) || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
}

export class RealSetupClients implements SetupClients {
  private readonly microvms: LambdaMicrovmsClient;
  private readonly s3: S3Client;
  private readonly iam: IAMClient;
  private readonly sts: STSClient;
  private readonly logs: CloudWatchLogsClient;

  constructor(private readonly region: string) {
    this.microvms = new LambdaMicrovmsClient({ region });
    this.s3 = new S3Client({ region });
    this.iam = new IAMClient({ region });
    this.sts = new STSClient({ region });
    this.logs = new CloudWatchLogsClient({ region });
  }

  async accountId(): Promise<string> {
    const r = await this.sts.send(new GetCallerIdentityCommand({}));
    if (!r.Account) throw new Error("GetCallerIdentity returned no account id");
    return r.Account;
  }

  async regionSupported(): Promise<boolean> {
    try {
      await this.microvms.send(new ListManagedMicrovmImagesCommand({}));
      return true;
    } catch (err) {
      if (/ENOTFOUND|UnknownEndpoint|EndpointError|getaddrinfo/i.test(String(err))) return false;
      throw err;
    }
  }

  async bucketExists(name: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: name }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async createBucket(name: string): Promise<void> {
    await this.s3.send(
      new CreateBucketCommand({
        Bucket: name,
        ...(this.region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: this.region as never } }),
      }),
    );
  }

  async hardenBucket(name: string): Promise<void> {
    await this.s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: name,
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
      }),
    );
    await this.s3.send(
      new PutBucketEncryptionCommand({
        Bucket: name,
        ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: true }] },
      }),
    );
    await this.s3.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: name,
        LifecycleConfiguration: {
          Rules: [
            { ID: "expire-image-artifacts", Status: "Enabled", Filter: { Prefix: "microvm-images/" }, Expiration: { Days: 30 } },
            { ID: "expire-transfers", Status: "Enabled", Filter: { Prefix: "lambda-sandbox-transfers/" }, Expiration: { Days: 1 } },
            { ID: "abort-multipart", Status: "Enabled", Filter: { Prefix: "" }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
          ],
        },
      }),
    );
  }

  async putObject(bucket: string, key: string, body: Uint8Array): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/zip" }));
  }

  async getRoleArn(name: string): Promise<string | undefined> {
    try {
      const r = await this.iam.send(new GetRoleCommand({ RoleName: name }));
      return r.Role?.Arn;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async createRole(name: string, trust: string, policy: string): Promise<string> {
    const r = await this.iam.send(
      new CreateRoleCommand({
        RoleName: name,
        AssumeRolePolicyDocument: trust,
        Description: "Build role for lambda-microvm-sandbox-mcp MicroVM images",
        Tags: [{ Key: "ManagedBy", Value: "lambda-microvm-sandbox-mcp" }],
      }),
    );
    await this.iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: "MicrovmImageBuild", PolicyDocument: policy }));
    const arn = r.Role?.Arn;
    if (!arn) throw new Error("CreateRole returned no ARN");
    return arn;
  }

  async imageExists(imageArn: string): Promise<boolean> {
    try {
      await this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier: imageArn }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  private common(input: ImageBuildInput) {
    return {
      baseImageArn: input.baseImageArn,
      buildRoleArn: input.buildRoleArn,
      codeArtifact: { uri: input.codeArtifactUri },
      resources: [{ minimumMemoryInMiB: input.memoryMib }],
      cpuConfigurations: [{ architecture: "ARM_64" as const }],
      egressNetworkConnectors: [`arn:aws:lambda:${input.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`],
      hooks: HOOKS,
      description: input.description,
      tags: { ManagedBy: "lambda-microvm-sandbox-mcp" },
    };
  }

  async createImage(input: ImageBuildInput): Promise<void> {
    await this.microvms.send(new CreateMicrovmImageCommand({ name: input.name, ...this.common(input) }));
  }

  async updateImage(input: ImageBuildInput): Promise<string> {
    const { tags: _tags, ...rest } = this.common(input);
    await this.microvms.send(new UpdateMicrovmImageCommand({ imageIdentifier: input.imageArn, ...rest }));
    const vs = await this.microvms.send(new ListMicrovmImageVersionsCommand({ imageIdentifier: input.imageArn }));
    const newest = (vs.items ?? [])
      .map((v) => v.imageVersion ?? "0.0")
      .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]))[0];
    if (!newest) throw new Error("UpdateMicrovmImage succeeded but no versions are listed");
    return newest;
  }

  async getVersionState(imageArn: string, version: string): Promise<{ state: string; reason?: string }> {
    const r = await this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: version }));
    return { state: String(r.state), ...(r.stateReason ? { reason: r.stateReason } : {}) };
  }

  async buildLogTail(imageName: string): Promise<string[]> {
    try {
      const r = await this.logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/microvms/${imageName}`, limit: 60 }));
      return (r.events ?? []).map((e) => `${new Date(e.timestamp ?? 0).toISOString()} ${(e.message ?? "").trimEnd()}`);
    } catch (err) {
      return [`(could not read build log: ${String(err)})`];
    }
  }
}
