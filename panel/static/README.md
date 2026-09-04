# panel/static — UI assets

Static assets for the VPANEL web console (SSR, no build step, no
frameworks, no external/CDN references).

## Files

| File        | Purpose |
|-------------|---------|
| `panel.css` | Single stylesheet. Design tokens (near-black `#0a0a0a` base, one blue accent `#58a6ff`, semantic status colors), app shell (sidebar / topbar), components (cards, tables, status dots, badges, buttons, forms, bars, alerts, tabs, empty states, log viewer, confirm dialog), responsive breakpoints (sidebar collapses to a topbar nav below 1024px). System font stacks only; `ui-monospace` for IDs, ports, revisions, timestamps and logs. |
| `panel.js`  | Progressive enhancement only. (1) Two-phase confirm: any element with `data-confirm` (+ optional `data-confirm-detail`, `data-confirm-phrase`) opens a native `<dialog>` with typed-name confirmation, injected by the script — templates do not include the dialog markup. (2) Log auto-scroll: `[data-autoscroll]` stays pinned to the bottom while the operator is near the bottom. No dependencies, no network calls, no storage. |

## Serving contract

- Both files are served under `/static/` (e.g. `/static/panel.css`).
  Templates reference them with absolute paths; adjust the mount point
  in `panel/server/` if the panel is served under a subpath.
- `Content-Type`: `text/css` and `text/javascript` respectively. Cache
  headers are the server's concern; a short max-age with cache-busting
  query param is sufficient.

## Rules for changes

- No emoji, no external fonts, no CDN links, no inline event handlers.
- Transitions are hover/focus only, 150ms max.
- Status colors are reserved for status: healthy `#3fb950`,
  degraded `#e3b341`, unhealthy/crash-loop `#f85149`,
  stopped/disabled/unknown gray variants (see `panel.css` tokens).
- Template integration contract (placeholder keys, fragment shapes)
  is documented per page in `panel/templates/*.html` file headers.
