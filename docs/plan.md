# 実装計画: Lambda MicroVMs サンドボックス MCP

作成日: 2026-09-26（docs/research.md の調査結果に基づく）

## 0. 前提と決定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| 言語 | sandbox-agent / MCP サーバー / スクリプトすべて TypeScript（Node 22+） | MCP を `npx lambda-microvm-sandbox-mcp` で起動できるようにする要件のため。1 言語で API の型とテストフィクスチャを共有できる。MCP TypeScript SDK 1.30、`@aws-sdk/client-lambda-microvms` 3.1141 を使う（npm で存在確認済み） |
| sandbox-agent の依存 | Node 標準モジュールのみ（`http`, `child_process`, `fs`）。esbuild で 1 ファイルにバンドルしてイメージに置く。tar は VM 内の `tar` コマンドを使う | イメージに node_modules を入れない。AL2023 の `nodejs22` で実行 |
| ベースイメージ | `public.ecr.aws/lambda/microvms:al2023-minimal` | OpenSSL が resume 時に自動で再シードされる（スキル参照資料の推奨） |
| サンドボックス内のツール | git, python3, pip, nodejs22, npm, tar, gzip, unzip, jq, curl, make, gcc | サンドボックス内でコーディングエージェントが `sandbox_exec` で使うコマンド群。増やすとスナップショットが肥大化するため最小限から始め、足りないものは root なので `dnf install` / `pip` / `npm` で VM 内に追加できる |
| 実行ユーザー | sandbox-agent は root、`/exec` のコマンドは非 root ユーザー `sandbox`（パスワードなし sudo 付き）、作業ディレクトリ `/workspace` | GitHub Actions ランナーと同じモデル。エージェントが誤って agent プロセスを殺したり `/opt` を壊したりできず、パーミッション挙動も開発機と揃う。`sudo dnf install` で環境追加は可能。`as_root: true` で root 実行もできる |
| 実行ロール | 付けない（`executionRoleArn` 省略） | VM にホストアカウントの権限を渡さない（research.md の方針） |
| ネットワーク | ingress: `ALL_INGRESS`、egress: `INTERNET_EGRESS`（設定でオフ可） | パッケージ取得や git clone に必要 |
| リージョン / 既存資産 | ap-northeast-1。既存の `MicrovmBuildRole` とバケット `lambda-microvm-test-123456789012-apne1` を流用 | 新規 IAM/S3 作成を避ける |
| イメージ名 | `sandbox-agent`（新規作成。`my-first-microvm-image` は流用しない） | |
| パッケージ管理 | npm workspaces（`packages/sandbox-agent`, `packages/mcp-server`）。テストは vitest、ビルドは tsc + esbuild | |

イメージは 1 サイズ固定（research.md「イメージとサイズ」）なので、`sandbox_create` にメモリ指定は持たせない。サイズは build スクリプトの引数で決める（既定 2GB/1vCPU）。

## 1. リポジトリ構成

```
package.json                   # npm workspaces ルート（vitest, tsc, esbuild）
packages/
  sandbox-agent/               # MicroVM 内で動く HTTP サーバー
    src/
      main.ts                  # 2 つの HTTP サーバーを起動（API 8080 / hooks 9000）
      api.ts                   # /health /exec /files/* /archive/* のハンドラ
      hooks.ts                 # /aws/lambda-microvms/runtime/v1/* のハンドラ
      executor.ts              # child_process 実行、ユーザー切り替え、タイムアウト、出力上限
      files.ts                 # 読み書き・一覧・削除・tar 転送
      state.ts                 # 共有シークレット、実行中プロセス、起動状態
      protocol.ts              # API のリクエスト/レスポンス型（mcp-server と共有）
    test/
    image/
      Dockerfile               # zip のルートに置く
      build.mjs                # esbuild で dist/agent.js を 1 ファイルに
  mcp-server/                  # `npx lambda-microvm-sandbox-mcp` で起動
    src/
      index.ts                 # bin エントリ（stdio）
      server.ts                # McpServer 定義とツール
      config.ts                # 環境変数
      aws.ts                   # client-lambda-microvms / S3 の薄いラッパ（テストで差し替え）
      client.ts                # MicroVM エンドポイントへの HTTP クライアント（トークン管理、502 リトライ）
      registry.ts              # sandbox_id → microvmId/endpoint/secret のローカル保存
      transfer.ts              # tar.gz 作成と分割アップロード/ダウンロード
    test/
scripts/
  build-image.ts               # zip → S3 → create/update-microvm-image → ACTIVE 待ち（tsx で実行）
  smoke-test.ts                # 実 MicroVM で E2E（課金あり、--yes 必須）
README.md
```

