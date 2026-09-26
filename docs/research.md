# 調査メモ: Lambda MicroVMs で AI コーディングエージェント用サンドボックス MCP を作る

調査日: 2026-09-26

## ゴール

AI コーディングエージェント（Kiro / Claude Code など）が MCP 経由で使える、隔離されたサンドボックス環境を AWS Lambda MicroVMs 上に作る。エージェントはサンドボックスの作成、コマンド実行、ファイル読み書き、破棄を MCP ツールとして呼べるようにする。

## 結論

- Lambda MicroVMs（2026-06-22 GA）は「AI コーディングアシスタント／エージェントのサンドボックス」を公式ユースケースとしており、基盤として適している。
- MicroVM 内でコマンドを実行する API は存在しない。VM 内に自作の実行エージェント（HTTP サーバー）を焼き込んだイメージを作り、MCP サーバーが MicroVM のエンドポイントへ HTTPS でリクエストする構成になる。
- Lambda MicroVMs 専用の公開 MCP サーバーは見つからなかった。

## Lambda MicroVMs の要点

### プログラミングモデル

1. `Dockerfile` + アプリを zip にして S3 へアップロード
2. `CreateMicrovmImage` で Lambda がビルドし、アプリ起動後のメモリ+ディスクをスナップショット化
3. `RunMicrovm` で起動 → `microvmId` と専用 HTTPS `endpoint` が返る
4. `CreateMicrovmAuthToken(microvmIdentifier, expirationInMinutes, allowedPorts)` で JWE トークンを発行し、`X-aws-proxy-auth` ヘッダーに付けてアクセス（未認証アクセス不可）
5. `SuspendMicrovm` / `ResumeMicrovm` / `TerminateMicrovm` / `GetMicrovm` / `ListMicrovms`

### RunMicrovm の主なパラメータ

- `imageIdentifier`（必須、イメージ ARN。名前だけは不可）、`imageVersion`（例 `1.0`）
- `executionRoleArn`（省略可。省略すると VM から AWS API を呼べず、実行時ログも出ない）
- `idlePolicy`: `maxIdleDurationSeconds` / `suspendedDurationSeconds` / `autoResumeEnabled`
- `runHookPayload`: 最大 16KB の文字列。`/run` フックに `{ "microvmId": ..., "runHookPayload": ... }` として届く
- `maximumDurationInSeconds`: 1〜28,800（8 時間、延長不可）
- `ingressNetworkConnectors` / `egressNetworkConnectors`（起動後変更不可）
  - `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:ALL_INGRESS`
  - `arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:INTERNET_EGRESS`
  - `...:NO_INGRESS`、`...:SHELL_INGRESS`（後述）
  - VPC egress は `aws lambda-core create-network-connector` で作成
- `state` の値: PENDING, RUNNING, SUSPENDING, SUSPENDED, TERMINATING, TERMINATED。state は結果整合なので、準備完了はエンドポイントへの接続で判定する

### 接続

- デフォルトでポート 8080 にルーティング。`X-aws-proxy-port` ヘッダーで変更可（トークンの `allowedPorts` 内に限る。外れると 403）
- HTTP/1.1、HTTP/2、WebSocket、gRPC、SSE に対応
- WebSocket はサブプロトコルで認証: `lambda-microvms`, `lambda-microvms.authentication.<token>`, `lambda-microvms.port.<N>`
- `X-aws-proxy-*` ヘッダーは Lambda が除去してからアプリに渡す
- エンドポイントのエラー: 403（トークン不正・期限切れ・ポート外）、429、502（アプリ無応答、または auto-resume 失敗）
- 帯域は baseline に比例して細い: 0.5GB=1MB/s, 1GB=2MB/s, 2GB=4MB/s, 4GB=8MB/s, 8GB=16MB/s。大きなファイルは S3 presigned URL 経由が現実的

### ライフサイクルフック

アプリが指定ポートで `/aws/lambda-microvms/runtime/v1/<hook>` を POST で受ける。

| フック | タイミング | 用途 |
|---|---|---|
| `ready`（ビルド時） | 起動後、スナップショット前 | 200 でスナップショット取得。未準備なら即 503 |
| `validate`（ビルド時） | 作成したイメージから起動した VM で | 動作確認。ここで代表的な処理を走らせるとプリフェッチ対象になり起動が速くなる |
| `run` | スナップショットから起動後 | per-VM 初期化。200 を返すまで外部トラフィックは届かない |
| `resume` | suspend からの復帰時 | 接続の張り直し、認証情報の更新 |
| `suspend` | suspend 前 | flush、接続クローズ |
| `terminate` | 終了前 | 後片付け |

