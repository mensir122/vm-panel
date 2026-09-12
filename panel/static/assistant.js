/* ============================================================
   VPANEL — assistant.js
   Interactive Cyber Obsidian & Electric Cyan Chat Drawer
   Powered by Hermes Agent & 9Router. NO EMOJIS, pure vector SVG.
   ============================================================ */
(function () {
  'use strict';

  // ---- Public API (progressive enhancement) -----------------------------
  // Dipasang paling awal agar aman dipanggil sebelum drawer siap.
  // Panggilan sebelum init masuk defer queue sederhana, lalu di-flush
  // begitu fungsi drawer tersedia. Bukan rewrite drawer — hanya wrapper.
  var pendingCalls = [];
  var liveApi = null;

  window.vpAssistant = {
    open: function () { dispatch('open'); },
    close: function () { dispatch('close'); },
    toggle: function () { dispatch('toggle'); },
    isOpen: function () { return liveApi ? liveApi.isOpen() : false; }
  };

  function dispatch(action) {
    if (liveApi) {
      if (action === 'open') liveApi.open();
      else if (action === 'close') liveApi.close();
      else liveApi.toggle();
      return;
    }
    pendingCalls.push(action);
  }

  function flushPending() {
    while (pendingCalls.length) {
      dispatch(pendingCalls.shift());
    }
  }
  // ------------------------------------------------------------------------

  // Hanya aktifkan jika user sudah login (ada topbar dan bukan halaman auth)
  if (document.body.classList.contains('auth') || !document.querySelector('.topbar')) {
    return;
  }

  let isOpen = false;
  let isSending = false;
  const history = [];

  // Helper escape HTML
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  // Pure SVG Icons (No Emojis anywhere)
  const ICONS = {
    aiChip: `<svg class="assistant-svg-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>`,
    hermesLogo: `<svg class="assistant-svg-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"></polygon><line x1="12" y1="22" x2="12" y2="15.5"></line><polyline points="22 8.5 12 15.5 2 8.5"></polyline><polyline points="2 15.5 12 8.5 22 15.5"></polyline><line x1="12" y1="2" x2="12" y2="8.5"></line></svg>`,
    agentAvatar: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
    userAvatar: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
    close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
    send: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`,
    copy: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
    check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    chipStatus: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
    chipService: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,
    chipRouter: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"></path><path d="M1.42 9a16 16 0 0 1 21.16 0"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>`,
    chipDeploy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
  };

  // Modern, Compact Markdown Parser with Table, Badges & Code Blocks support
  function renderMarkdown(raw) {
    if (!raw) return '';
    let text = String(raw).replace(/\r\n/g, '\n').trim();

    // 1. Strip emojis and normalize status indicators early
    text = text.replace(/🟢\s*(\w+)?/g, '[OK]');
    text = text.replace(/🟡\s*(\w+)?/g, '[WARN]');
    text = text.replace(/🔴\s*(\w+)?/g, '[CRITICAL]');
    text = text.replace(/⚪\s*(\w+)?/g, '[STANDBY]');
    text = text.replace(/[⚡🧩📡⚠️🚀📦🧭🛠️👤☤]/g, '');

    // 2. Extract Code Blocks before escaping
    const codeBlocks = [];
    text = text.replace(/```(?:([a-zA-Z0-9_#-]+)\n)?([\s\S]*?)```/g, function (_, lang, code) {
      const id = '%%CODEBLOCK_' + codeBlocks.length + '%%';
      codeBlocks.push({ lang: (lang || 'sh').toLowerCase(), code: code.trim() });
      return id;
    });

    // 3. Escape HTML
    text = escapeHtml(text);

    // 4. Parse Markdown Tables (| col | col |) robustly with or without trailing newlines
    text = (text + '\n').replace(/(?:^|\n)((?:[ \t]*\|[^\n]+\|[ \t]*\n)+)/g, function (match, tableBlock) {
      const lines = tableBlock.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) return match;

      const sepLine = lines[1];
      if (!/^\|[\s:|-]+\|$/.test(sepLine)) return match;

      const parseRow = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const headerCells = parseRow(lines[0]);
      const bodyLines = lines.slice(2);

      let html = '<div class="assistant-table-wrap"><table class="assistant-table"><thead><tr>';
      for (const h of headerCells) {
        html += `<th>${h}</th>`;
      }
      html += '</tr></thead><tbody>';
      for (const row of bodyLines) {
        if (!row.startsWith('|')) continue;
        const cells = parseRow(row);
        html += '<tr>';
        for (let i = 0; i < headerCells.length; i++) {
          const val = cells[i] !== undefined ? cells[i] : '';
          html += `<td>${val}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      return '\n\n' + html + '\n\n';
    }).trim();

    // 5. Headings
    text = text.replace(/^###\s*(.+)$/gm, '<h4 class="assistant-heading">$1</h4>');
    text = text.replace(/^##\s*(.+)$/gm, '<h3 class="assistant-heading assistant-heading--lg">$1</h3>');
    text = text.replace(/^#\s*(.+)$/gm, '<h2 class="assistant-heading assistant-heading--xl">$1</h2>');

    // 6. Horizontal rules (--- or ***)
    text = text.replace(/^(?:---|___|\*\*\*)$/gm, '<div class="assistant-divider"></div>');

    // 7. Blockquotes / callouts
    text = text.replace(/^>\s*(?:\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])?\s*(.+)$/gm, '<div class="assistant-callout">$1</div>');

    // 8. Inline code `code`
    text = text.replace(/`([^`]+)`/g, '<code class="assistant-inline-code">$1</code>');

    // 9. Bold **text**
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // 10. Italic *text*
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // 11. Unordered lists
    text = text.replace(/^[*-]\s+(.+)$/gm, '<li class="assistant-list-item">$1</li>');
    text = text.replace(/(<li[\s\S]*?<\/li>)/g, '<ul class="assistant-list">$1</ul>');

    // 12. Status Badges
    text = text.replace(/\[(OK|NORMAL|RUNNING|ONLINE|HEALTHY|STABIL|IDLE|READY)\]/gi, '<span class="assistant-badge assistant-badge--success"><span class="assistant-badge__dot"></span>$1</span>');
    text = text.replace(/\[(WARN|WASPADA|STANDBY|KOSONG)\]/gi, '<span class="assistant-badge assistant-badge--warning"><span class="assistant-badge__dot"></span>$1</span>');
    text = text.replace(/\[(CRITICAL|KRITIS|DANGER|OFFLINE|ERROR|FAIL)\]/gi, '<span class="assistant-badge assistant-badge--danger"><span class="assistant-badge__dot"></span>$1</span>');

    // 13. Restore Code Blocks with Header & Copy Button
    for (let i = 0; i < codeBlocks.length; i++) {
      const block = codeBlocks[i];
      const token = '%%CODEBLOCK_' + i + '%%';
      const escapedCode = escapeHtml(block.code);
      const codeHtml = (
        '<div class="assistant-code-block">' +
          '<div class="assistant-code-header">' +
            '<span class="assistant-code-lang">' + escapeHtml(block.lang) + '</span>' +
            '<button type="button" class="assistant-copy-btn" data-code="' + escapeHtml(block.code) + '" title="Salin perintah">' +
              ICONS.copy + '<span>Salin</span>' +
            '</button>' +
          '</div>' +
          '<pre class="assistant-code" tabindex="0"><code>' + escapedCode + '</code></pre>' +
        '</div>'
      );
      text = text.replace(token, codeHtml);
    }

    // 14. Paragraphs and block formatting
    const blocks = text.split(/\n{2,}/);
    const formatted = blocks.map((b) => {
      const trimmed = b.trim();
      if (!trimmed) return '';
      if (/^<(?:div|h2|h3|h4|ul|ol|table|blockquote|pre)/i.test(trimmed)) {
        return trimmed;
      }
      return `<p class="assistant-p">${trimmed.replace(/\n/g, '<br>')}</p>`;
    });

    return formatted.filter(Boolean).join('\n');
  }

  // Buat DOM Trigger Button
  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'assistant-trigger';
  triggerBtn.id = 'vp-assistant-trigger';
  triggerBtn.setAttribute('aria-label', 'Buka Hermes AI Assistant');
  triggerBtn.innerHTML = `
    <span class="assistant-trigger__glow"></span>
    <span class="assistant-trigger__icon">${ICONS.aiChip}</span>
    <span class="assistant-trigger__text">Hermes AI</span>
    <span class="assistant-trigger__badge" id="vp-assistant-status-dot"></span>
  `;

  // Buat DOM Drawer
  const drawer = document.createElement('aside');
  drawer.className = 'assistant-drawer';
  drawer.id = 'vp-assistant-drawer';
  drawer.setAttribute('aria-hidden', 'true');
  drawer.innerHTML = `
    <div class="assistant-drawer__backdrop" id="vp-assistant-backdrop"></div>
    <div class="assistant-drawer__panel">
      <header class="assistant-drawer__header">
        <div class="assistant-drawer__brand">
          <span class="assistant-drawer__logo">${ICONS.hermesLogo}</span>
          <div>
            <h2 class="assistant-drawer__title">Hermes Agent</h2>
            <p class="assistant-drawer__meta" id="vp-assistant-meta">Menghubungkan...</p>
          </div>
        </div>
        <button type="button" class="assistant-drawer__close" id="vp-assistant-close" aria-label="Tutup Assistant">
          ${ICONS.close}
        </button>
      </header>

      <div class="assistant-drawer__chips">
        <button type="button" class="assistant-chip" data-prompt="Cek status server, penggunaan CPU, RAM, dan disk sekarang.">
          ${ICONS.chipStatus}<span>Status VM</span>
        </button>
        <button type="button" class="assistant-chip" data-prompt="Tampilkan daftar service yang sedang aktif dan status kesehatannya.">
          ${ICONS.chipService}<span>List Service</span>
        </button>
        <button type="button" class="assistant-chip" data-prompt="Periksa apakah service 9Router berjalan normal di port 20127.">
          ${ICONS.chipRouter}<span>9Router</span>
        </button>
        <button type="button" class="assistant-chip" data-prompt="Tolong jelaskan cara mendeploy project baru di VM-Panel.">
          ${ICONS.chipDeploy}<span>Panduan Deploy</span>
        </button>
      </div>

      <div class="assistant-drawer__body" id="vp-assistant-messages" tabindex="0" role="log" aria-live="polite">
        <div class="assistant-msg assistant-msg--agent">
          <div class="assistant-msg__avatar">${ICONS.agentAvatar}</div>
          <div class="assistant-msg__bubble">
            <div class="assistant-msg__content">
              <p>Hermes Agent siaga mengendalikan operasi dan memantau telemetri <strong>VM-Panel</strong> secara otonom.</p>
              <p class="text-muted" style="font-size:0.8rem; margin-top:0.35rem;">Pilih tombol cepat di atas atau masukkan perintah operasional Anda.</p>
            </div>
          </div>
        </div>
      </div>

      <footer class="assistant-drawer__footer">
        <form class="assistant-form" id="vp-assistant-form">
          <textarea
            id="vp-assistant-input"
            class="assistant-input"
            rows="1"
            placeholder="Tanyakan status, service, atau instruksi panel..."
            required
          ></textarea>
          <button type="submit" class="assistant-send-btn" id="vp-assistant-send" aria-label="Kirim pesan">
            ${ICONS.send}
          </button>
        </form>
      </footer>
    </div>
  `;

  document.body.appendChild(triggerBtn);
  document.body.appendChild(drawer);

  const metaEl = document.getElementById('vp-assistant-meta');
  const dotEl = document.getElementById('vp-assistant-status-dot');
  const messagesEl = document.getElementById('vp-assistant-messages');
  const formEl = document.getElementById('vp-assistant-form');
  const inputEl = document.getElementById('vp-assistant-input');
  const closeBtn = document.getElementById('vp-assistant-close');
  const backdrop = document.getElementById('vp-assistant-backdrop');

  function openDrawer() {
    isOpen = true;
    var isDesktop = !!(window.electronDesktop && window.electronDesktop.isDesktop) || !!document.querySelector('.desktop-titlebar');
    if (isDesktop) {
      document.body.classList.add('has-desktop-titlebar', 'is-desktop-app');
      document.documentElement.style.setProperty('--desktop-titlebar-h', '40px');
    }
    drawer.classList.add('assistant-drawer--open');
    drawer.setAttribute('aria-hidden', 'false');
    triggerBtn.classList.add('assistant-trigger--active');
    inputEl.focus();
    checkStatus();
    scrollToBottom();
  }

  function closeDrawer() {
    isOpen = false;
    drawer.classList.remove('assistant-drawer--open');
    drawer.setAttribute('aria-hidden', 'true');
    triggerBtn.classList.remove('assistant-trigger--active');
  }

  // Hook publik: bind API ke fungsi drawer yang sudah ada, lalu flush antrean.
  liveApi = {
    open: openDrawer,
    close: closeDrawer,
    toggle: function () {
      if (isOpen) closeDrawer();
      else openDrawer();
    },
    isOpen: function () {
      return isOpen;
    }
  };
  flushPending();

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Cek status gateway
  async function checkStatus() {
    try {
      const res = await fetch('/api/assistant/status');
      if (res.ok) {
        const data = await res.json();
        if (data.gatewayOnline) {
          metaEl.textContent = 'Online · Hermes Gateway (:8642)';
          dotEl.className = 'assistant-trigger__badge assistant-trigger__badge--online';
        } else if (data.routerOnline) {
          metaEl.textContent = 'Online · 9Router (:20127)';
          dotEl.className = 'assistant-trigger__badge assistant-trigger__badge--online';
        } else {
          metaEl.textContent = 'Standby · Sistem Siaga';
          dotEl.className = 'assistant-trigger__badge assistant-trigger__badge--standby';
        }
        return;
      }
    } catch {
      /* ignore */
    }
    metaEl.textContent = 'Mode Lokal';
    dotEl.className = 'assistant-trigger__badge assistant-trigger__badge--offline';
  }

  // Append bubble
  function appendMessage(role, text, source) {
    const msgEl = document.createElement('div');
    msgEl.className = `assistant-msg assistant-msg--${role}`;

    const avatar = role === 'user' ? ICONS.userAvatar : ICONS.agentAvatar;
    const tag = source ? `<span class="assistant-msg__tag">${escapeHtml(source)}</span>` : '';

    msgEl.innerHTML = `
      <div class="assistant-msg__avatar">${avatar}</div>
      <div class="assistant-msg__bubble">
        <div class="assistant-msg__content">${renderMarkdown(text)}</div>
        ${tag}
      </div>
    `;

    messagesEl.appendChild(msgEl);
    scrollToBottom();
  }

  function showTypingIndicator() {
    const ind = document.createElement('div');
    ind.className = 'assistant-msg assistant-msg--agent assistant-msg--typing';
    ind.id = 'vp-assistant-typing';
    ind.innerHTML = `
      <div class="assistant-msg__avatar">${ICONS.agentAvatar}</div>
      <div class="assistant-msg__bubble">
        <div class="assistant-typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    messagesEl.appendChild(ind);
    scrollToBottom();
  }

  function hideTypingIndicator() {
    const el = document.getElementById('vp-assistant-typing');
    if (el) el.remove();
  }

  // Kirim pesan
  async function sendMessage(text) {
    const clean = String(text || '').trim();
    if (!clean || isSending) return;

    isSending = true;
    appendMessage('user', clean);
    history.push({ role: 'user', content: clean });
    inputEl.value = '';
    inputEl.style.height = 'auto';

    showTypingIndicator();

    try {
      // A2#8: rute chat kini wajib CSRF (double-submit cookie vpanel_csrf) dan
      // menolak history > 10 item — kirim token dari cookie + pangkas history.
      const csrfMatch = document.cookie.match(/(?:^|;\s*)vpanel_csrf=([^;]*)/);
      const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : '';
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ message: clean, history: history.slice(-10) }),
      });

      hideTypingIndicator();

      if (res.ok) {
        const data = await res.json();
        const reply = data.reply || '(Tidak ada balasan)';
        appendMessage('agent', reply, data.source);
        history.push({ role: 'assistant', content: reply });
      } else {
        const errData = await res.json().catch(() => ({}));
        appendMessage('agent', `Terjadi kesalahan: ${errData.error || res.statusText}`);
      }
    } catch (err) {
      hideTypingIndicator();
      appendMessage('agent', `Gagal menghubungi server: ${err.message}`);
    } finally {
      isSending = false;
      inputEl.focus();
    }
  }

  // Event Listeners
  triggerBtn.addEventListener('click', () => {
    if (isOpen) closeDrawer();
    else openDrawer();
  });

  const topbarBtn = document.getElementById('btn-topbar-hermes');
  if (topbarBtn) {
    topbarBtn.addEventListener('click', () => {
      if (isOpen) closeDrawer();
      else openDrawer();
    });
  }

  closeBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closeDrawer();
  });

  // Action chips
  drawer.querySelectorAll('.assistant-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) {
        sendMessage(prompt);
      }
    });
  });

  // Form submit
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(inputEl.value);
  });

  // Textarea auto-height & Shift+Enter support
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(inputEl.value);
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  // Delegated click listener untuk Copy Code Button
  messagesEl.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.assistant-copy-btn');
    if (copyBtn) {
      const code = copyBtn.getAttribute('data-code');
      if (code) {
        navigator.clipboard.writeText(code).then(() => {
          const original = copyBtn.innerHTML;
          copyBtn.innerHTML = `${ICONS.check}<span>Tersalin!</span>`;
          copyBtn.classList.add('assistant-copy-btn--copied');
          setTimeout(() => {
            copyBtn.innerHTML = original;
            copyBtn.classList.remove('assistant-copy-btn--copied');
          }, 1600);
        }).catch(() => {});
      }
    }
  });

  // Cek status saat pertama kali halaman dimuat
  checkStatus();
})();
