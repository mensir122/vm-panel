/* ============================================================
   VPANEL — assistant.js
   Interactive Glassmorphism Chat Drawer powered by Hermes Agent & 9Router.
   ============================================================ */
(function () {
  'use strict';

  // Hanya aktifkan jika user sudah login (ada topbar dan bukan halaman auth)
  if (document.body.classList.contains('auth') || !document.querySelector('.topbar')) {
    return;
  }

  let isOpen = false;
  let isSending = false;
  const history = [];

  // Helper untuk escape HTML
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  // Sederhana tapi efektif markdown parser untuk chat
  function renderMarkdown(raw) {
    if (!raw) return '';
    let s = escapeHtml(raw);

    // Code blocks ```lang\ncode\n```
    s = s.replace(/```(?:([a-zA-Z0-9_-]+)\n)?([\s\S]*?)```/g, function (_, lang, code) {
      return (
        '<pre class="assistant-code" tabindex="0">' +
        (lang ? '<span class="assistant-code__lang">' + lang + '</span>' : '') +
        '<code>' + code.trim() + '</code></pre>'
      );
    });

    // Inline code `code`
    s = s.replace(/`([^`]+)`/g, '<code class="assistant-inline-code">$1</code>');

    // Bold **text**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic *text*
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Unordered lists
    s = s.replace(/^[*-]\s+(.+)$/gm, '<li>$1</li>');
    s = s.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul class="assistant-list">$1</ul>');

    // Line breaks (kecuali dalam tag block)
    s = s.replace(/\n\n/g, '<p></p>').replace(/\n/g, '<br>');

    return s;
  }

  // Buat DOM Trigger Button
  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'assistant-trigger';
  triggerBtn.id = 'vp-assistant-trigger';
  triggerBtn.setAttribute('aria-label', 'Buka Hermes AI Assistant');
  triggerBtn.innerHTML = `
    <span class="assistant-trigger__glow"></span>
    <span class="assistant-trigger__icon">☤</span>
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
          <span class="assistant-drawer__logo">☤</span>
          <div>
            <h2 class="assistant-drawer__title">Hermes Agent</h2>
            <p class="assistant-drawer__meta" id="vp-assistant-meta">Menghubungkan...</p>
          </div>
        </div>
        <button type="button" class="assistant-drawer__close" id="vp-assistant-close" aria-label="Tutup Assistant">&times;</button>
      </header>

      <div class="assistant-drawer__chips">
        <button type="button" class="assistant-chip" data-prompt="Cek status server, penggunaan CPU, RAM, dan disk sekarang.">⚡ Status VM</button>
        <button type="button" class="assistant-chip" data-prompt="Tampilkan daftar service yang sedang aktif dan status kesehatannya.">📦 List Service</button>
        <button type="button" class="assistant-chip" data-prompt="Periksa apakah service 9Router berjalan normal di port 20127.">🧭 Cek 9Router</button>
        <button type="button" class="assistant-chip" data-prompt="Tolong jelaskan cara mendeploy project baru di VM-Panel.">🚀 Panduan Deploy</button>
      </div>

      <div class="assistant-drawer__body" id="vp-assistant-messages" tabindex="0" role="log" aria-live="polite">
        <div class="assistant-msg assistant-msg--agent">
          <div class="assistant-msg__avatar">☤</div>
          <div class="assistant-msg__content">
            <p>Halo! Saya <strong>Hermes Agent</strong>, asisten AI otonom untuk <strong>VM-Panel</strong>.</p>
            <p>Saya dapat membantu Anda memantau metrik host, mengontrol service, memeriksa kesehatan proses, dan mengelola deployment menggunakan 9Router lokal.</p>
            <p class="text-muted" style="font-size:0.82rem; margin-top:0.4rem;">Pilih salah satu tombol cepat di atas atau ketik perintah Anda di bawah.</p>
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
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

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Cek status gateway
  async function checkStatus() {
    try {
      const res = await fetch('/api/assistant/status');
      if (res.ok) {
        const data = await res.json();
        if (data.mode === 'hermes') {
          metaEl.textContent = 'Hermes Gateway Aktif (Port 8642) · 9Router';
          dotEl.className = 'assistant-trigger__badge assistant-trigger__badge--online';
        } else if (data.mode === '9router-fallback') {
          metaEl.textContent = 'Direct 9Router Fallback (Port 20127)';
          dotEl.className = 'assistant-trigger__badge assistant-trigger__badge--standby';
        } else {
          metaEl.textContent = 'Standby · Sistem Siap';
          dotEl.className = 'assistant-trigger__badge assistant-trigger__badge--offline';
        }
        return;
      }
    } catch {
      /* ignore */
    }
    metaEl.textContent = 'Mode Offline';
    dotEl.className = 'assistant-trigger__badge assistant-trigger__badge--offline';
  }

  // Append bubble
  function appendMessage(role, text, source) {
    const msgEl = document.createElement('div');
    msgEl.className = `assistant-msg assistant-msg--${role}`;

    const avatar = role === 'user' ? '👤' : '☤';
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
      <div class="assistant-msg__avatar">☤</div>
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
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: clean, history }),
      });

      hideTypingIndicator();

      if (res.ok) {
        const data = await res.json();
        const reply = data.reply || '(Tidak ada balasan)';
        appendMessage('agent', reply, data.source);
        history.push({ role: 'assistant', content: reply });
      } else {
        const errData = await res.json().catch(() => ({}));
        appendMessage('agent', `⚠️ Maaf, terjadi kesalahan: ${errData.error || res.statusText}`);
      }
    } catch (err) {
      hideTypingIndicator();
      appendMessage('agent', `⚠️ Gagal menghubungi server: ${err.message}`);
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

  // Cek status saat pertama kali halaman dimuat
  checkStatus();
})();