## 2. sandbox-agent（MicroVM 内）

### 2.1 API ポート 8080（エージェント本体のトラフィック）

すべてのリクエストに `X-Sandbox-Secret` ヘッダーを要求し、`/run` で受け取ったシークレットと定数時間比較する。`/run` 未完了（シークレット未設定）の間は `/health` 以外を 503 で拒否する。

| メソッド/パス | 入力 | 出力 |
|---|---|---|
| `GET /health` | – | `{ok, started, uptime_s, workspace}`（認証不要。MCP 側の起動待ちに使う） |
| `POST /exec` | `{command, cwd?, timeout_s?(既定 120, 上限 3600), env?, stdin?, as_root?: false}` | `{exit_code, stdout, stderr, duration_ms, timed_out, truncated}` |
| `POST /files/read` | `{path, encoding: "utf-8"｜"base64", max_bytes?}` | `{content, encoding, size, truncated}` |
| `POST /files/write` | `{path, content, encoding, mode?, mkdirs?: true}` | `{path, size}` |
| `POST /files/list` | `{path, recursive?, max_entries?(既定 1000), include_hidden?}` | `{entries:[{path,type,size,mtime}], truncated}` |
| `POST /files/delete` | `{path, recursive?}` | `{deleted}` |
| `POST /archive/upload` | ボディ: tar.gz バイト列（`X-Sandbox-Dest`, `X-Sandbox-Offset`, `X-Sandbox-Final` ヘッダー） | 8MiB ずつ分割受信し、最終チャンクで `/workspace` 配下に展開（S3 不要の既定経路） |
| `GET /archive/download?path=&offset=` | – | 指定ディレクトリの tar.gz を作り、8MiB ずつ返す |
| `POST /files/pull` | `{url, dest, extract?: true}` | presigned GET から取得し tar.gz を展開（S3 中継を設定した場合のみ） |
| `POST /files/push` | `{src, url}` | ディレクトリを tar.gz にして presigned PUT で送る（同上） |

実装の要点:

- `bash -c <command>` を `sandbox` ユーザー（`as_root` なら root。`spawn` の `uid`/`gid`）で `detached: true` の新しいプロセスグループとして起動し、タイムアウト時は `process.kill(-pid, "SIGKILL")`。ローカルテストなど非 root で agent を動かす場合はユーザー切り替えをスキップする
- stdout/stderr は各 1MiB で打ち切り（`truncated: true`）。バイナリは `errors="replace"`
- パスは絶対パスまたは `/workspace` 相対。VM 自体が隔離境界なので `/workspace` 外も許可（ただし `..` 正規化はする）
- リクエストボディ上限 16MiB。それ以上は `/files/pull` を使う

### 2.2 フックポート 9000

| フック | 実装 |
|---|---|
| `ready` | API サーバーが bind 済みなら 200、まだなら 503 |
| `validate` | `git --version`、`python3 -c`、`node -e`、ファイル書き→読み→削除を `sandbox` ユーザーで `/workspace` で一巡してから 200（プリフェッチ対象を作る） |
| `run` | ボディ `{microvmId, runHookPayload}` を読む。`runHookPayload` は JSON 文字列 `{"secret": "...", "env": {...}?}`。シークレットを保存する。16KB 上限に収まることを MCP 側で検証 |
| `resume` | 200 を返すだけ（乱数は `crypto.randomBytes` のみ使うので再シード不要） |
| `suspend` | 実行中の `/exec` があれば最長 4 秒待ってから 200（タイムアウト 5 秒に収める） |
| `terminate` | 子プロセスを SIGTERM → 200 |

