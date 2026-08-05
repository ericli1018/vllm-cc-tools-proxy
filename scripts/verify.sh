#!/bin/sh
set -eu

node -e "const [major]=process.versions.node.split('.').map(Number); if(major<22) process.exit(1)"
npm test
npm run check

test ! -e deploy/bootstrap.sh
test -f package-lock.json
grep -Fq 'image: node:22-bookworm-slim' compose.yaml
grep -Fq 'git clone --depth 1 --branch main' compose.yaml
grep -Fq 'git -C "$$SOURCE_DIR" pull --ff-only origin main' compose.yaml
grep -Fq 'proxy-source:/workspace/vllm-cc-tools-proxy' compose.yaml
grep -Fq 'proxy-npm-cache:/root/.npm' compose.yaml
grep -Fq 'proxy-apt-cache:/var/cache/apt/archives' compose.yaml
grep -Fq 'DEPENDENCY_FINGERPRINT' compose.yaml
grep -Fq 'npm ci --omit=dev --no-audit --no-fund' compose.yaml
grep -Fq 'node_modules/.dependency-fingerprint' compose.yaml
! grep -Eq 'bootstrap\.sh' compose.yaml
! grep -Eq '^  (document-parser|image-parser|ocr-service):' compose.yaml
for name in VLLM_BASE_URL VLLM_BASE_API_KEY VLLM_VISION_URL VLLM_VISION_MODEL VLLM_VISION_API_KEY; do
  grep -q "^${name}=" .env.example
done

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env.example config >/dev/null
else
  echo 'Docker Compose unavailable; static Compose checks passed.'
fi

echo 'Verification complete.'
