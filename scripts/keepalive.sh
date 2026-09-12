#!/usr/bin/env bash
# keepalive.sh - loop utama runner: chain-lock heartbeat, health poll, drain, self-chain.
# Desain: docs/DESIGN.md S15.1-15.2, D8a-D8c.
# Sisa waktu dihitung dari job started_at (GitHub API) - BUKAN jam runner.
# chain-lock.json = HEARTBEAT: ditulis ULANG tiap loop dengan expires_at =
# now + TTL (4 menit). Watchdog recovery.yml hanya boleh mengambil alih bila
# heartbeat berhenti (runner mati/nyangkut), bukan menunggu 6 jam kadaluarsa.
set -euo pipefail

echo "[keepalive] mulai"

REPO="${GITHUB_REPOSITORY:-}"
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
RUN_ID="${GITHUB_RUN_ID:-}"
JOB_NAME="vm"   # nama job di API jobs = field name: di vm.yml (bukan 'vm / vm')
JOB_TIMEOUT_MIN="${RUNNER_JOB_MINUTES:-360}"
DRAIN_MIN="${RUNNER_DRAIN_MINUTES:-15}"
CHAIN_LOCK_DIR="runtime"
# Heartbeat chain-lock: TTL 4 menit, refresh tiap loop (60s) -> selalu ada margin 3x.
CHAIN_LOCK_TTL_SEC="${RUNNER_CHAIN_LOCK_TTL_SEC:-240}"
HEARTBEAT_SEC="${RUNNER_HEARTBEAT_SEC:-60}"
DRAIN_POLL_SEC="${RUNNER_DRAIN_POLL_SEC:-15}"
# Cadangan waktu setelah drain untuk final backup + commit vault + self-chain dispatch.
FINAL_RESERVE_SEC="${RUNNER_FINAL_RESERVE_SEC:-300}"
# Retry dispatch gh workflow run (3x, backoff eksponensial).
DISPATCH_ATTEMPTS="${RUNNER_DISPATCH_ATTEMPTS:-3}"
DISPATCH_BACKOFF_SEC="${RUNNER_DISPATCH_BACKOFF_SEC:-10}"
mkdir -p "$CHAIN_LOCK_DIR" logs/manager