`--hooks` 設定（build スクリプトが送る）: `port 9000`、`ready 60s`、`validate 120s`、`run 5s`、`resume 5s`、`suspend 5s`、`terminate 5s`。

### 2.3 Dockerfile

```dockerfile
FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN dnf install -y nodejs22 nodejs22-npm python3 python3-pip git tar gzip unzip jq curl make gcc sudo shadow-utils \
 && dnf clean all && rm -rf /var/cache/dnf
RUN useradd -m -u 1000 -s /bin/bash sandbox \
 && echo 'sandbox ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/sandbox && chmod 0440 /etc/sudoers.d/sandbox \
 && mkdir -p /workspace && chown sandbox:sandbox /workspace
COPY agent.js /opt/sandbox-agent/agent.js
WORKDIR /workspace
EXPOSE 8080 9000
CMD ["node", "/opt/sandbox-agent/agent.js"]
```

`node:24-bookworm` のような大きいベースは、ビルド時間とスナップショットサイズを実測してから検討する（research.md の未確認項目）。

## 3. MCP サーバー（ローカル、stdio）

SDK: `@modelcontextprotocol/sdk` 1.30（`McpServer` + `registerTool` + `StdioServerTransport`）。AWS: `@aws-sdk/client-lambda-microvms` 3.1141。HTTP: Node 標準 `fetch`。`package.json` の `bin` で `lambda-microvm-sandbox-mcp` を公開し、`npx lambda-microvm-sandbox-mcp` で起動する。Kiro / Claude Code の設定例は README に載せる。

### 3.1 設定（環境変数）

| 変数 | 既定 | 用途 |
|---|---|---|
| `AWS_REGION` / `AWS_PROFILE` | ap-northeast-1 | AWS SDK 標準の認証情報解決に任せる。VM には渡さない |
| `SANDBOX_IMAGE_ARN` | 必須 | `arn:aws:lambda:ap-northeast-1:123456789012:microvm-image:sandbox-agent` |
| `SANDBOX_IMAGE_VERSION` | 最新 ACTIVE を自動選択 | |
| `SANDBOX_MAX_DURATION_S` | 14400（4 時間） | `maximumDurationInSeconds` |
| `SANDBOX_IDLE_S` / `SANDBOX_SUSPENDED_S` | 600 / 3600 | `idlePolicy`（`autoResumeEnabled: true`） |
| `SANDBOX_INTERNET_EGRESS` | true | `INTERNET_EGRESS` コネクタを付けるか |
| `SANDBOX_TRANSFER_BUCKET` | 任意 | 設定時のみ `upload_dir`/`download` が S3 presigned URL を中継に使う。未設定なら分割直送（3.4 参照） |
| `SANDBOX_STATE_FILE` | `~/.lambda-sandbox/sandboxes.json`（0600） | MCP サーバー再起動後に既存 VM へ再接続するため |

すべて `--image-arn` などの CLI 引数でも渡せるようにし、npx 実行時に `args` だけで設定できるようにする。

### 3.2 ツール

ツール名・引数は MCP の慣例に合わせ snake_case。

| ツール | 動作 |
|---|---|
| `sandbox_create(name?, max_duration_s?, internet_egress?)` | シークレット生成 → `RunMicrovm(runHookPayload=...)` → トークン発行（30 分、port 8080 のみ）→ `/health` が 200 になるまでポーリング（state は結果整合なので接続で判定）→ registry に保存。`sandbox_id`（`microvmId`）と endpoint、期限を返す |
| `sandbox_exec(sandbox_id, command, cwd?, timeout_s?, env?, as_root?)` | `POST /exec`。既定は `sandbox` ユーザー、`as_root` で root |
| `sandbox_read_file(sandbox_id, path, encoding?)` / `sandbox_write_file(...)` / `sandbox_list_files(...)` / `sandbox_delete_path(...)` | `/files/*` |
| `sandbox_upload_dir(sandbox_id, local_path, remote_path, exclude?)` | ローカルを tar.gz → 既定は `/archive/upload` へ分割直送、バケット設定時は presigned PUT → `POST /files/pull`。`.git` `node_modules` `.venv` `__pycache__` は既定で除外 |
| `sandbox_download(sandbox_id, remote_path, local_path)` | 既定は `/archive/download` を分割取得、バケット設定時は `POST /files/push` → ローカルで取得・展開 |
| `sandbox_suspend` / `sandbox_resume` / `sandbox_destroy` | 対応する API。destroy は registry からも削除 |
| `sandbox_list()` | registry と `ListMicrovms` を突き合わせ、`state` と `stateReason` を返す。TERMINATED は registry から掃除 |