- `create-microvm-image` の `--hooks` は `{ port, microvmHooks: {run, runTimeoutInSeconds, ...: "ENABLED"|"DISABLED"}, microvmImageHooks: {ready, validate, ...} }` の形（`--generate-cli-skeleton` で確認済み）
- 公式ベストプラクティス: UUID・秘密値・乱数はビルド時ではなく `/run` で生成する（スナップショットが使い回されるため）

### イメージとサイズ

- ベースは Lambda 管理の AL2023（`arn:aws:lambda:<region>:aws:microvm-image:al2023-1`）。その上で Dockerfile を実行する
- サイズは `resources: [{minimumMemoryInMiB}]` で指定。vCPU はメモリ 2GB あたり 1:

| baseline | peak (4x) | 最大ディスク |
|---|---|---|
| 0.5GB / 0.25vCPU | 2GB / 1vCPU | 8GB |
| 1GB / 0.5vCPU | 4GB / 2vCPU | 8GB |
| 2GB / 1vCPU（既定） | 8GB / 4vCPU | 8GB |
| 4GB / 2vCPU | 16GB / 8vCPU | 16GB |
| 8GB / 4vCPU | 32GB / 16vCPU | 32GB |

- `cpuConfigurations: [{architecture: "ARM_64"}]`、`additionalOsCapabilities`、`environmentVariables` なども指定可
- 更新は `update-microvm-image`（新バージョンがビルドされる）
- ビルドログ: CloudWatch `/aws/lambda/microvms/<image-name>`

### シェルアクセス（SHELL_INGRESS）は実行経路に使わない

- `SHELL_INGRESS` コネクタを付けて起動すると `CreateMicrovmShellAuthToken` でシェルに入れる（コンソールの Connect も可）
- ドキュメント上はデバッグ専用で、本番では無効化が推奨されている
- 入った先はホスト側で、アプリのコンテナに入るには `ctr task exec -t --exec-id shell <id> /bin/sh` が必要
- よってエージェントのコマンド実行は自前の API で行い、SHELL_INGRESS は障害調査用にとどめる

### クォータ・料金

- 全 MicroVM の合計メモリ: 400GB/アカウント/リージョン（東京・バージニア北部・オレゴン・オハイオは 1,024GB）。4 倍までバースト
- 料金（us-east-1, ARM）: vCPU $0.0000276944/秒、メモリ $0.0000036667/GB秒 → 2GB/1vCPU で約 $0.126/時間
- suspend 中はコンピュート課金なし。スナップショット write $0.0038/GB、read $0.00155/GB、保存 $0.08/GB月（イメージは最低 1 週間保持）
- 公式試算「コーディングアシスタント向けサンドボックス」: 開発者 1 人あたり約 $12.41/月

## 提案アーキテクチャ

```
Kiro / Claude Code
   │ stdio (MCP)
   ▼
MCP サーバー（ローカル）
   │ AWS SDK: lambda-microvms（Run / CreateMicrovmAuthToken / Suspend / Resume / Terminate / Get / List）
   │ HTTPS + X-aws-proxy-auth（+ 多層防御用の VM ごとの共有シークレット）
   ▼
MicroVM（Firecracker, AL2023 上のコンテナ）
   └─ sandbox-agent（自作 HTTP サーバー）
        ├─ API ポート（例 8080）: exec / files read・write・list / health
        └─ フックポート（例 9000）: /aws/lambda-microvms/runtime/v1/{ready,validate,run,resume,suspend,terminate}
```

### MCP ツール案

- `sandbox_create(memory?, ttl?)` → `RunMicrovm` + トークン発行、`/run` 完了（エンドポイント疎通）を待つ
- `sandbox_exec(sandbox_id, command, cwd?, timeout?)`
- `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_files`
- `sandbox_upload_dir` / `sandbox_download`（S3 presigned URL 経由。帯域が細いため）
- `sandbox_suspend` / `sandbox_resume` / `sandbox_destroy`
- `sandbox_list`（`stateReason` も返すと予期しない終了の原因が追いやすい）

参考: AgentCore Code Interpreter を包んだ classmethod の MCP は `execute_python/js/ts/command`、`write_file`、`get_upload_url`、`load_file`、`save_file`（画像は MCP の image content で返す）。Bouvet は `create_sandbox` / exec / read・write file / destroy。

### 設計上の注意