job_started_at() {
  # started_at job ini dari GitHub API (bukan Date.now runner).
  # NB: jobs API mengembalikan nama job apa adanya ('vm'), bukan 'vm / vm'.
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" \
    --jq ".jobs[] | select(.name == \"${JOB_NAME}\") | .started_at" 2>/dev/null | head -1
}

retry_gh() {
  # retry_gh <label> <max> <backoff_sec> <cmd...> - ulangi cmd dengan backoff
  # eksponensial (backoff, 2x, 4x). Return 0 sukses, 1 setelah semua percobaan gagal.
  local label="$1" max="$2" delay="$3"
  shift 3
  local n=1
  while :; do
    if "$@"; then
      if [ "$n" -gt 1 ]; then
        echo "[keepalive] ${label} sukses pada percobaan ${n}/${max}"
      fi
      return 0
    fi
    if [ "$n" -ge "$max" ]; then
      echo "[keepalive] ${label} GAGAL setelah ${n} percobaan"
      return 1
    fi
    echo "[keepalive] ${label} percobaan ${n}/${max} gagal - backoff ${delay}s"
    sleep "$delay"
    delay=$(( delay * 2 ))
    n=$(( n + 1 ))
  done
}

queue_busy_count() {
  # Polling NYATA antrean kerja via API manager lokal (pengganti sleep buta):
  # deployment status 'running'/'installing' + layanan dengan supervisor masih
  # 'recovering'/'starting' atau backoff belum lewat. Output: angka busy,
  # 'unreachable' bila API manager tidak bisa dihubungi.
  MANAGER_API_PORT="${MANAGER_API_PORT:-8097}" node -e '
    const fs = require("fs");
    const port = process.env.MANAGER_API_PORT || "8097";
    const base = "http://127.0.0.1:" + port;
    let bearer = null;
    try {
      const raw = fs.readFileSync("runtime/sockets/cli-token", "utf8").trim();
      if (raw) bearer = raw;
    } catch { /* tanpa token: minta tanpa header */ }
    const headers = bearer ? { authorization: "Bearer " + bearer } : {};
    const get = async (p) => {
      try {
        const r = await fetch(base + p, { headers, signal: AbortSignal.timeout(4000) });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    };
    (async () => {
      const [run, inst, rec] = await Promise.all([
        get("/deployments?status=running&limit=100"),
        get("/deployments?status=installing&limit=100"),
        get("/recovery/status"),
      ]);
      if (run === null && inst === null && rec === null) {
        console.log("unreachable");
        return;
      }
      let busy = 0;
      for (const rows of [run?.rows, inst?.rows]) {
        if (Array.isArray(rows)) busy += rows.length;
      }
      if (rec && Array.isArray(rec.rows)) {
        const now = Date.now();
        for (const row of rec.rows) {
          const sup = row && row.supervisor ? row.supervisor : {};
          const st = sup.state;
          let pendingBackoff = false;
          if (sup.backoffUntil != null) {
            const t = Date.parse(String(sup.backoffUntil));
            pendingBackoff = Number.isFinite(t) ? t > now : true;
          }
          if (st === "recovering" || st === "starting" || st === "queued" || pendingBackoff) busy += 1;
        }
      }
      console.log(String(busy));
    })();
  '
}

# --- tulis chain-lock awal (watchdog membaca expires_at dari artifact) ---
NOW_EPOCH=$(date +%s)
STARTED_ISO=$(job_started_at || true)
if [ -n "$STARTED_ISO" ]; then
  STARTED_EPOCH=$(date -u -d "$STARTED_ISO" +%s 2>/dev/null || echo "$NOW_EPOCH")
else
  STARTED_EPOCH="$NOW_EPOCH"
fi
# Deadline JOB (untuk drain) - berbeda dari expires_at chain-lock (heartbeat TTL).
EXPIRES_EPOCH=$(( STARTED_EPOCH + JOB_TIMEOUT_MIN * 60 ))

write_chain_lock() {
  # Heartbeat: chain-lock.json ditulis ULANG -> expires_at = now + TTL (ISO UTC 'Z').
  local now_s exp_s now_iso exp_iso
  now_s=$(date +%s)
  exp_s=$(( now_s + CHAIN_LOCK_TTL_SEC ))
  now_iso=$(date -u -d "@${now_s}" +%Y-%m-%dT%H:%M:%SZ)
  exp_iso=$(date -u -d "@${exp_s}" +%Y-%m-%dT%H:%M:%SZ)
  cat > "${CHAIN_LOCK_DIR}/chain-lock.json" <<EOF
{ "run_id": "${RUN_ID}", "expires_at": "${exp_iso}", "started_at": "${STARTED_ISO}", "heartbeat_at": "${now_iso}", "ttl_seconds": ${CHAIN_LOCK_TTL_SEC} }
EOF
  echo "$exp_iso"
}

LOCK_EXPIRES_ISO=$(write_chain_lock)
echo "[keepalive] chain-lock heartbeat expires_at=${LOCK_EXPIRES_ISO} (ttl ${CHAIN_LOCK_TTL_SEC}s, job started_at=${STARTED_ISO}, job deadline=$(date -u -d "@${EXPIRES_EPOCH}" +%Y-%m-%dT%H:%M:%SZ))"

# --- tulis runner-specs.json (ekspresi identik step "Runner specs" vm.yml
#     + runnerId/capturedAt) — file non-secret, di-commit ke branch 'state'
#     pada fase drain (lihat bagian commit di bawah) ---
RUN_ID="$RUN_ID" node -p "JSON.stringify((()=>{const os=require('os'),fs=require('fs');const s=fs.statfsSync('.');return {CPU:os.cpus()[0].model.trim(),Cores:os.cpus().length,RAM_GB:+(os.totalmem()/2**30).toFixed(1),Disk_free_GB:+(s.bfree*s.bsize/2**30).toFixed(1),Disk_total_GB:+(s.blocks*s.bsize/2**30).toFixed(1),OS:os.type()+' '+os.release(),runnerId:String(process.env.RUN_ID||''),capturedAt:new Date().toISOString()}})())" > "${CHAIN_LOCK_DIR}/runner-specs.json"
echo "[keepalive] runner-specs ditulis: ${CHAIN_LOCK_DIR}/runner-specs.json"

DRAIN_EPOCH=$(( EXPIRES_EPOCH - DRAIN_MIN * 60 ))

# --- loop utama (heartbeat) ---
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

  # HEARTBEAT: refresh chain-lock tiap loop agar watchdog tidak salah ambil alih.
  LOCK_EXPIRES_ISO=$(write_chain_lock)
  sleep "$HEARTBEAT_SEC"
done

# --- drain: tolak deployment baru + polling antrean sampai KOSONG atau deadline ---
# Deadline drain = min(now + DRAIN_MIN, job deadline - FINAL_RESERVE). Bila deadline
# tercapai tapi antrean belum kosong -> LANJUT chain (skip, bukan gagal): run
# berikutnya tetap menerima deployment yang tertinggal via manifest/restore.
DRAIN_DEADLINE=$(( $(date +%s) + DRAIN_MIN * 60 ))
RESERVE_DEADLINE=$(( EXPIRES_EPOCH - FINAL_RESERVE_SEC ))
if [ "$RESERVE_DEADLINE" -lt "$DRAIN_DEADLINE" ]; then
  DRAIN_DEADLINE="$RESERVE_DEADLINE"
fi
echo "[keepalive] drain: polling antrean kerja tiap ${DRAIN_POLL_SEC}s (deadline epoch ${DRAIN_DEADLINE})"
while :; do
  LOCK_EXPIRES_ISO=$(write_chain_lock)
  BUSY=$(queue_busy_count 2>/dev/null || echo unreachable)
  case "$BUSY" in
    ''|*[!0-9]*)
      if [ "$BUSY" = "unreachable" ]; then
        echo "[keepalive] drain: API manager tak terjangkau - anggap antrean idle (lanjut chain)"
      else
        echo "[keepalive] drain: hasil polling tak terbaca (${BUSY}) - anggap idle"
      fi
      BUSY=0
      ;;
  esac
  if [ "$BUSY" -eq 0 ]; then
    echo "[keepalive] drain: antrean kerja kosong - lanjut finalisasi"
    break
  fi
  echo "[keepalive] drain: ${BUSY} item masih sibuk"
  NOW=$(date +%s)
  if [ "$NOW" -ge "$DRAIN_DEADLINE" ]; then
    echo "[keepalive] drain: deadline tercapai dengan ${BUSY} item sibuk - skip drain, lanjut chain (bukan gagal)"
    break
  fi
  sleep "$DRAIN_POLL_SEC"
done

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

# --- self-chain: dispatch runner berikutnya (retry + backoff) ---
# NB: karena concurrency group 'vm-chain', run baru akan berstatus QUEUED
# sampai run ini selesai. Deteksi harus menghitung queued + in_progress.
echo "[self_chain] dispatch run berikutnya"
ACTIVE_OTHER=$(gh api "repos/${REPO}/actions/workflows/vm.yml/runs?per_page=100" \
  --jq "[.workflow_runs[] | select(.id != ${RUN_ID} and .status != \"completed\" and .conclusion == null)] | length // 0")
if [ "${ACTIVE_OTHER}" -gt 0 ]; then
  echo "[self_chain] sudah ada run aktif lain (${ACTIVE_OTHER}) - skip dispatch (anti split-brain)"
elif ! retry_gh "[self_chain] gh workflow run vm.yml" "$DISPATCH_ATTEMPTS" "$DISPATCH_BACKOFF_SEC" \
       gh workflow run vm.yml --ref "${GITHUB_REF_NAME:-main}"; then
  echo "[self_chain] dispatch gagal permanen - recovery.yml watchdog akan mengambil alih"
  exit 1
else
  echo "[self_chain] dispatched"
fi

# --- tunggu run baru (queued atau in_progress) terdeteksi (max 5 menit) ---
for i in $(seq 1 30); do
  LOCK_EXPIRES_ISO=$(write_chain_lock)
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