### 3.3 クライアントの挙動

- トークンは残り 5 分未満で再発行（最長 60 分、既定 30 分）
- 502（auto-resume 中）は指数バックオフで最大 60 秒リトライ。403 は再発行して 1 回だけ再試行
- 全リクエストに `X-aws-proxy-auth` と `X-Sandbox-Secret` を付与
- 8 時間上限で VM が消える旨をツールの description に書き、`sandbox_list` の `stateReason` で追えるようにする

### 3.4 ファイル転送の方式

MicroVM の帯域は baseline に比例して細い（2GB で 4MB/s）ため、VM 側の転送速度はどの経路でも同じ上限になる。差が出るのはセットアップの手間と長時間リクエストの安定性。

| 方式 | 追加リソース | 長所 | 短所 |
|---|---|---|---|
| A. エンドポイントへ分割直送（既定） | なし | 設定ゼロで動く。8MiB ごとのリクエストなのでプロキシのタイムアウトや 502 リトライと相性がよい | 転送中は MCP サーバーがローカルにいる必要がある |
| B. S3 presigned URL 中継（任意） | S3 バケット 1 つ | 巨大な転送でもリクエストを長く握らない。複数 VM への同じアップロードを再利用できる | バケットが必要。転送データが一時的に S3 に残る |
| C. S3 Files をホームにマウント（Bivack 方式） | S3 バケット + 実行ロール | 8 時間上限を越えてワークスペースが残る | VM に IAM ロールを渡す必要があり、research.md の方針（実行ロールなし）と衝突する |

採用: A を既定、B は `SANDBOX_TRANSFER_BUCKET` を設定したときだけ有効。バケットの用意は `scripts/build_image.py --create-transfer-bucket` に持たせ、`lambda-sandbox-transfer-<account>-<region>` を Public Access Block、SSE-S3、1 日で削除するライフサイクルルール付きで作る（実行前に確認）。C はワークスペース永続化が必要になった時点で別途検討する。

## 4. ビルド・更新スクリプト（`scripts/build-image.ts`）

1. esbuild で `agent.js` を作り、`Dockerfile` と一緒に zip（Dockerfile がルート）
2. `s3://lambda-microvm-test-123456789012-apne1/microvm-images/sandbox-agent/<sha>.zip` にアップロード
3. 同名イメージがなければ `create_microvm_image`、あれば `update_microvm_image`（新バージョン）
   - `baseImageArn=al2023-1`、`buildRoleArn=MicrovmBuildRole`、`resources=[{minimumMemoryInMiB: 2048}]`、`cpuConfigurations=[{architecture: ARM_64}]`、`hooks` は 2.2 の値、`egressNetworkConnectors=[INTERNET_EGRESS]`（dnf/npm 用）
4. `get_microvm_image_version` を ACTIVE/FAILED までポーリング。FAILED なら CloudWatch `/aws/lambda/microvms/sandbox-agent` の末尾を表示
5. 成功時に `SANDBOX_IMAGE_ARN` / `SANDBOX_IMAGE_VERSION` の export 文を出力
6. `--dry-run` で AWS を呼ばず zip と送信パラメータだけ表示。`--create-transfer-bucket` は 3.4 参照。`--prune-versions N` で古いバージョンを削除（保存課金の抑制、確認プロンプト付き）

## 5. テスト

