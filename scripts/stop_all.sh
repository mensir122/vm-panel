#!/usr/bin/env bash
# stop_all.sh — graceful shutdown: services → panel → manager.
# Desain: docs/DESIGN.md §15.2 t-03m..t-00.
set -euo pipefail

echo "[stop_all] graceful shutdown mulai"

# Panel dulu, lalu manager (manager terakhir: satu-satunya penulis DB).
for NAME in panel manager; do
  PIDFILE="runtime/pid/${NAME}-launcher.pid"
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo "[stop_all] stop ${NAME} (pid ${PID})"
      kill "$PID" 2>/dev/null || true
      for i in $(seq 1 20); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$PID" 2>/dev/null; then
        echo "[stop_all] ${NAME} tidak mati dengan SIGTERM → SIGKILL"
        kill -9 "$PID" 2>/dev/null || true
      fi
    else
      echo "[stop_all] ${NAME} sudah mati"
    fi
  fi
done

echo "[stop_all] selesai"
