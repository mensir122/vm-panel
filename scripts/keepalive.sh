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

# --- tulis runner-specs.json (ekspresi identik step "Runner specs" vm.yml
#     + runnerId/capturedAt) — file non-secret, di-commit ke branch 'state'
#     pada fase drain (lihat bagian commit di bawah) ---
RUN_ID="$RUN_ID" node -p "JSON.stringify((()=>{const os=require('os'),fs=require('fs');const s=fs.statfsSync('.');return {CPU:os.cpus()[0].model.trim(),Cores:os.cpus().length,RAM_GB:+(os.totalmem()/2**30).toFixed(1),Disk_free_GB:+(s.bfree*s.bsize/2**30).toFixed(1),Disk_total_GB:+(s.blocks*s.bsize/2**30).toFixed(1),OS:os.type()+' '+os.release(),runnerId:String(process.env.RUN_ID||''),capturedAt:new Date().toISOString()}})())" > "${CHAIN_LOCK_DIR}/runner-specs.json"
echo "[keepalive] runner-specs ditulis: ${CHAIN_LOCK_DIR}/runner-specs.json"

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

# --- VAULT BRANCH: commit runner-specs.json ke branch 'state' (JUGA) ---
# Duplikasi disiplin pola vault_put di backup_final.sh (gh api PUT
# contents/<file>, sha lama / auto-create branch) — file kecil non-secret,
# sengaja tidak dipindahkan ke modul bersama agar pola tiap script tetap
# self-contained seperti desain scripts/ yang ada.
SPECS_FILE="${CHAIN_LOCK_DIR}/runner-specs.json"
if [ -n "${GH_TOKEN:-}" ] && [ -n "${REPO:-}" ] && [ -s "${SPECS_FILE}" ]; then
  SPECS_B64=$(base64 -w0 "${SPECS_FILE}")
  specs_vault_put() {
    local OLD_SHA="$1" BODY
    # NB: kirim data via ENV, bukan argv — pola yang sama dengan vault_put
    # di backup_final.sh (`node -e` punya model argv berbeda).
    BODY=$(
      export RUN_ID SPECS_B64 OLD_SHA
      node --input-type=module -e "
        console.log(JSON.stringify({
          message: 'state: runner-specs run ' + (process.env.RUN_ID || 'unknown') + ' (auto)',
          branch: 'state',
          content: process.env.SPECS_B64,
          sha: process.env.OLD_SHA || undefined,
        }));
      "
    )
    gh api -X PUT "repos/${REPO}/contents/runner-specs.json" --input - <<< "${BODY}" > /dev/null 2>&1
  }
  OLD_SPECS_SHA=$(gh api "repos/${REPO}/contents/runner-specs.json?ref=state" --jq '.sha // empty' 2>/dev/null || true)
  if specs_vault_put "${OLD_SPECS_SHA}"; then
    echo "[keepalive] runner-specs.json di-commit ke branch 'state'"
  else
    # branch 'state' mungkin belum ada -> buat dari HEAD, lalu retry sekali
    HEAD_SHA=$(gh api "repos/${REPO}/git/refs/heads/${GITHUB_REF_NAME:-main}" --jq '.object.sha' 2>/dev/null || true)
    if gh api -X POST "repos/${REPO}/git/refs" -f ref=refs/heads/state -f sha="${HEAD_SHA}" > /dev/null 2>&1 \
       && specs_vault_put ""; then
      echo "[keepalive] branch 'state' dibuat + runner-specs.json tersimpan"
    else
      echo "[keepalive] PERINGATAN: commit runner-specs gagal (artifact chain tetap jalan)"
    fi
  fi
else
  echo "[keepalive] GH_TOKEN/REPO/specs tidak lengkap — skip commit runner-specs"
fi

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