| 層 | 内容 | AWS |
|---|---|---|
| `packages/sandbox-agent/test/` | agent を in-process で乱数ポートに起動。`/run` 前の 503、シークレット不一致の 401、exec の exit code/タイムアウト/出力打ち切り、UTF-8 とバイナリのファイル往復、list の再帰と上限、pull/push（ローカル HTTP サーバーを presigned URL の代わりに使う）、各フックの応答 | 不要 |
| `packages/mcp-server/test/` | AWS クライアントをフェイクに差し替え（`RunMicrovm` が in-process agent の URL を返し、`/run` フックを自分で叩く）。create→exec→destroy の一連、トークン期限切れの再発行、502 リトライ、registry の永続化と TERMINATED 掃除 | 不要 |
| Dockerfile | `docker build` + コンテナ起動でフックと `/exec` を叩く（Docker が動いていればのみ。CI では任意） | 不要 |
| `scripts/smoke-test.ts` | 実イメージから VM を起動し exec/ファイル/suspend/resume/terminate を通し、起動・resume 時間を計測して research.md の未確認項目を埋める。`--yes` なしでは実行しない | 課金あり |

## 6. 実装順序

1. リポジトリ雛形（npm workspaces、TypeScript、vitest、esbuild）
2. sandbox-agent + ユニットテスト（AWS 不要。ここで API の形を固める）
3. MCP サーバー + フェイク AWS クライアントのテスト、`npx` 起動の確認（`npm pack` → `npx ./*.tgz`）
4. build スクリプト（`--dry-run` で検証）
5. **【確認】** S3 アップロードとイメージ作成（ビルド + スナップショット保存 約 $0.08/GB 月、最低 1 週間）
6. **【確認】** smoke test で VM 起動（2GB で約 $0.13/時。終了時に必ず terminate）
7. README（Kiro / Claude Code の MCP 設定例）、research.md の未確認項目を実測値で更新

## 7. 課金・変更が発生する操作（実行前に確認を取る）

- S3 へのアップロード（既存バケット、微小）
- `CreateMicrovmImage` / `UpdateMicrovmImage`（ビルド時間分のコンピュートとスナップショット保存）
- `RunMicrovm`（smoke test、手動検証）
- `DeleteMicrovmImageVersion`（古いバージョンの削除）

現在の認証情報は `arn:aws:iam::123456789012:user/<your-iam-user>`。上記のうち 5〜6 以外は AWS を呼ばない。

## 8. 決定済み（2026-09-26 のレビューで確定）

0. MCP サーバーは `npx lambda-microvm-sandbox-mcp` で起動できる形にする → 実装言語を TypeScript に変更（sandbox-agent も同じ言語に統一）

1. サンドボックス内ツールは git / python3 / node / gcc / make から開始。不足分は VM 内で `dnf` / `pip` / `npm` により追加する
2. ファイル転送は分割直送を既定とし、S3 中継は設定した場合のみ有効。バケット作成はスクリプトのオプション（確認付き）
3. sandbox-agent は root、コマンド実行は `sandbox` ユーザー + パスワードなし sudo（`as_root` フラグで root 実行も可）

## 9. 実装状況（2026-09-26）

- 完了: 1〜4（雛形、sandbox-agent + テスト 29 件、MCP サーバー + テスト 19 件、`build-image.ts` の dry-run、`npm pack` → `npx` 起動と stdio での `tools/list` を確認）
- 未実施: 5（イメージ作成）、6（smoke test）、Docker ローカルビルド（Docker デーモン停止中のため。Dockerfile の dnf パッケージ名は初回ビルドで検証する）
- 補足: 開発機の環境変数 `AWS_REGION` は us-west-2 になっている。MCP サーバーはイメージ ARN のリージョンを優先するので影響しないが、`build-image.ts` は `--region ap-northeast-1` を明示すること

## 10. smoke test 1 回目の結果と修正（2026-09-26）

