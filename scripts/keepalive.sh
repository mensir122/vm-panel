#!/usr/bin/env bash
# keepalive.sh - loop utama runner: chain-lock, health poll, drain, self-chain.
# Desain: docs/DESIGN.md S15.1-15.2, D8a-D8c.
# Sisa waktu dihitung dari job started_at (GitHub API) - BUKAN jam runner.
set -euo pipefail

echo "[keepalive] mulai"

REPO="${GITHUB_REPOSITORY:-}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
RUN_ID="${GITHUB_RUN_ID:-}"
JOB_NAME="vm"   # nama job di API jobs = field name: di vm.yml (bukan 'vm / vm')
JOB_TIMEOUT_MIN="${RUNNER_JOB_MINUTES:-360}"
DRAIN_MIN="${RUNNER_DRAIN_MINUTES:-15}"
CHAIN_LOCK_DIR="runtime"
mkdir -p "$CHAIN_LOCK_DIR" logs/manager

job_started_at() {
  # started_at job ini dari GitHub API (bukan Date.now runner).
  # NB: jobs API mengembalikan nama job apa adanya ('vm'), bukan 'vm / vm'.
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

  # Health check periodik manager (jika mati - exit 1: health gate workflow).
  # /health wajib bearer token (runtime/sockets/cli-token ditulis manager saat start).
  PORT="${MANAGER_API_PORT:-8097}"
  AUTH=()
  if [ -f runtime/sockets/cli-token ] && [ -s runtime/sockets/cli-token ]; then
    TOKEN=$(tr -d '[:space:]' < runtime/sockets/cli-token)
    AUTH=(-H "Authorization: Bearer ${TOKEN}")
  fi
  if ! curl -sf --max-time 3 -o /dev/null "${AUTH[@]}" "http://127.0.0.1:${PORT}/health"; then
    echo "[keepalive] manager tidak merespons - cek apakah launcher masih hidup"
    if [ -f runtime/pid/manager-launcher.pid ] && ! kill -0 "$(cat runtime/pid/manager-launcher.pid)" 2>/dev/null; then
      echo "[keepalive] manager mati permanen - exit 1 (workflow health gate)"
      exit 1
    fi
  fi

  sleep 60
done

# --- drain: tolak deployment baru (manager: flag via API kalau ada) + tunggu queue kosong ---
echo "[keepalive] drain: tunggu queue kosong (max ${DRAIN_MIN} menit)"
sleep 60

# --- self-chain: dispatch runner berikutnya ---
# NB: karena concurrency group 'vm-chain', run baru akan berstatus QUEUED
# sampai run ini selesai. Deteksi harus menghitung queued + in_progress.
echo "[self_chain] dispatch run berikutnya"
ACTIVE_OTHER=$(gh api "repos/${REPO}/actions/workflows/vm.yml/runs?per_page=100" \
  --jq "[.workflow_runs[] | select(.id != ${RUN_ID} and .status != \"completed\" and .conclusion == null)] | length // 0")
if [ "${ACTIVE_OTHER}" -gt 0 ]; then
  echo "[self_chain] sudah ada run aktif lain - skip dispatch (anti split-brain)"
else
  gh workflow run vm.yml --ref "${GITHUB_REF_NAME:-main}"
  echo "[self_chain] dispatched"
fi

# --- tunggu run baru (queued atau in_progress) terdeteksi (max 5 menit) ---
for i in $(seq 1 30); do
  NEW=$(gh api "repos/${REPO}/actions/workflows/vm.yml/runs?per_page=100" \
    --jq "[.workflow_runs[] | select(.id != ${RUN_ID} and .status != \"completed\")] | length // 0")
  if [ "${NEW}" -ge 1 ]; then
    echo "[self_chain] runner baru terdeteksi (queued/in_progress) - chain lanjut"
    exit 0
  fi
  sleep 10
done

echo "[self_chain] GAGAL: runner baru tidak muncul dalam 5 menit (recovery.yml watchdog akan mengambil alih)"
exit 1
