# lambda-microvm-sandbox-mcp

[![CI](https://github.com/ndmxjp/lambda-microvm-sandbox-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ndmxjp/lambda-microvm-sandbox-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/lambda-microvm-sandbox-mcp)](https://www.npmjs.com/package/lambda-microvm-sandbox-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

AI コーディングエージェントに、あなたの PC ではなく**使い捨ての Linux マシン**を渡す。

`lambda-microvm-sandbox-mcp` は [MCP](https://modelcontextprotocol.io) サーバーです。Claude Code や Kiro などの MCP クライアントから、**AWS Lambda MicroVMs** 上に隔離されたサンドボックスを作り、コマンドを実行し、ファイルを出し入れし、使い終わったら破棄できます。サンドボックスはあなたの AWS アカウント内の Firecracker VM で、git、Python、Node.js、C ツールチェーンが入った状態で約 2 秒で起動します。

[English README](README.md)

## なぜ使うのか

- **本物の隔離。** コマンドは手元のコンテナではなく Firecracker VM で動きます。`rm -rf` や悪意ある `npm install` があっても、あなたのファイルや認証情報には届きません。VM には IAM ロールがなく、外に出られるのはインターネットだけです。
- **速くて安い。** 約 2 秒で使える状態になり、エージェントが考えている間は自動で suspend（コンピュート課金なし）、次の呼び出しで約 1 秒で復帰、最長 8 時間で自動的に消えます。2GB のサンドボックスの稼働コストは 1 時間あたり約 $0.13 です。
- **ホストするものがない。** サーバーもクラスタもデーモンも不要。`setup` コマンド 1 回で VM イメージがアカウントに作られ、MCP サーバーは `npx` でローカルに起動します。
- **エージェント向けの設計。** 結果は構造化され、長いコマンドはタイムアウトで確実に止まり、出力は上限で打ち切られ、何かが足りないときはエージェントに次にやるべきことがそのまま伝わります。

## 仕組み

```
Claude Code / Kiro ──stdio──▶ lambda-microvm-sandbox-mcp（npx、あなたのマシン上）
                                  │  AWS SDK: RunMicrovm、トークン発行、suspend / resume / terminate
                                  ▼
                              AWS Lambda MicroVMs
                                  │  HTTPS + VM ごとの認証トークン + VM ごとのシークレット
                                  ▼
                              Firecracker VM（Amazon Linux 2023）
                                  └─ sandbox-agent: exec / files API、ライフサイクルフック、sudo 中継
```

AWS の認証情報を持つのは MCP サーバーだけです。一度作ったイメージから VM を起動し、短命のトークンを発行し、VM 内の小さな agent と通信します。コマンドは非特権ユーザー `sandbox` で実行され、パスワードなしの `sudo` が使えるので、エージェントは `sudo dnf install` で必要なものを入れられますが、VM を制御する agent プロセスを殺すことはできません。

## クイックスタート

**1. AWS アカウントにサンドボックス用イメージを作る**（1 回だけ、約 3 分）。MicroVM のイメージはアカウント間で共有できないため、`setup` が非公開の S3 バケット、最小権限のビルドロール、イメージを、npm パッケージに同梱された資材から作成します。作成前に内容を表示して確認を求めます。

```bash
npx lambda-microvm-sandbox-mcp setup --region ap-northeast-1
npx lambda-microvm-sandbox-mcp doctor --region ap-northeast-1   # 確認
```

IaC で管理したい場合は [`cloudformation/prerequisites.yaml`](packages/mcp-server/cloudformation/prerequisites.yaml) をデプロイし、出力を渡してください: `setup --bucket <name> --build-role-arn <arn>`。

**2. エージェントにサーバーを登録する。**

Claude Code（プロジェクトの `.mcp.json`）:

```json
{
  "mcpServers": {
    "lambda-sandbox": {
      "command": "npx",
      "args": ["-y", "lambda-microvm-sandbox-mcp", "--region", "ap-northeast-1"]
    }
  }
}
```

Kiro（`.kiro/settings/mcp.json`）:

```json
{
  "mcpServers": {
    "lambda-sandbox": {
      "command": "npx",
      "args": ["-y", "lambda-microvm-sandbox-mcp"],
      "env": { "AWS_REGION": "ap-northeast-1" },
      "autoApprove": ["sandbox_exec", "sandbox_read_file", "sandbox_list_files", "sandbox_status", "sandbox_list"]
    }
  }
}
```

サーバーは通常の AWS 認証情報チェーン（`AWS_PROFILE`、SSO、環境変数）を使います。

**3. エージェントに頼む。**

> サンドボックスを作って、このプロジェクトをアップロードし、そこでテストを実行して失敗を報告して。終わったらサンドボックスを破棄して。

エージェントは `sandbox_create`、`sandbox_upload_dir`、`sandbox_exec` を呼び、必要なファイルを読み、最後に `sandbox_destroy` を呼びます。

## ツール

| ツール | 内容 |
|---|---|
| `sandbox_create` | VM を起動し、コマンドを受け付けるまで待つ。`sandbox_id` を返す |
| `sandbox_exec` | bash コマンドを実行（`cwd`、`timeout_s`、`env`、`stdin`、`as_root`）。exit code、stdout、stderr を返す。`background=true` でサーバーなどを切り離して起動し、pid とログのパスを返す |
| `sandbox_read_file` / `sandbox_write_file` / `sandbox_list_files` / `sandbox_delete_path` | ファイル操作。パスは絶対または `/workspace` 相対 |
| `sandbox_upload_dir` / `sandbox_download` | ディレクトリを tar.gz で出し入れ（`.git`、`node_modules` などは既定で除外） |
| `sandbox_port_forward` / `sandbox_port_forward_stop` | サンドボックス内のポートを手元の `http://127.0.0.1:<port>` に公開（HTTP と WebSocket）。サンドボックスで動かした開発サーバーや Web アプリをブラウザで開ける。アプリは `sandbox_exec` の `background=true` で起動する |
| `sandbox_suspend` / `sandbox_resume` | 状態を保ったままコンピュート課金を止める。suspend 中の VM は次の呼び出しで自動復帰 |
| `sandbox_status` / `sandbox_list` | 状態と理由。Lambda 側で終了済みの VM は一度だけ報告される |
| `sandbox_destroy` | VM を終了する |

サーバーのすべてのオプションにはフラグと環境変数があります。`npx lambda-microvm-sandbox-mcp --help` を参照してください。詳細は [`packages/mcp-server/README.md`](packages/mcp-server/README.md) にあります。

## 料金と制限

| | |
|---|---|
| 稼働中のサンドボックス（2GB / 1 vCPU、ARM） | 約 $0.13 / 時、秒課金 |
| suspend 中 | コンピュート課金なし |
| イメージのスナップショット保存 | 約 $0.08 / GB 月、最低 1 週間 |
| サンドボックスの寿命 | `--max-duration`、既定 4 時間、上限 8 時間 |
| 自動 suspend | `--idle` 秒（既定 600）通信がないとき |
| 2GB サンドボックスへの帯域 | 約 4MB/s。アップロードは小さく |

各ツールの説明文で、不要になったサンドボックスを破棄するようエージェントに念押ししています。稼働中のものは `sandbox_list` で確認できます。

## セキュリティモデル

- VM に **IAM 実行ロールはありません**。AWS 認証情報はあなたのマシンから出ず、サンドボックスが到達できるのはインターネットだけです（`--no-internet-egress` で遮断も可能）。
- VM へのリクエストには、VM とポートを限定した Lambda 発行トークンと、作成時に生成して `/run` ライフサイクルフックで届ける VM ごとのシークレットが必要です。どちらもイメージには書き込まれません。
- コマンドはユーザー `sandbox` で実行されます。`sudo` は使えますが、コンテナが `no_new_privileges` で動くため、root の agent へグループ限定の unix ソケット経由で中継するシムです。`sandbox_exec` の `as_root: true` も同じ動きです。
- 既知のサンドボックスは `~/.lambda-sandbox/sandboxes.json`（0600）に保存されます。
- イメージは Amazon Linux 2023 minimal なので `dnf` は実際には `microdnf`、既定の `python3` は 3.9 です。必要なものは `sudo dnf install -y …` で追加してください。

## リポジトリ構成

- [`packages/mcp-server`](packages/mcp-server) – npm パッケージ: MCP サーバー、`setup`、`doctor`、CloudFormation テンプレート
- [`packages/sandbox-agent`](packages/sandbox-agent) – VM イメージに焼き込む agent と `Dockerfile`
- [`docs/`](docs) – 調査メモと実装ログ

開発、テスト、CI、リリースについては [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT](LICENSE)