- 起動（RunMicrovm + `/health` ready）: 2.1 秒、最初の exec: 121 ms、terminate 呼び出し: 181 ms。ツールチェーンは node v22.22.3 / Python 3.9.25 / git 2.50.1
- **失敗**: `sudo -n whoami` → `sudo: The "no new privileges" flag is set`。コンテナが no_new_privileges で動いており setuid による昇格が不可能。VM は正常に terminate 済み
- 対応: `sudo` パッケージを外し、`/usr/bin/sudo` を Node のシムに置き換えた。シムは root の agent が listen する unix ソケット `/run/sandbox-agent/root.sock`（root:sandbox, 0660）に argv / cwd / env / stdin を送り、agent が root で実行して結果を返す。非対話専用（`sudo cmd`、`sudo -s` + stdin、`-E`、`-n`、`-u root`）。`sandbox_exec` の `as_root` はシムを介さず同じ効果
- Python が 3.9 なのは AL2023 の既定。必要なら `python3.11` / `python3.12` パッケージの追加を検討

## 11. smoke test 2 回目（イメージ 2.0、2026-09-26）: PASSED

| 計測 | 値 |
|---|---|
| イメージ更新（UpdateMicrovmImage → SUCCESSFUL） | 約 2 分半 |
| create（RunMicrovm + `/health` ready） | 1.95 秒 |
| exec（whoami 等） | 135 ms |
| `sudo -n whoami` + `sudo tee`（シム → root relay） | 485 ms |
| `as_root: true` の exec | 87 ms |
| write / read file | 14 / 15 ms（所有者は `sandbox`） |
| suspend API | 68 ms |
| suspend 直後の exec（auto-resume 含む） | 2.1 秒 |
| destroy | 107 ms |

- `sudo dnf install -y -q bc` は `error: Unknown option -q` で失敗。al2023-minimal の `dnf` は microdnf のため。`-q` を外せばよい（smoke test を修正済み、再実行はしていない）
- 残タスク候補: 旧バージョン 1.0 の削除（`npm run build-image -- --region ap-northeast-1 --prune-versions 1 --yes`、課金対象の保存を減らす）、python3.11/3.12 の追加検討、Kiro / Claude Code から実際に接続しての動作確認

## 12. Claude Code からの実機検証（2026-09-26）: PASSED

Herdr の別ペインで `claude-pub --mcp-config .mcp.json --allowedTools mcp__lambda-sandbox` を起動し、10 ステップの検証を依頼した（内部版 Claude Code は Bedrock の 403 で使えず、公開版に切り替えた）。レポートは `/tmp/lambda-sandbox-verify.md`。

- 全 10 ステップ成功、エラー 0 件。create → exec → `sudo dnf install -y bc`（31.6 秒、`42`）→ write/exec hello.py → upload_dir（16KB、1 チャンク）→ list → download → suspend → exec（自動 resume、ファイル保持）→ status/list → destroy → `sandbox_list` は空
- 旧イメージバージョン 1.0 は削除済み。アカウント内の MicroVM はすべて TERMINATED
- 指摘 1: macOS からの upload に AppleDouble `._*` が混入 → `COPYFILE_DISABLE=1` と既定 exclude `._*` を追加して修正
- 指摘 2: 「upload/download に約 10 秒、resume に約 10 秒」はエージェント側の壁時計で、Claude のターン往復（約 10 秒）を含む。サーバー側の実測（ready_after 1.8 秒、smoke test の resume 2.1 秒）と整合しており、実装の問題ではない
- `.mcp.json` をプロジェクト直下に追加（ローカルの dist を `node` で起動、`--max-duration 1800`）

## 13. OSS 配布向けの変更（2026-09-26）

MicroVM イメージはアカウント間で共有できない（リソースポリシー等の API がない）ため、利用者ごとに自アカウントでビルドする必要がある。その手順を npm パッケージだけで完結させた。

