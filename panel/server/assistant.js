// panel/server/assistant.js — Backend bridge untuk Hermes Agent & 9Router
// Memfasilitasi komunikasi chat antara Web UI VM-Panel dan Hermes Agent Gateway
// (port 8642) atau fallback langsung ke 9Router (port 20127).

const GATEWAY_URL = process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:8642/v1';
const ROUTER_URL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:20127/v1';

/**
 * Cek status ketersediaan Hermes Gateway dan 9Router.
 */
export async function getAssistantStatus() {
  let gatewayOnline = false;
  let routerOnline = false;

  // 1. Cek Hermes Gateway (port 8642)
  try {
    const res = await fetch(`${GATEWAY_URL}/models`, {
      signal: AbortSignal.timeout(1200),
    }).catch(() => null);
    if (res && res.status < 500) {
      gatewayOnline = true;
    }
  } catch {
    gatewayOnline = false;
  }

  // 2. Cek 9Router (port 20127)
  try {
    const healthUrl = ROUTER_URL.replace(/\/v1\/?$/, '/api/health');
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    if (res && res.status < 500) {
      routerOnline = true;
    } else {
      const resModels = await fetch(`${ROUTER_URL}/models`, {
        signal: AbortSignal.timeout(1200),
      }).catch(() => null);
      if (resModels && resModels.status < 500) {
        routerOnline = true;
      }
    }
  } catch {
    routerOnline = false;
  }

  return {
    available: gatewayOnline || routerOnline,
    mode: gatewayOnline ? 'hermes' : routerOnline ? '9router-fallback' : 'offline',
    gatewayOnline,
    routerOnline,
    gatewayUrl: GATEWAY_URL,
    routerUrl: ROUTER_URL,
  };
}

/**
 * Tangani permintaan chat dari client browser.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleAssistantChat(req, res) {
  return new Promise((resolve) => {
    let bodyStr = '';
    req.on('data', (chunk) => {
      bodyStr += chunk;
      if (bodyStr.length > 1024 * 1024) {
        req.destroy();
      }
    });

    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(bodyStr || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        resolve();
        return;
      }

      const { message, history = [] } = payload;
      if (!message || typeof message !== 'string' || message.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Field message wajib diisi' }));
        resolve();
        return;
      }

      const status = await getAssistantStatus();

      // Bangun riwayat pesan format OpenAI
      const messages = [
        {
          role: 'system',
          content:
            'Anda adalah Hermes Agent, asisten AI otonom untuk VM-Panel. ' +
            'Anda membantu pengguna memantau status sistem (CPU, RAM, disk), ' +
            'mengelola service, dan mendeploy project dengan gaya ringkas, ramah, dan solutif. ' +
            'Format keluaran menggunakan Markdown yang rapi.',
        },
        ...history.slice(-10),
        { role: 'user', content: message },
      ];

      // 1. Jika Hermes Gateway aktif, teruskan ke Hermes Agent
      if (status.gatewayOnline) {
        try {
          const upstream = await fetch(`${GATEWAY_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer sk-vm-panel-local',
            },
            body: JSON.stringify({
              model: 'hermes',
              messages,
              stream: false,
            }),
            signal: AbortSignal.timeout(60_000),
          });

          if (upstream.ok) {
            const data = await upstream.json();
            const reply = data.choices?.[0]?.message?.content || '(Tidak ada balasan)';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ reply, source: 'hermes' }));
            resolve();
            return;
          }
        } catch (err) {
          console.warn(`[assistant] Hermes gateway error, beralih ke fallback: ${err.message}`);
        }
      }

      // 2. Jika Hermes offline tetapi 9Router aktif, hubungi 9Router langsung
      if (status.routerOnline) {
        try {
          const upstream = await fetch(`${ROUTER_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer dummy-local',
            },
            body: JSON.stringify({
              model: 'default',
              messages,
              stream: false,
            }),
            signal: AbortSignal.timeout(30_000),
          });

          if (upstream.ok) {
            const data = await upstream.json();
            const reply = data.choices?.[0]?.message?.content || '(Tidak ada balasan dari 9Router)';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                reply,
                source: '9router-fallback',
                notice: 'Dijawab langsung oleh 9Router (Hermes Gateway belum berjalan).',
              })
            );
            resolve();
            return;
          }
        } catch (err) {
          console.warn(`[assistant] 9Router error: ${err.message}`);
        }
      }

      // 3. Fallback informatif jika backend belum menyala
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          reply:
            '👋 **Hermes Agent** sedang disiapkan di sistem Anda.\n\n' +
            '- **Hermes Gateway (port 8642)**: ' +
            (status.gatewayOnline ? '🟢 Online' : '⚪ Sedang menunggu start (`node scripts/hermes_gateway.mjs`)') +
            '\n- **9Router LLM (port 20127)**: ' +
            (status.routerOnline ? '🟢 Online' : '⚪ Offline / Standby') +
            '\n\nSetelah service menyala, Hermes Agent akan siap melayani perintah manajemen sistem Anda secara penuh!',
          source: 'system-notice',
        })
      );
      resolve();
    });
  });
}
