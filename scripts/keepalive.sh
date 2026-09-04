#!/usr/bin/env bash
# keepalive.sh — loop utama runner: ping watchdog (chain-lock), tunggu drain,
# lalu self-chain. Desain: docs/DESIGN.md §15.1-15.2, D8a-D8c.
# Sisa waktu dihitung dari job started_at (GitHub API) — BUKAN jam runner.
set -euo pipefail

echo "[keepalive] mulai"

REPO="${GITHUB_REPOSITORY:-}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
RUN_ID="${GITHUB_RUN_ID:-}"
JOB_NAME="vm / vm"
JOB_TIMEOUT_MIN="${RUNNER_JOB_MINUTES:-360}"
DRAIN_MIN="${RUNNER_DRAIN_MINUTES:-15}"
CHAIN_LOCK_DIR="runtime"
mkdir -p "$CHAIN_LOCK_DIR" logs/manager

job_started_at() {
  # started_at job ini dari GitHub API (bukan Date.now runner).
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" \
    --jq ".jobs[] | select(.name == \"${JOB_NAME}\") | .started_at" 2>/dev/null | head -1
}

# --- tulis chain-lock awal (watchdog membaca expires_at dari artifact) ---
NOW_EPOCH=$(date +%s)
STARTED_ISO=$(job_started_at || true)
if [ -n "$STARTED_ISO" ]; then
  STARTED_EPOCH=$(date -u -d "$STARTED_ISO" +%s 2>/dev/null || echo "$NOW_EPOCH")
else
  STARTED_EPOCH="$NOW_EPOCH"
fi
EXPIRES_EPOCH=$(( STARTED_EPOCH + JOB_TIMEOUT_MIN * 60 ))
EXPIRES_ISO=$(date -u -d "@${EXPIRES_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)
cat > "${CHAIN_LOCK_DIR}/chain-lock.json" <<EOF
{ "run_id": "${RUN_ID}", "expires_at": "${EXPIRES_ISO}", "started_at": "${STARTED_ISO}" }
EOF
echo "[keepalive] chain-lock expires_at=${EXPIRES_ISO} (job started_at=${STARTED_ISO})"

DRAIN_EPOCH=$(( EXPIRES_EPOCH - DRAIN_MIN * 60 ))

# --- loop utama ---
while :; do
  NOW=$(date +%s)

  if [ "$NOW" -ge "$DRAIN_EPOCH" ]; then
    REMAIN_MIN=$(( (EXPIRES_EPOCH - NOW) / 60 ))
    echo "[keepalive] masuk drain window (t-${REMAIN_MIN} menit)"
    break
  fi

  # Health check periodik manager (jika mati → exit 1: health gate workflow).
  # /health wajib bearer token (runtime/sockets/cli-token ditulis manager saat start).
  PORT="${MANAGER_API_PORT:-8097}"
  AUTH=()
  if [ -f runtime/sockets/cli-token ] && [ -s runtime/sockets/cli-token ]; then
    TOKEN=$(tr -d '[:space:]' < runtime/sockets/cli-token)
    AUTH=(-H "Authorization: Bearer ${TOKEN}")
  fi
  if ! curl -sf --max-time 3 -o /dev/null "${AUTH[@]}" "http://127.0.0.1:${PORT}/health"; then
    echo "[keepalive] manager tidak merespons — cek apakah launcher masih hidup"
    if [ -f runtime/pid/manager-launcher.pid ] && ! kill -0 "$(cat runtime/pid/manager-launcher.pid)" 2>/dev/null; then
      echo "[keepalive] manager mati permanen → exit 1 (workflow health gate)"
      exit 1
    fi
  fi

  sleep 60
done

# --- drain: tolak deployment baru (manager: flag via API kalau ada) + tunggu queue kosong ---
echo "[keepalive] drain: tunggu queue kosong (max ${DRAIN_MIN} menit)"
sleep 60

# --- self-chain: dispatch runner berikutnya ---
echo "[self_chain] dispatch run berikutnya"
IN_PROGRESS=$(gh api "repos/${REPO}/actions/workflows/vm.yml/runs?status=in_progress" --jq '.total_count // 0')
if [ "${IN_PROGRESS}" -gt 1 ]; then
  echo "[self_chain] sudah ada run in_progress lain — skip dispatch (anti split-brain)"
else
  gh workflow run vm.yml --ref "${GITHUB_REF_NAME:-main}"
  echo "[self_chain] dispatched"
fi

# --- tunggu run baru terdeteksi (max 5 menit) ---
for i in $(seq 1 30); do
  NEW=$(gh api "repos/${REPO}/actions/workflows/vm.yml/runs?status=in_progress" \
    --jq "[.workflow_runs[] | select(.id != ${RUN_ID})] | length // 0")
  if [ "${NEW}" -ge 1 ]; then
    echo "[self_chain] runner baru terdeteksi — chain lanjut"
    exit 0
  fi
  sleep 10
done

echo "[self_chain] GAGAL: runner baru tidak muncul dalam 5 menit (recovery.yml watchdog akan mengambil alih)"
exit 1