- `npx lambda-microvm-sandbox-mcp setup --region <r>`: STS でアカウントを取り、S3 バケット（`lambda-microvm-sandbox-<account>-<region>`、PAB、SSE-S3、30 日で削除）、ビルドロール（`LambdaMicrovmSandboxBuildRole`、`aws:SourceAccount` 条件付き、権限はバケットの GetObject と MicroVM ビルドログのみ）、イメージを冪等に作成。Dockerfile / agent.mjs / sudo.mjs はパッケージ内 `image/` に同梱し、依存なしの ZIP ライタで zip 化。`--dry-run` は読み取りのみ、TTY では実行前に確認、IAM 反映待ちのリトライあり。既存のバケット・ロールは `--bucket` / `--build-role-arn` で指定可
- `cloudformation/prerequisites.yaml`: バケットとロールを IaC で入れたい組織向け。出力にそのまま実行できる setup コマンドを含む
- `--image-arn` は任意になった。既定はイメージ名 `sandbox-agent` で、`arn:aws:lambda:<region>:<account>:microvm-image:<name>` を起動時に組み立てる。リージョンは `--region` → イメージ ARN → `AWS_REGION` → プロファイル既定
- `npx lambda-microvm-sandbox-mcp doctor`: 認証情報、リージョン対応、イメージの有無と ACTIVE バージョン、設定を表示
- イメージが無いときの `sandbox_create` のエラーに `setup` コマンドをそのまま含める
- `scripts/build-image.ts` は削除し、`npm run build-image` は `setup` の別名に
- テスト 59 件（ZIP ライタは `unzip -t` で検証、setup はフェイククライアントで作成／再利用／IAM リトライ／失敗時ログ／確認拒否をカバー）
- 実機確認: `doctor` は OK、`setup --dry-run` は新規バケットとロールの作成と 3.0 のビルドを提案（実行は別途確認）

## 14. setup の実機検証（2026-09-26）: PASSED

- `setup --region ap-northeast-1 --yes`: バケット `lambda-microvm-sandbox-123456789012-ap-northeast-1` とロール `LambdaMicrovmSandboxBuildRole` を新規作成し、zip（38KB）を置いてイメージ 3.0 をビルド。IAM 反映待ちのリトライは発生せず、約 3 分で SUCCESSFUL
- 作成物の確認（読み取り API）: Public Access Block 4 項目すべて true、SSE-S3 + Bucket Key、ライフサイクル 3 ルール、信頼ポリシーに `aws:SourceAccount`、権限はバケット配下の GetObject と `/aws/lambda/microvms/*` へのログ書き込みのみ
- 2 回目の `setup --dry-run` は既存バケットとロールを再利用する表示になり、冪等性を確認。`doctor` は 3.0 を latest ACTIVE と表示
- 3.0 での smoke test: create 2.5 秒、exec 99 ms、sudo シム 429 ms、`sudo dnf install -y bc` 21 秒で `echo 2+3 | bc` → 5、suspend 後の exec 594 ms、destroy 済み
- 旧リソースの削除（2026-09-26）: イメージ 2.0、getting-started 由来の `MicrovmBuildRole`（インラインポリシー含む）と `lambda-microvm-test-123456789012-apne1`（オブジェクト 3 件含む）を削除。残るのは `sandbox-agent` 3.0、新しいバケットとロール、getting-started の `my-first-microvm-image` 1.0（未確認のため残置）

## 15. CI（2026-09-26）

- GitHub Actions: `ci.yml`（typecheck / eslint / prettier / vitest を ubuntu Node 20・22 と macOS Node 22 で実行、`npm pack` → `npx` 起動で stdio の `tools/list` を確認、hadolint、linux/arm64 の Docker ビルドと起動テスト）、`release.yml`（`v*` タグで npm publish、`NPM_TOKEN` が必要）、`e2e.yml`（手動のみ、OIDC ロール `AWS_ROLE_ARN` で setup + smoke test）、Dependabot
- Docker 起動テスト `packages/sandbox-agent/image/ci-boot-test.sh` は Lambda と MCP サーバーの代わりにフックと API を叩く。dnf パッケージ名や sudo シムの回帰を AWS なしで検出できる。QEMU なので遅く、push 時と `image` ラベル付き PR のみ
- ローカルで actionlint / hadolint / shellcheck / eslint / prettier をすべて通過。GitHub 上での実行はまだ（push が必要）

## 16. 公開（2026-09-26）

