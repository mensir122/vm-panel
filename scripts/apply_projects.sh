#!/usr/bin/env bash
# apply_projects.sh - auto-deploy project dari projects.auto.json di setiap
# siklus GitHub Actions. Dipanggil vm.yml setelah "Health gate".
# Prasyarat: manager hidup (health gate lulus). Gagal satu entry TIDAK
# menghentikan entry lain. Exit 1 hanya bila manager tidak hidup.
# Desain: docs/DESIGN.md S15.2 (siklus), docs/DATA-GUIDE.md (persisten state).
set -euo pipefail

echo "[apply_projects] mulai"

MP="${MANAGER_API_PORT:-8097}"
REPO="${GITHUB_REPO:-mensir122/vm-panel}"
MANIFEST="projects.auto.json"
TOKEN_FILE="runtime/sockets/cli-token"

# Manager wajib hidup (bearer token) - kalau tidak, gagalkan (health gate
# sudah lulus, jadi ini seharusnya tidak pernah terjadi).
if [ ! -f "$TOKEN_FILE" ] || [ ! -s "$TOKEN_FILE" ]; then
  echo "[apply_projects] GAGAL: cli-token tidak ada (manager belum start)"
  exit 1
fi
TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
AUTH=(-H "Authorization: Bearer ${TOKEN}")

if ! curl -sf --max-time 5 -o /dev/null "${AUTH[@]}" "http://127.0.0.1:${MP}/health"; then
  echo "[apply_projects] GAGAL: manager tidak hidup"
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "[apply_projects] tidak ada $MANIFEST - skip"
  exit 0
fi

# npm di runner GHA (POSIX) = 'npm'; NODE_PATH hanya untuk diagnostic.
ok=0; skip=0; fail=0

# Iterasi manifest via node (JSON robust, tanpa dependency jq).
ENTRIES=$(node --input-type=module -e "
import fs from 'node:fs';
const list = JSON.parse(fs.readFileSync('${MANIFEST}', 'utf8'));
for (const e of list) {
  if (e.enabled === false) continue;
  console.log([e.name ?? '', e.type ?? 'node', e.port ?? '', e.repo_url ?? '', e.git_branch ?? 'main'].join('\t'));
}
")

while IFS=$'\t' read -r NAME TYPE PORT REPO_URL BRANCH; do
  [ -z "$NAME" ] && continue
  echo "[apply_projects] entry: name=${NAME} type=${TYPE} port=${PORT} branch=${BRANCH}"

  # (1) Project sudah terdaftar? (match by name)
  export NM="$NAME" TP="$TYPE" PT="$PORT" RU="$REPO_URL" BR="$BRANCH"
  EXISTING_ID=$(curl -sf --max-time 5 "${AUTH[@]}" "http://127.0.0.1:${MP}/projects" \
    | node --input-type=module -e "
let s=''; process.stdin.on('data', d => s += d).on('end', () => {
  try {
    const rows = JSON.parse(s);
    const hit = rows.find(r => r.name === process.env.NM);
    console.log(hit ? hit.id : '');
  } catch { console.log(''); }
});
" 2>/dev/null) || EXISTING_ID=''

  if [ -z "$EXISTING_ID" ]; then
    echo "[apply_projects] register project ${NAME}..."
    CREATE_BODY=$(node --input-type=module -e "
console.log(JSON.stringify({ name: process.env.NM, type: process.env.TP, port: Number(process.env.PT) || undefined, repo_url: process.env.RU || undefined, git_branch: process.env.BR || 'main' }));
")
    CREATE_RES=$(curl -sf --max-time 15 -X POST -H "Content-Type: application/json" "${AUTH[@]}" \
      -d "$CREATE_BODY" "http://127.0.0.1:${MP}/projects" 2>&1) || { echo "[apply_projects] register ${NAME} GAGAL"; fail=$((fail+1)); continue; }
    EXISTING_ID=$(echo "$CREATE_RES" | node --input-type=module -e "
let s=''; process.stdin.on('data', d => s += d).on('end', () => { try { console.log(JSON.parse(s).id ?? ''); } catch { console.log(''); } });
")
    echo "[apply_projects] registered: ${EXISTING_ID}"
  else
    echo "[apply_projects] project sudah terdaftar: ${EXISTING_ID}"
  fi

  # (2) Service sudah running? (deploy idempoten - skip bila sudah sehat)
  SVC_STATUS=$(curl -sf --max-time 5 "${AUTH[@]}" "http://127.0.0.1:${MP}/services?projectId=${EXISTING_ID}" \
    | node --input-type=module -e "
let s=''; process.stdin.on('data', d => s += d).on('end', () => {
  try { const r = JSON.parse(s).rows ?? []; const hit = r[0]; console.log(hit ? hit.status : 'none'); } catch { console.log('none'); }
});
" 2>/dev/null) || SVC_STATUS='none'

  if [ "$SVC_STATUS" = "running" ]; then
    echo "[apply_projects] ${NAME} sudah running - skip (deploy idempoten)"
    skip=$((skip+1))
    continue
  fi

  # (3) Deploy (sinkron; build Next.js bisa 3-8 menit -> curl timeout 600s).
  echo "[apply_projects] deploy ${NAME} (service status: ${SVC_STATUS})..."
  DEPLOY_RES=$(curl -sf --max-time 600 -X POST -H "Content-Type: application/json" "${AUTH[@]}" \
    -d '{"source":{"type":"git"}}' "http://127.0.0.1:${MP}/projects/${EXISTING_ID}/deploy" 2>&1) \
    && ok=$((ok+1)) && echo "[apply_projects] deploy ${NAME}: OK" \
    || { echo "[apply_projects] deploy ${NAME}: GAGAL - ${DEPLOY_RES}"; fail=$((fail+1)); }

done <<< "$ENTRIES"

echo "[apply_projects] ringkasan: ok=${ok} skip=${skip} fail=${fail}"
exit 0
