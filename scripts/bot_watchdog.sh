#!/usr/bin/env bash
# scripts/bot_watchdog.sh
# 24/7 Watchdog for OriontClipper bot: checks every 20 seconds.
# If bot is not running, restarts it automatically and logs event.
set -euo pipefail

BOT_DIR="/home/runner/OriontClipper"
LOG_FILE="${BOT_DIR}/watchdog.log"

echo "[bot_watchdog] Watchdog daemon started."

while true; do
  if [ -d "${BOT_DIR}" ]; then
    if ! pgrep -f 'python.*bot\.py' >/dev/null 2>&1; then
      echo "[bot_watchdog] Bot process is not running. Restarting..." >> "${LOG_FILE}" 2>&1 || true
      (
        export PATH="/home/runner/.deno/bin:${PATH}"
        cd "${BOT_DIR}" || exit 1
        if [ -f "start_bot.py" ]; then
          python3 start_bot.py >> "${LOG_FILE}" 2>&1 || true
        else
          nohup python3 bot.py >> bot.log 2>&1 &
        fi
      ) || true
      echo "[bot_watchdog] Restart attempt complete." >> "${LOG_FILE}" 2>&1 || true
    fi
  fi
  sleep 20
done