- 履歴を `git filter-repo` で書き換え（アカウント ID → `123456789012`、IAM ユーザー名を伏せ、作者メールを統一）、force push 後に gitleaks を含む CI 全ジョブ成功
- リポジトリを public 化、`lambda-microvm-sandbox-mcp@0.1.0` を npm に公開（2FA のため publish 本体は通常ターミナルから）。公開直前に npm 11 が `"./dist/index.js"` 形式の bin を削除する問題を発見し `"dist/index.js"` に修正
- 検証: 別ディレクトリで `npx -y lambda-microvm-sandbox-mcp@0.1.0 --help` / `doctor` が動作。Herdr の別ペインで `claude-pub --mcp-config`（npx 起動の設定）から create → exec（sandbox ユーザー、sudo → root）→ write/read → status → destroy → list が全成功、VM は残っていない
- 気づき: 検証エージェントが `sandbox_delete` を「destroy の別名」と誤解した。次版でツール名を `sandbox_delete_path` などに変えて混同を避ける
- 未実施: GitHub Release と `v0.1.0` タグ（`release.yml` が publish を再試行して失敗するため、`NPM_TOKEN` か Trusted Publishing を設定してから）

## 17. 実運用テスト: Excalidraw をサンドボックスで配信（2026-09-27 JST）

- 追加機能: `sandbox_exec` の `background: true`（切り離し起動、pid とログを返す）、`sandbox_port_forward` / `sandbox_port_forward_stop`（MCP サーバー内のローカルリバースプロキシ。`X-aws-proxy-auth` と `X-aws-proxy-port` を注入し、WebSocket は lambda-* サブプロトコルで認証して透過。トークンは対象ポートを含めて再発行）。テスト 65 件、イメージ 4.0
- Herdr の Claude Code（ローカルビルドの MCP）に依頼した結果: create 4 秒 → `git clone` 5 秒 → `yarn install` 41 秒 → `yarn build:app` 37 秒（4 vCPU / 8GB のバースト内で余裕あり）→ `python3 -m http.server 3000` を background 起動 → `sandbox_port_forward 3000 → 3838`。Chrome で `http://127.0.0.1:3838` を開き Excalidraw が描画できることを確認。ローカルからの往復は index 45 ms、JS アセット 340 ms
- 発見: AL2023 の `nodejs22-npm` は `npm-22` / `npx-22` しか置かず `npm` へのリンクがない。corepack も同梱されない。エージェントは自力でリンクを張って回避したが、Dockerfile に `npm` / `npx` のリンクと `corepack enable`（yarn / pnpm シム）を追加した（CI の Docker 起動テストで検証、次のイメージビルドで反映）

## 18. 「Resume lifecycle hook connection was refused」の調査（2026-09-27 JST）

- 事象: Excalidraw デモの VM（イメージ 4.0）が、10 分アイドルで suspend された約 2 分後に `Resume lifecycle hook connection was refused` で Lambda により TERMINATED（16:35 UTC）。resume のきっかけは Chrome からフォワード経由のアクセスと推測。当時は実行ロールがなく VM のログは残っていない
- 対策 1: 実行ロール（CloudWatch Logs 書き込み専用）を任意で付けられるようにし、`sandbox_vm_logs` で VM 自体のログを読めるようにした。ログストリーム名は `YYYY/MM/DD[<版>]<microvmId>`
- 再現試行 1（http.server のみ、idle 120 秒、suspend 2.5 分 → exec で resume）: 再現せず。resume 1.5 秒、ログに run → suspend → resume → terminate が順に記録
- 再現試行 2（Excalidraw の clone / install / build → 配信 → ポートフォワード → idle 120 秒 → suspend 2.3 分 → フォワード経由の HTTP で resume）: 再現せず。resume 2.0 秒、agent は PID 1 で生存（RSS 59MB）、フックの記録も正常
- 結論: 2 回の再現で問題なし。原因は特定できていない（プラットフォーム側の一時的な事象か、当時の環境固有の要因）。次に発生した場合は `--execution-role-arn` を付けて VM ログを取得する。ブラウザで開き続ける用途には `sandbox_create` の `idle_s` を長めに指定して suspend/resume の回数を減らすことを推奨
- ビルドロールのログ権限パスの誤り（`/aws/lambda/microvms/*`）を修正。3.0〜5.0 のビルドログが出ていなかった原因
