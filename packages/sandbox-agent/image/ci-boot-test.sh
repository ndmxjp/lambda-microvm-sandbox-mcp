#!/usr/bin/env bash
# Boot the built image in Docker and exercise it the way Lambda and the MCP
# server would: /ready, /run (secret delivery), /health, /exec as the sandbox
# user, sudo through the root relay, and /validate. Usage: ci-boot-test.sh <image-tag>
set -euo pipefail
IMAGE="${1:?image tag}"
SECRET="ci-secret-0123456789abcdef"
CID=$(docker run -d --platform linux/arm64 -p 18080:8080 -p 19000:9000 "$IMAGE")
trap 'echo "--- container logs"; docker logs "$CID" | tail -50; docker rm -f "$CID" >/dev/null' EXIT

api="http://127.0.0.1:18080"
hooks="http://127.0.0.1:19000/aws/lambda-microvms/runtime/v1"

echo "waiting for the agent"
for _ in $(seq 1 60); do
  if curl -sf "$api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -sf "$api/health" | tee /dev/stderr | grep -q '"ready":false'

echo "ready hook"
curl -sf -X POST "$hooks/ready" >/dev/null

echo "API must refuse before /run"
test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$api/exec" -H "x-sandbox-secret: $SECRET" -d '{"command":"true"}')" = 503

echo "run hook delivers the secret"
curl -sf -X POST "$hooks/run" -H 'content-type: application/json' \
  -d "{\"microvmId\":\"ci\",\"runHookPayload\":\"{\\\"secret\\\":\\\"$SECRET\\\"}\"}" >/dev/null
curl -sf "$api/health" | grep -q '"ready":true'

exec_json() { curl -sf -X POST "$api/exec" -H "x-sandbox-secret: $SECRET" -H 'content-type: application/json' -d "$1"; }

echo "exec as sandbox user"
out=$(exec_json '{"command":"whoami; pwd; node --version; python3 --version; git --version; gcc --version | head -1"}')
echo "$out"
echo "$out" | grep -q '"exit_code":0'
echo "$out" | grep -q 'sandbox\\n/workspace\\nv22'

echo "sudo shim through the root relay"
out=$(exec_json '{"command":"sudo -n whoami && echo hi | sudo tee /root/x >/dev/null && sudo cat /root/x"}')
echo "$out"
echo "$out" | grep -q 'root\\nhi\\n'

echo "as_root without the shim"
exec_json '{"command":"whoami","as_root":true}' | grep -q '"stdout":"root\\n"'

echo "files written by the agent belong to the sandbox user"
curl -sf -X POST "$api/files/write" -H "x-sandbox-secret: $SECRET" -H 'content-type: application/json' \
  -d '{"path":"owned.txt","content":"x"}' >/dev/null
exec_json '{"command":"stat -c %U owned.txt"}' | grep -q '"stdout":"sandbox\\n"'

echo "validate hook (toolchain smoke test used for snapshot prefetch)"
curl -sf -X POST "$hooks/validate" >/dev/null

echo "suspend / resume / terminate hooks answer"
for h in suspend resume terminate; do curl -sf -X POST "$hooks/$h" >/dev/null; done

echo "IMAGE BOOT TEST PASSED"