- トークンは最長 60 分、推奨 15〜30 分。MCP サーバー側で期限を管理して再発行する
- トークンは API ポートだけ許可し、フックは別ポートにして外部から叩けないようにする
- VM ごとの共有シークレットは `runHookPayload` で渡し、`/run` で受け取る
- 実行ロールは原則なし。VM にホストアカウントの権限を渡さない（エージェントが読んだファイル経由のプロンプトインジェクションを前提にする）
- `idlePolicy.autoResumeEnabled: true` にすると、エージェントが考えている間は自動 suspend、次のリクエストで自動 resume（初回は遅れる。502 はリトライ対象）
- 8 時間で VM は消える。ワークスペースを残すなら S3（または S3 Files）へ同期・マウントする
- `maximumDurationInSeconds` を必ず指定し、使い終わったら terminate する
- `/validate` で git・言語ランタイム・代表的なコマンドを一度動かしておくと起動が速くなる
- ローカルの AWS 認証情報は MCP サーバーだけが使い、VM には渡さない

## 手元環境で確認済みのこと（2026-09-26）

- 東京リージョン（ap-northeast-1）で利用可。マネージドベースイメージ `arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1`
- アカウント 837802158321 に getting-started の残りがあり、流用できる
  - ビルドロール `arn:aws:iam::837802158321:role/MicrovmBuildRole`（信頼ポリシー: lambda.amazonaws.com の AssumeRole/TagSession。権限: `s3:GetObject` on `lambda-microvm-test-837802158321-apne1/*`、CloudWatch Logs 書き込み）
  - アーティファクト用バケット `lambda-microvm-test-837802158321-apne1`
  - イメージ `my-first-microvm-image`（`node:24-alpine` で 8080 を listen するだけのサンプル。流用はしない）
  - 稼働中の MicroVM はなし
- ツール: AWS CLI 2.36.20（`aws lambda-microvms` 対応、2.35.10 以上が必要）、boto3 1.43.103（`lambda-microvms` クライアント対応。`create_microvm_shell_auth_token` もあり）、Python 3.14、Node 26、uv 0.12.3。SAM CLI は未インストール
- MCP Python SDK は 2.x（2.2.0）。`FastMCP` は `MCPServer`（`from mcp.server.mcpserver import MCPServer`）に改名済み。`@server.tool()` と `server.run("stdio")` の形。1.x のサンプルはそのまま動かない

## 実測（2026-09-26、東京リージョン、`sandbox-agent` イメージ 2GB/ARM64）

- イメージビルド（`al2023-minimal` + dnf で nodejs22/python3/git/gcc など、`/validate` 込み）: 約 2 分半
- RunMicrovm から `/run` フック完了・`/health` 応答まで: 約 2 秒
- 明示 suspend 直後の最初のリクエスト（auto-resume 含む）: 約 2.1 秒
- 通常の exec 往復: 90〜140 ms
- コンテナは no_new_privileges 付きで動く。setuid の sudo は使えないので、root 実行は agent 経由（unix ソケット relay）にした
- `al2023-minimal` の `dnf` は microdnf（`-q` などのオプション非対応）。既定の python3 は 3.9

## 未確認（実測が必要）

- 大きめのベースイメージ（例: `node:24-bookworm`）でのビルド時間とスナップショットサイズ
- idle policy による自動 suspend からの復帰時間（明示 suspend のみ計測済み）

## 参考資料

- 開発者ガイド: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html
  - 起動・接続・フック: https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
  - イメージ: https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
  - ネットワーク: https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html
  - セキュリティ: https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html
  - ベストプラクティス: https://docs.aws.amazon.com/lambda/latest/dg/microvms-best-practices.html
- 料金: https://aws.amazon.com/lambda/pricing/
- ブログ「Running self-hosted AI agent sandboxes with AWS Lambda MicroVMs」: https://aws.amazon.com/blogs/compute/running-self-hosted-ai-agent-sandboxes-with-aws-lambda-microvms/
- 公式サンプル（Claude Managed Agents 用ワーカー、SAM、Dockerfile、build-image.sh）: https://github.com/aws-samples/sample-lambda-microvm-claude-managed-agents
- Bivack（1 ユーザー 1 MicroVM、S3 Files ホーム、WebSocket でファイル操作と PTY）: https://github.com/gunnargrosch/bivack / 解説 https://dev.to/gunnargrosch/building-bivack-a-cloud-dev-sandbox-for-coding-agents-on-aws-lambda-microvms-24o6
- rDev（Bivack の元）: https://github.com/singledigit/microvm-dev-environment
- Agent Toolkit の MicroVMs スキル: https://github.com/aws/agent-toolkit-for-aws/tree/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms
- AgentCore Code Interpreter を MCP 化した例: https://dev.classmethod.jp/en/articles/agentcore-code-interpreter-mcp-server/
- Bouvet（Firecracker サンドボックス MCP）: https://github.com/vrn21/bouvet
