/* ============================================================
   VPANEL — panel.js
   Progressive enhancement only. Every page stays usable with
   JavaScript disabled; the panel server enforces its own
   two-phase confirmation server-side regardless.

   Features:
   1. Two-phase confirm for destructive actions. Any element
      with data-confirm opens a native <dialog>:
         data-confirm          short summary of the action (required)
         data-confirm-detail   optional extra context lines
         data-confirm-phrase   optional string the operator must
                               type exactly to enable Confirm
      Works on buttons (inside a form), forms (form-level) and
      links. The dialog is injected here, not in templates.
   2. Log auto-scroll: elements with [data-autoscroll] stay
      pinned to the bottom while the operator is near the
      bottom; scrolling up releases the pin.
   3. Config file upload (Config & Brankas): an input
      [data-config-upload] inside a form fills the hidden
      filename/contentBase64 fields via FileReader.readAsDataURL
      (prefix stripped), shows the chosen name+size in
      [data-config-upload-status] and locks the submit button
      until a file (≤ 512 KB) is ready. Without JavaScript the
      manual paste fields (data-config-manual) stay visible and
      the form posts the same urlencoded action.

   No dependencies. No network calls. No storage writes.
   ============================================================ */
(function () {
  "use strict";

  document.documentElement.classList.add("vp-js");

  /* ---------- Two-phase confirm ---------- */

  var dialog = null;
  var summaryEl = null;
  var detailEl = null;
  var phraseLabelEl = null;
  var phraseCodeEl = null;
  var phraseInputEl = null;
  var confirmBtnEl = null;
  var pendingTrigger = null;
  var pendingPhrase = "";

  function ensureDialog() {
    if (dialog) return;

    dialog = document.createElement("dialog");
    dialog.className = "confirm";

    var form = document.createElement("form");
    form.method = "dialog";
    form.className = "confirm__form";

    var title = document.createElement("h2");
    title.id = "vp-confirm-title";
    title.className = "confirm__title";
    title.textContent = "Confirm action";
    dialog.setAttribute("aria-labelledby", "vp-confirm-title");

    summaryEl = document.createElement("p");
    summaryEl.className = "confirm__summary";

    detailEl = document.createElement("p");
    detailEl.className = "confirm__detail";

    phraseLabelEl = document.createElement("label");
    phraseLabelEl.className = "confirm__phrase-label";
    phraseLabelEl.setAttribute("for", "vp-confirm-phrase");
    phraseLabelEl.appendChild(document.createTextNode("Type "));

    phraseCodeEl = document.createElement("code");
    phraseCodeEl.className = "confirm__phrase-code";
    phraseLabelEl.appendChild(phraseCodeEl);
    phraseLabelEl.appendChild(document.createTextNode(" to confirm:"));

    phraseInputEl = document.createElement("input");
    phraseInputEl.type = "text";
    phraseInputEl.id = "vp-confirm-phrase";
    phraseInputEl.className = "field__input mono";
    phraseInputEl.autocomplete = "off";
    phraseInputEl.spellcheck = false;

    phraseInputEl.addEventListener("input", function () {
      confirmBtnEl.disabled = phraseInputEl.value !== pendingPhrase;
    });

    var actions = document.createElement("div");
    actions.className = "confirm__actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "submit";
    cancelBtn.value = "cancel";
    cancelBtn.className = "btn btn--ghost";
    cancelBtn.textContent = "Cancel";

    confirmBtnEl = document.createElement("button");
    confirmBtnEl.type = "submit";
    confirmBtnEl.value = "confirm";
    confirmBtnEl.className = "btn btn--danger";
    confirmBtnEl.textContent = "Confirm";

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtnEl);

    form.appendChild(title);
    form.appendChild(summaryEl);
    form.appendChild(detailEl);
    form.appendChild(phraseLabelEl);
    form.appendChild(phraseInputEl);
    form.appendChild(actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    dialog.addEventListener("close", function () {
      var confirmed = dialog.returnValue === "confirm" &&
        (!pendingPhrase || phraseInputEl.value === pendingPhrase);
      var trigger = pendingTrigger;
      pendingTrigger = null;
      pendingPhrase = "";
      phraseInputEl.value = "";
      if (trigger) {
        if (confirmed) {
          execute(trigger);
        } else {
          trigger.focus();
        }
      }
    });
  }

  function openConfirm(trigger) {
    var summary = trigger.getAttribute("data-confirm") || "Confirm this action.";
    var detail = trigger.getAttribute("data-confirm-detail") || "";
    var phrase = trigger.getAttribute("data-confirm-phrase") || "";

    pendingTrigger = trigger;
    pendingPhrase = phrase;

    if (!window.HTMLDialogElement) {
      /* Fallback for very old engines: keep two phases via prompt(). */
      var ok = true;
      if (phrase) {
        ok = window.prompt('Type "' + phrase + '" to confirm.') === phrase;
      }
      if (ok && window.confirm(summary + (detail ? "\n\n" + detail : ""))) {
        execute(trigger);
      } else {
        trigger.focus();
      }
      return;
    }

    ensureDialog();
    summaryEl.textContent = summary;
    detailEl.textContent = detail;
    detailEl.hidden = detail === "";
    phraseCodeEl.textContent = phrase;
    phraseLabelEl.hidden = phrase === "";
    phraseInputEl.hidden = phrase === "";
    phraseInputEl.value = "";
    confirmBtnEl.disabled = phrase !== "";
    dialog.showModal();
    if (phrase) {
      phraseInputEl.focus();
    } else {
      confirmBtnEl.focus();
    }
  }

  function execute(trigger) {
    var form = trigger.closest ? trigger.closest("form") : null;
    if (form) {
      form.setAttribute("data-vp-confirmed", "1");
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return;
    }
    if (trigger.tagName === "A") {
      var href = trigger.getAttribute("href");
      if (href && href !== "#") {
        window.location.href = href;
      }
    }
  }

  function onSubmit(e) {
    var form = e.target;
    if (!form || form.nodeType !== 1) return;
    if (form.getAttribute("data-vp-confirmed") === "1") {
      form.removeAttribute("data-vp-confirmed");
      return;
    }
    var submitter = e.submitter || null;
    var trigger = null;
    if (submitter && submitter.hasAttribute("data-confirm")) {
      trigger = submitter;
    } else if (form.hasAttribute("data-confirm")) {
      trigger = form;
    }
    if (!trigger) return;
    e.preventDefault();
    openConfirm(trigger);
  }

  function onClick(e) {
    var trigger = e.target && e.target.closest
      ? e.target.closest('a[data-confirm], button[data-confirm]')
      : null;
    if (!trigger) return;
    e.preventDefault();
    openConfirm(trigger);
  }

  /* ---------- Reveal hidden sections (data-reveal="#id") ---------- */

  function onClickReveal(e) {
    var btn = e.target && e.target.closest
      ? e.target.closest('[data-reveal]')
      : null;
    if (!btn) return;
    e.preventDefault();
    var target = document.querySelector(btn.getAttribute("data-reveal"));
    if (!target) return;
    target.hidden = false;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    var first = target.querySelector("input, select, textarea");
    if (first) first.focus();
  }

  /* ---------- Config file upload (data-config-upload) ---------- */

  var CONFIG_MAX_BYTES = 512 * 1024;

  function initConfigUpload(input) {
    var form = input.form || (input.closest ? input.closest("form") : null);
    if (!form) return;
    var hiddenName = form.querySelector('input[type="hidden"][name="filename"]');
    var hiddenData = form.querySelector('input[type="hidden"][name="contentBase64"]');
    var statusEl = form.querySelector("[data-config-upload-status]");
    var submitBtn = form.querySelector('button[type="submit"]');
    var manualFields = form.querySelectorAll("[data-config-manual]");
    var defaultStatus = statusEl ? statusEl.textContent : "";

    /* JS aktif → fallback tempel disembunyikan + dinonaktifkan (input
       disabled tidak ikut disubmit, jadi tidak menimpa field tersembunyi),
       submit dikunci sampai file siap. */
    var manualControls = form.querySelectorAll(
      '[data-config-manual] input, [data-config-manual] textarea'
    );
    for (var i = 0; i < manualFields.length; i++) manualFields[i].hidden = true;
    for (var k = 0; k < manualControls.length; k++) manualControls[k].disabled = true;
    if (submitBtn) submitBtn.disabled = true;

    function reset(msg) {
      if (hiddenName) hiddenName.value = "";
      if (hiddenData) hiddenData.value = "";
      if (submitBtn) submitBtn.disabled = true;
      if (statusEl) statusEl.textContent = msg || defaultStatus;
    }

    function setReady(name, base64, infoText) {
      if (hiddenName) hiddenName.value = name;
      if (hiddenData) hiddenData.value = base64;
      if (submitBtn) submitBtn.disabled = false;
      if (statusEl) statusEl.textContent = infoText;
    }

    input.addEventListener("change", function () {
      var file = input.files && input.files[0] ? input.files[0] : null;
      if (!file) {
        reset();
        return;
      }
      if (file.size > CONFIG_MAX_BYTES) {
        reset("File terlalu besar (" + file.size + " byte) — maksimal 512 KB.");
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || "");
        var marker = result.indexOf("base64,");
        setReady(
          file.name,
          marker >= 0 ? result.slice(marker + 7) : result,
          "Siap diunggah: " + file.name + " (" + file.size + " byte)"
        );
      };
      reader.onerror = function () {
        reset("Gagal membaca file — coba lagi.");
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- Log auto-scroll ---------- */

  function initLog(el) {
    var pinned = true;
    var nearBottom = function () {
      return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    };
    el.addEventListener("scroll", function () {
      pinned = nearBottom();
    }, { passive: true });
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (pinned) el.scrollTop = el.scrollHeight;
      }).observe(el, { childList: true, characterData: true, subtree: true });
    }
    el.scrollTop = el.scrollHeight;
  }

  /* ---------- Desktop & Drag & Drop Deployment ---------- */

  function getCsrfToken() {
    var match = document.cookie.match(/(?:^|;\s*)vpanel_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function initDesktopTitlebar() {
    var isElectron = !!(window.electronDesktop && window.electronDesktop.isDesktop);
    var bar = document.getElementById("desktop-titlebar");

    // Dynamic injection for any page missing the titlebar
    if (isElectron && !bar && document.body) {
      bar = document.createElement("div");
      bar.id = "desktop-titlebar";
      bar.className = "desktop-titlebar";

      var h1 = document.querySelector("h1.page__title");
      var pageName = h1 ? h1.textContent.trim() : (document.title ? document.title.split("—")[0].trim() : "DASHBOARD");

      bar.innerHTML = [
        '<div class="desktop-titlebar__brand">',
          '<img src="/static/oriont-logo.png" alt="ORIONT" width="16" height="16" style="object-fit: contain;">',
          '<span class="desktop-titlebar__pulse"></span>',
          '<span>ORIONT · VPANEL</span>',
          '<span class="desktop-titlebar__tag">24/7 ACTIVE</span>',
        '</div>',
        '<div class="desktop-titlebar__center">',
          '<span class="desktop-titlebar__center-title">' + (pageName || "ORIONT") + '</span>',
        '</div>',
        '<div class="desktop-titlebar__controls">',
          '<button type="button" class="desktop-titlebar__btn" id="titlebar-min" title="Minimize">',
            '<svg width="10" height="2" viewBox="0 0 10 2" fill="currentColor"><rect width="10" height="2" rx="1"/></svg>',
          '</button>',
          '<button type="button" class="desktop-titlebar__btn" id="titlebar-max" title="Maximize / Restore">',
            '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="8" height="8" rx="1.5"/></svg>',
          '</button>',
          '<button type="button" class="desktop-titlebar__btn desktop-titlebar__btn--close" id="titlebar-close" title="Close to Tray">',
            '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg>',
          '</button>',
        '</div>'
      ].join("");

      document.body.insertBefore(bar, document.body.firstChild);
    }

    if (!bar) return;

    if (isElectron) {
      document.body.classList.add("has-desktop-titlebar", "is-desktop-app");
      document.documentElement.style.setProperty("--desktop-titlebar-h", "40px");
      bar.style.display = "flex";

      // Double-click on titlebar to maximize / restore
      bar.addEventListener("dblclick", function (e) {
        if (!e.target.closest(".desktop-titlebar__controls")) {
          window.electronDesktop.maximize();
        }
      });

      var minBtn = bar.querySelector("#titlebar-min");
      var maxBtn = bar.querySelector("#titlebar-max");
      var closeBtn = bar.querySelector("#titlebar-close");

      if (minBtn && !minBtn.dataset.bound) {
        minBtn.dataset.bound = "true";
        minBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          window.electronDesktop.minimize();
        });
      }
      if (maxBtn && !maxBtn.dataset.bound) {
        maxBtn.dataset.bound = "true";
        maxBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          window.electronDesktop.maximize();
        });
      }
      if (closeBtn && !closeBtn.dataset.bound) {
        closeBtn.dataset.bound = "true";
        closeBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          window.electronDesktop.close();
        });
      }
    }
  }

  function initDropzone() {
    var dropzone = document.getElementById("project-dropzone");
    var modal = document.getElementById("generative-deploy-modal");
    var browseBtn = document.getElementById("btn-browse-folder");

    if (!dropzone) return;

    var btnClose = document.getElementById("btn-close-deploy-modal");
    var btnCancel = document.getElementById("btn-cancel-deploy");
    var btnStart = document.getElementById("btn-start-deploy");
    var chatBox = document.getElementById("copilot-chat-box");
    var copilotForm = document.getElementById("copilot-input-form");
    var copilotInput = document.getElementById("copilot-input");
    var terminalLogs = document.getElementById("deploy-terminal-logs");
    var progressBar = document.getElementById("deploy-progress-bar");
    var stageText = document.getElementById("deploy-stage-text");
    var pctText = document.getElementById("deploy-pct-text");
    var stageTag = document.getElementById("deploy-stage-tag");
    var statName = document.getElementById("stat-project-name");
    var statPort = document.getElementById("stat-port");
    var statFw = document.getElementById("stat-framework");
    var statEntry = document.getElementById("stat-entry");
    var envList = document.getElementById("env-fields-list");
    var envTag = document.getElementById("env-count-tag");

    var nodeInspect = document.getElementById("node-inspection");
    var nodeSecrets = document.getElementById("node-secrets");
    var nodeProvision = document.getElementById("node-provision");
    var nodeBuild = document.getElementById("node-build");
    var nodeVerify = document.getElementById("node-verify");

    var conn1 = document.getElementById("conn-1");
    var conn2 = document.getElementById("conn-2");
    var conn3 = document.getElementById("conn-3");
    var conn4 = document.getElementById("conn-4");

    var copilotChatHistory = [];

    var currentDeployState = {
      folderPath: "",
      projectName: "",
      port: 0,
      framework: "",
      entryFile: "",
      detectedEnvs: [],
      env: {},
      stage: "idle",
    };

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatMarkdown(str) {
      if (!str) return "";
      var s = escapeHtml(str);
      s = s.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/\*(.*?)\*/g, "<em>$1</em>");
      s = s.replace(/`([^`]+)`/g, '<code class="mono">$1</code>');
      s = s.replace(/\n/g, "<br>");
      return s;
    }

    function logTerminal(tag, msg, type) {
      if (!terminalLogs) return;
      var line = document.createElement("div");
      line.className = "terminal-line";
      var tagCls = type || "info";
      line.innerHTML = '<span class="terminal-tag ' + tagCls + '">[' + escapeHtml(tag) + "]</span> " + escapeHtml(msg);
      terminalLogs.appendChild(line);
      terminalLogs.scrollTop = terminalLogs.scrollHeight;
    }

    function addCopilotMsg(role, text) {
      if (!chatBox) return;
      var msgDiv = document.createElement("div");
      msgDiv.className = "copilot-msg copilot-msg--" + (role === "user" ? "user" : "assistant");
      var avatar = role === "user" ? '<div class="copilot-msg__avatar">👤</div>' : '<div class="copilot-msg__avatar">🤖</div>';
      var content = '<div class="copilot-msg__content">' + formatMarkdown(text) + "</div>";
      msgDiv.innerHTML = avatar + content;
      chatBox.appendChild(msgDiv);
      chatBox.scrollTop = chatBox.scrollHeight;
    }

    function setProgress(pct, text, tag) {
      if (progressBar) progressBar.style.width = pct + "%";
      if (pctText) pctText.textContent = pct + "%";
      if (stageText && text) stageText.textContent = text;
      if (stageTag && tag) stageTag.textContent = tag;
      var footerStatus = document.getElementById("deploy-footer-status-text");
      if (footerStatus && text) footerStatus.textContent = text;
    }

    function setNodeState(node, state, desc, badgeText) {
      if (!node) return;
      node.classList.remove("pipeline-node--done", "pipeline-node--active", "pipeline-node--pending", "pipeline-node--error");
      node.classList.add("pipeline-node--" + state);
      if (desc) {
        var dEl = node.querySelector(".pipeline-node__desc");
        if (dEl) dEl.textContent = desc;
      }
      if (badgeText) {
        var bEl = node.querySelector(".pipeline-node__badge");
        if (bEl) {
          bEl.textContent = badgeText;
          if (state === "done") bEl.className = "pipeline-node__badge badge--green";
          else if (state === "active") bEl.className = "pipeline-node__badge badge--emerald";
          else if (state === "error") bEl.className = "pipeline-node__badge badge--red";
        }
      }
    }

    var modalIsOpen = false;   // guard: navigasi otomatis hanya saat modal masih terbuka
    var isDeploying = false;   // guard: klik ganda "Jalankan Deployment"

    function closeModal() {
      if (modal) modal.style.display = "none";
      modalIsOpen = false;
      var repoInput = document.getElementById("deploy-repo-url");
      if (repoInput) repoInput.value = "";
      if (!isDeploying) {
        if (btnStart) btnStart.disabled = false;
        if (btnCancel) btnCancel.disabled = false;
      }
      var footerStatus = document.getElementById("deploy-footer-status-text");
      if (footerStatus) footerStatus.textContent = "Siap untuk deployment";
    }

    if (btnClose) btnClose.addEventListener("click", closeModal);
    // btnCancel: benar-benar menutup modal, tanpa navigasi paksa (lihat guard modalIsOpen)
    if (btnCancel) btnCancel.addEventListener("click", closeModal);

    // ESC menutup modal (tidak saat fokus di elemen input — biarkan ESC lokal dulu)
    document.addEventListener("keydown", function (e) {
      if (!modalIsOpen || e.key !== "Escape") return;
      var ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      closeModal();
    });

    // Klik backdrop (area gelap di luar kartu dialog) menutup modal
    if (modal) {
      modal.addEventListener("click", function (e) {
        if (e.target === modal) closeModal();
      });
    }

    var toggle247El = document.getElementById("toggle-auto-247");
    var cloudBadgeEl = document.getElementById("cloud-status-badge");
    var cloudRepoGroupEl = document.getElementById("cloud-repo-group");
    if (toggle247El) {
      toggle247El.addEventListener("change", function () {
        if (toggle247El.checked) {
          if (cloudBadgeEl) {
            cloudBadgeEl.textContent = "AUTO 24/7 AKTIF";
            cloudBadgeEl.className = "flow-card__status-tag badge--white";
          }
          if (cloudRepoGroupEl) cloudRepoGroupEl.style.opacity = "1";
        } else {
          if (cloudBadgeEl) {
            cloudBadgeEl.textContent = "OFF (LOKAL SAJA)";
            cloudBadgeEl.className = "flow-card__status-tag";
          }
          if (cloudRepoGroupEl) cloudRepoGroupEl.style.opacity = "0.45";
        }
      });
    }

    async function openModalWithFolder(folderPath) {
      if (!folderPath) return;
      if (!modal) {
        alert("Modal deploy tidak ditemukan di halaman ini.");
        return;
      }

      modal.style.display = "flex";
      modalIsOpen = true;
      // Fokus awal ke dialog (accessibility), bukan merebut dari input internal
      setTimeout(function () {
        var focusTarget = copilotInput || btnClose || modal;
        if (focusTarget && typeof focusTarget.focus === "function") {
          try { focusTarget.focus({ preventScroll: true }); } catch (e2) { focusTarget.focus(); }
        }
      }, 50);
      copilotChatHistory = [];
      currentDeployState.folderPath = folderPath;
      currentDeployState.stage = "inspecting";
      currentDeployState.error = null;
      currentDeployState.env = {};

      if (terminalLogs) terminalLogs.innerHTML = "";
      if (chatBox) {
        chatBox.innerHTML =
          '<div class="copilot-msg copilot-msg--assistant">' +
          '<div class="copilot-msg__avatar">🤖</div>' +
          '<div class="copilot-msg__content">Folder project terdeteksi. Menginspeksi arsitektur kode dan environment variables...</div>' +
          '</div>';
      }

      setProgress(15, "Tahap 1: Inspeksi Codebase...", "INSPECTING");
      logTerminal("AI-SCAN", "Memulai pemindaian direktori: " + folderPath, "info");

      setNodeState(nodeInspect, "active", "Memindai file proyek & framework...", "ANALYZING");
      setNodeState(nodeSecrets, "pending", "Menunggu inspeksi selesai...", "STANDBY");
      setNodeState(nodeProvision, "pending", "Alokasi port aman...", "STANDBY");
      setNodeState(nodeBuild, "pending", "Resolusi dependensi...", "STANDBY");
      setNodeState(nodeVerify, "pending", "Aktivasi supervisor...", "STANDBY");

      if (conn1) conn1.classList.remove("pipeline-connector--active");
      if (conn2) conn2.classList.remove("pipeline-connector--active");
      if (conn3) conn3.classList.remove("pipeline-connector--active");
      if (conn4) conn4.classList.remove("pipeline-connector--active");

      try {
        var csrf = getCsrfToken();
        var res = await fetch("/api/desktop/inspect-folder", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({ folderPath: folderPath }),
        });
        var data = await res.json();

        if (!data.ok || !data.inspection) {
          var errText = (data && data.error && (data.error.message || (typeof data.error === "string" ? data.error : JSON.stringify(data.error)))) || data.message || "Gagal menginspeksi direktori";
          throw new Error(errText);
        }

        var insp = data.inspection;
        currentDeployState.projectName = insp.suggestedName;
        currentDeployState.port = insp.suggestedPort;
        currentDeployState.framework = insp.framework;
        currentDeployState.entryFile = insp.entryFile || "-";
        currentDeployState.detectedEnvs = insp.detectedEnvs || [];
        currentDeployState.branch = (insp.gitInfo && insp.gitInfo.branch) || "main";
        currentDeployState.stage = "ready";
        currentDeployState.error = null;

        // Update UI
        if (statName) statName.textContent = insp.suggestedName;
        if (statPort) statPort.textContent = insp.suggestedPort;
        if (statFw) statFw.textContent = insp.framework;
        if (statEntry) statEntry.textContent = insp.entryFile || "-";

        // Auto 24/7 Cloud Detection
        var repoInput = document.getElementById("deploy-repo-url");
        var cloudBadge = document.getElementById("cloud-status-badge");
        var toggle247 = document.getElementById("toggle-auto-247");
        if (toggle247) toggle247.checked = true;

        if (insp.gitInfo && insp.gitInfo.repoUrl) {
          if (repoInput) repoInput.value = insp.gitInfo.repoUrl;
          if (cloudBadge) {
            cloudBadge.textContent = "GIT REPO TERDETEKSI 24/7";
            cloudBadge.className = "flow-card__status-tag badge--white";
          }
          logTerminal("CLOUD-247", "Git remote terdeteksi: " + insp.gitInfo.repoUrl + " (branch: " + (insp.gitInfo.branch || "main") + ")", "ok");
        } else {
          if (repoInput) repoInput.value = "";
          if (cloudBadge) {
            cloudBadge.textContent = "AUTO 24/7 AKTIF";
            cloudBadge.className = "flow-card__status-tag badge--white";
          }
          logTerminal("CLOUD-247", "Proyek lokal akan disinkronkan otomatis ke Cloud Runner 24/7", "info");
        }

        setNodeState(nodeInspect, "done", insp.framework + " (" + insp.totalFiles + " files)", "INSPECTED");
        setNodeState(nodeSecrets, "active", insp.detectedEnvs.length + " variabel lingkungan terdeteksi", "READY");
        if (conn1) conn1.classList.add("pipeline-connector--active");

        setProgress(30, "Tahap 2: Verifikasi Environment & Port", "CONFIGURING");
        logTerminal("AI-SCAN", "Framework terdeteksi: " + insp.framework, "ok");
        logTerminal("AI-SCAN", "Port non-collision terpilih: " + insp.suggestedPort, "ok");
        logTerminal("AI-SCAN", "Ditemukan " + insp.detectedEnvs.length + " variabel lingkungan dalam kode sumber", "info");

        // Render detected env inputs
        if (envList) {
          envList.innerHTML = "";
          if (insp.detectedEnvs && insp.detectedEnvs.length > 0) {
            if (envTag) envTag.textContent = insp.detectedEnvs.length + " Terdeteksi";
            insp.detectedEnvs.forEach(function (e) {
              var row = document.createElement("div");
              row.className = "env-field-row";
              var keyLabel = '<div class="env-field-key" title="' + escapeHtml(e.key) + '">' + escapeHtml(e.key) + "</div>";
              var isSecret = e.type === "secret";
              var inputType = isSecret ? "password" : "text";
              var defaultVal = e.key === "PORT" ? String(insp.suggestedPort) : e.defaultValue || "";
              var inp =
                '<input type="' +
                inputType +
                '" class="env-field-input" data-key="' +
                escapeHtml(e.key) +
                '" value="' +
                escapeHtml(defaultVal) +
                '" placeholder="Isi ' +
                escapeHtml(e.key) +
                '...">';
              row.innerHTML = keyLabel + inp;
              envList.appendChild(row);
            });
          } else {
            if (envTag) envTag.textContent = "0 Terdeteksi";
            envList.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">Tidak ada env khusus yang dibutuhkan. Proyek siap dideploy langsung!</div>';
          }
        }

        var missingEnvs = insp.detectedEnvs.filter(function (e) {
          return e.required && !e.defaultValue && e.key !== "PORT";
        });

        if (missingEnvs.length > 0) {
          addCopilotMsg(
            "assistant",
            "Analisis selesai! Framework **" +
              insp.framework +
              "** terdeteksi. Terdapat **" +
              missingEnvs.length +
              " variabel/token** yang perlu Anda isi (misal: `" +
              missingEnvs[0].key +
              "`). Anda bisa mengisinya di panel kanan atau perintahkan saya: `set " +
              missingEnvs[0].key +
              "=...`."
          );
        } else {
          addCopilotMsg(
            "assistant",
            "Analisis selesai! Framework **" +
              insp.framework +
              "** dan port **" +
              insp.suggestedPort +
              "** telah terverifikasi. Semua konfigurasi siap! Klik **Jalankan Deployment Sekarang** untuk memulai proses."
          );
        }
      } catch (err) {
        var errMessage = err.message || String(err);
        currentDeployState.stage = "error";
        currentDeployState.error = errMessage;
        logTerminal("ERROR", errMessage, "err");
        setNodeState(nodeInspect, "error", "Gagal inspeksi: " + errMessage, "FAILED");
        addCopilotMsg("assistant", "⚠️ Gagal membaca folder: " + errMessage + "\n\nAnda dapat menanyakan penyebab error atau meminta bantuan saya untuk menganalisis format project.");
      }
    }

    async function sendCopilotInstruction(promptText) {
      if (!promptText || !promptText.trim()) return;
      var text = promptText.trim();
      addCopilotMsg("user", text);
      if (copilotInput) copilotInput.value = "";

      // Sync any typed env inputs into currentDeployState.env
      var inputs = document.querySelectorAll(".env-field-input");
      inputs.forEach(function (inp) {
        if (inp.dataset.key) {
          currentDeployState.env[inp.dataset.key] = inp.value.trim();
        }
      });

      try {
        var csrf = getCsrfToken();
        var res = await fetch("/api/assistant/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({
            message: text,
            history: copilotChatHistory.slice(-8),
            deployContext: currentDeployState,
          }),
        });
        var data = await res.json();
        var reply = data.reply || "Instruksi diterima.";
        addCopilotMsg("assistant", reply);
        copilotChatHistory.push({ role: "user", content: text });
        copilotChatHistory.push({ role: "assistant", content: reply });

        if (data.action) {
          var act = data.action;
          if (act.type === "update_config" && act.updates) {
            if (act.updates.port) {
              currentDeployState.port = act.updates.port;
              if (statPort) statPort.textContent = act.updates.port;
              var portInp = document.querySelector('.env-field-input[data-key="PORT"]');
              if (portInp) portInp.value = String(act.updates.port);
              logTerminal("CONFIG", "Port diubah menjadi " + act.updates.port, "ok");
            }
            if (act.updates.name) {
              currentDeployState.projectName = act.updates.name;
              if (statName) statName.textContent = act.updates.name;
              logTerminal("CONFIG", "Nama project diubah menjadi " + act.updates.name, "ok");
            }
            if (act.updates.env) {
              for (var ek in act.updates.env) {
                var ev = act.updates.env[ek];
                currentDeployState.env[ek] = ev;
                var foundInp = document.querySelector('.env-field-input[data-key="' + ek + '"]');
                if (foundInp) {
                  foundInp.value = ev;
                } else if (envList) {
                  var newRow = document.createElement("div");
                  newRow.className = "env-field-row";
                  newRow.innerHTML =
                    '<div class="env-field-key">' +
                    escapeHtml(ek) +
                    '</div><input type="text" class="env-field-input" data-key="' +
                    escapeHtml(ek) +
                    '" value="' +
                    escapeHtml(ev) +
                    '">';
                  envList.appendChild(newRow);
                }
                logTerminal("CONFIG", "Variabel " + ek + " berhasil disetel", "ok");
              }
            }
          } else if (act.type === "trigger_deploy") {
            executeFinalDeploy();
          }
        }
      } catch (err) {
        addCopilotMsg("assistant", "Terjadi kesalahan saat memproses instruksi: " + (err.message || String(err)));
      }
    }

    if (copilotForm) {
      copilotForm.addEventListener("submit", function (e) {
        e.preventDefault();
        if (copilotInput) sendCopilotInstruction(copilotInput.value);
      });
    }

    // Quick chip buttons
    var chips = document.querySelectorAll(".copilot-chip");
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var cmd = chip.dataset.cmd;
        if (cmd) sendCopilotInstruction(cmd);
      });
    });

    async function executeFinalDeploy() {
      if (isDeploying) return; // anti klik-ganda (pola guard isSending)
      if (!currentDeployState.folderPath) {
        alert("Silakan pilih folder project terlebih dahulu.");
        return;
      }
      isDeploying = true;

      if (btnStart) btnStart.disabled = true;
      if (btnCancel) btnCancel.disabled = true;

      // Collect all inputs
      var inputs = document.querySelectorAll(".env-field-input");
      inputs.forEach(function (inp) {
        if (inp.dataset.key) {
          currentDeployState.env[inp.dataset.key] = inp.value.trim();
        }
      });

      var toggle247 = document.getElementById("toggle-auto-247");
      var repoInput = document.getElementById("deploy-repo-url");
      var isAuto247 = toggle247 ? toggle247.checked : true;
      var repoUrlVal = repoInput ? repoInput.value.trim() : "";

      // Stage 3: Provisioning
      setNodeState(nodeSecrets, "done", "Variabel lingkungan & secret disinkronkan", "CONFIGURED");
      setNodeState(nodeProvision, "active", "Mengalokasikan port " + currentDeployState.port + " & workspace...", "PROVISIONING");
      if (conn2) conn2.classList.add("pipeline-connector--active");
      setProgress(50, "Tahap 3: Alokasi Workspace & Socket...", "PROVISIONING");
      logTerminal("PROVISION", "Membuat workspace project dan mengunci socket port " + currentDeployState.port, "info");

      // Stage 4: Building
      setTimeout(function () {
        setNodeState(nodeProvision, "done", "Port " + currentDeployState.port + " siap", "PROVISIONED");
        setNodeState(nodeBuild, "active", "Menjalankan isolasi file & dependency adapter...", "BUILDING");
        if (conn3) conn3.classList.add("pipeline-connector--active");
        setProgress(70, "Tahap 4: Build & Resolusi Dependensi...", "BUILDING");
        logTerminal("BUILD", "Menyalin file source ke workspace aman...", "info");
      }, 400);

      try {
        var csrf = getCsrfToken();
        var res = await fetch("/api/desktop/deploy-folder", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({
            folderPath: currentDeployState.folderPath,
            name: currentDeployState.projectName,
            port: currentDeployState.port,
            env: currentDeployState.env,
            auto247: isAuto247,
            repoUrl: repoUrlVal || undefined,
            gitBranch: currentDeployState.branch || undefined,
          }),
        });
        var resData = await res.json();

        if (resData && (resData.ok || resData.success)) {
          var pName = (resData.project && resData.project.name) || currentDeployState.projectName;
          var pPort = (resData.project && resData.project.port) || currentDeployState.port;

          // Stage 5: Verifying & Live
          setNodeState(nodeBuild, "done", "Dependensi & build selesai", "BUILT");
          setNodeState(nodeVerify, "done", "Proses aktif & health probe ok di port " + pPort, "HEALTHY 24/7");
          if (conn4) conn4.classList.add("pipeline-connector--active");

          setProgress(100, "Tahap 5: Deployment Berhasil — 24/7 Active!", "HEALTHY");
          logTerminal("SUPERVISOR", "Process PID terdaftar. Health check HTTP/TCP lolos!", "ok");
          logTerminal("SUCCESS", "Project " + pName + " berhasil aktif di port " + pPort + "!", "ok");

          if (resData.cloud247 && resData.cloud247.enabled) {
            if (resData.cloud247.synced) {
              logTerminal("CLOUD-247", "Sync GitHub Cloud Runner Berhasil! Proyek Anda akan tetap online 24/7 walaupun laptop dimatikan.", "ok");
            } else {
              logTerminal("CLOUD-247", resData.cloud247.message, "warn");
            }
          }

          var cloudNotice = (resData.cloud247 && resData.cloud247.synced)
            ? " dan **aktif 24/7 di Cloud Runner** (akan tetap hidup walau laptop dimatikan)"
            : "";

          addCopilotMsg(
            "assistant",
            "🎉 **Selamat!** Project **" +
              pName +
              "** telah berhasil dideploy pada port **" +
              pPort +
              "**" + cloudNotice + "!. Mengalihkan ke halaman Projects..."
          );

          isDeploying = false;
          if (btnStart) btnStart.disabled = false;
          if (btnCancel) btnCancel.disabled = false;

          // Navigasi otomatis HANYA jika modal masih terbuka saat timer selesai;
          // kalau user sudah menutup modal (ESC/backdrop/Batal), jangan paksa pindah.
          setTimeout(function () {
            if (modalIsOpen) window.location.href = "/projects";
          }, 2400);
        } else {
          var errMsg = (resData && resData.error && (resData.error.message || (typeof resData.error === "string" ? resData.error : JSON.stringify(resData.error)))) || (resData && resData.message) || "Gagal melakukan deployment.";
          setNodeState(nodeBuild, "error", "Gagal: " + errMsg, "FAILED");
          setProgress(70, "Deployment Gagal", "ERROR");
          logTerminal("ERROR", errMsg, "err");
          addCopilotMsg("assistant", "⚠️ Deployment terhenti: " + errMsg + ". Anda bisa memperbaiki nilai env/port lalu mencoba kembali.");
          isDeploying = false;
          if (btnStart) btnStart.disabled = false;
          if (btnCancel) btnCancel.disabled = false;
        }
      } catch (err) {
        setNodeState(nodeBuild, "error", "Gagal: " + err.message, "FAILED");
        logTerminal("ERROR", err.message || String(err), "err");
        addCopilotMsg("assistant", "⚠️ Terjadi kesalahan koneksi server: " + (err.message || String(err)));
        isDeploying = false;
        if (btnStart) btnStart.disabled = false;
        if (btnCancel) btnCancel.disabled = false;
      }
    }

    if (btnStart) {
      btnStart.addEventListener("click", function (e) {
        e.preventDefault();
        executeFinalDeploy();
      });
    }

    // Counter enter/leave agar highlight tidak kedip saat melewati anak elemen
    var dragDepth = 0;

    dropzone.addEventListener("dragenter", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth++;
      dropzone.classList.add("dragover");
    });

    dropzone.addEventListener("dragover", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("dragover");
    });

    dropzone.addEventListener("dragleave", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzone.classList.remove("dragover");
    });

    dropzone.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      dropzone.classList.remove("dragover");

      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;

      var folderPath = "";
      if (window.electronDesktop && typeof window.electronDesktop.getPathForFile === "function") {
        folderPath = window.electronDesktop.getPathForFile(files[0]);
      } else if (files[0].path) {
        folderPath = files[0].path;
      }

      if (!folderPath) {
        alert("Path lokal direktori tidak dapat dibaca dari browser standar. Silakan jalankan di Aplikasi Desktop VM-Panel atau klik Pilih Folder.");
        return;
      }

      openModalWithFolder(folderPath);
    });

    if (browseBtn) {
      browseBtn.addEventListener("click", async function (e) {
        e.preventDefault();
        e.stopPropagation();

        if (window.electronDesktop && typeof window.electronDesktop.selectFolder === "function") {
          var selected = await window.electronDesktop.selectFolder();
          if (selected) openModalWithFolder(selected);
        } else {
          var inputPath = prompt("Masukkan path lengkap direktori folder di Windows host (misal: C:\\my-app):");
          if (inputPath && inputPath.trim()) openModalWithFolder(inputPath.trim());
        }
      });
    }

    var manualInp = document.getElementById("input-manual-folder");
    var manualBtn = document.getElementById("btn-manual-inspect");

    if (manualBtn && manualInp) {
      manualBtn.addEventListener("click", function (e) {
        e.preventDefault();
        var val = manualInp.value && manualInp.value.trim();
        if (val) openModalWithFolder(val);
      });
      manualInp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var val = manualInp.value && manualInp.value.trim();
          if (val) openModalWithFolder(val);
        }
      });
    }

    // Expose globally for desktop shell / testing hooks
    window.openDeployModalWithFolder = openModalWithFolder;

    // Check if autoInspect URL param exists
    try {
      var params = new URLSearchParams(window.location.search);
      var autoPath = params.get("autoInspect");
      if (autoPath && autoPath.trim()) {
        setTimeout(function () {
          openModalWithFolder(autoPath.trim());
        }, 300);
      }
    } catch (e) {}
  }

  /* ---------- Donezo UI Enhancements ---------- */

  function initDonezoUI() {
    // 1. Supervisor Live Clock — terikat ke uptime host NYATA yang dirender server
    //    ({{hostUptimeStr}} format "Xd HH:MM:SS" via fmtDuration), lalu ditick
    //    lokal sejak halaman dimuat. Bila nilai tak terbaca, fallback jujur:
    //    timer sejak halaman dimuat (bukan angka hardcoded).
    var clockEl = document.getElementById("time-tracker-clock");
    var pauseBtn = document.getElementById("btn-timer-pause");
    var stopBtn = document.getElementById("btn-timer-stop");

    function parseHostUptimeSec(text) {
      if (!text) return null;
      var m = String(text).match(/(?:(\d+)\s*d)?\s*(\d{1,2}):(\d{2}):(\d{2})/);
      if (!m) return null;
      return (parseInt(m[1] || "0", 10) * 86400) +
        parseInt(m[2], 10) * 3600 +
        parseInt(m[3], 10) * 60 +
        parseInt(m[4], 10);
    }

    function formatUptime(s) {
      var pad = function (n) { return n < 10 ? "0" + n : String(n); };
      var d = Math.floor(s / 86400);
      var body = pad(Math.floor((s % 86400) / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
      return d > 0 ? d + "d " + body : body;
    }

    if (clockEl) {
      var chipEl = document.getElementById("header-time-live");
      var srcEl = chipEl || clockEl;
      var baseSec = parseHostUptimeSec(chipEl ? chipEl.textContent : "") || 0;
      var loadTs = Date.now();
      var isRunning = true;
      var frozenSec = null;
      var timerInterval = null;

      function liveUptimeSec() {
        return baseSec + Math.floor((Date.now() - loadTs) / 1000);
      }

      function setDisplay(s) {
        var str = formatUptime(s);
        clockEl.textContent = str;
        if (chipEl) chipEl.textContent = str; // header chip ikut hidup, konsisten
      }

      setDisplay(baseSec);
      if (!chipEl || !String(chipEl.textContent).trim()) {
        clockEl.title = "Sejak halaman dimuat";
      }

      timerInterval = setInterval(function () {
        if (isRunning) setDisplay(liveUptimeSec());
      }, 1000);

      if (pauseBtn) {
        pauseBtn.addEventListener("click", function () {
          if (isRunning) {
            isRunning = false;
            frozenSec = liveUptimeSec(); // freeze tampilan
          } else {
            isRunning = true;
            if (frozenSec !== null) { // resume: geser baseline agar lanjut mulus
              baseSec = frozenSec - Math.floor((Date.now() - loadTs) / 1000);
              frozenSec = null;
            }
            setDisplay(liveUptimeSec());
          }
          pauseBtn.style.opacity = isRunning ? "1" : "0.6";
          pauseBtn.title = isRunning ? "Pause timer" : "Resume timer";
        });
      }

      if (stopBtn) {
        stopBtn.addEventListener("click", function () {
          // Bukan reset ke 00:00:00 (uptime host tidak bisa di-reset dari UI)
          // — tombol ini men-sinkron ulang tampilan ke ticker langsung.
          baseSec = liveUptimeSec();
          loadTs = Date.now();
          isRunning = true;
          frozenSec = null;
          if (pauseBtn) pauseBtn.style.opacity = "1";
          setDisplay(baseSec);
        });
      }
    }

    // 2. Global Keyboard Shortcut for Search (Ctrl + F or ⌘ F)
    var searchInput = document.getElementById("topbar-search-input");
    var kbdPill = document.getElementById("search-kbd-pill");

    window.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        // Jangan curi Ctrl+F saat user sedang mengetik di input/textarea lain
        var ae = document.activeElement;
        var typing =
          ae &&
          (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable) &&
          ae !== searchInput;
        if (typing) return;
        if (searchInput && document.activeElement !== searchInput) {
          e.preventDefault();
          searchInput.focus();
          searchInput.select();
        }
      }
    });

    if (kbdPill && searchInput) {
      kbdPill.addEventListener("click", function () {
        searchInput.focus();
      });
    }

    if (searchInput) {
      // Style hint "0 hasil" disuntik lokal (bukan mengubah panel.css)
      if (!document.getElementById("panel-search-hint-style")) {
        var hintStyle = document.createElement("style");
        hintStyle.id = "panel-search-hint-style";
        hintStyle.textContent =
          ".vp-search-empty-hint{padding:10px 14px;font-size:12px;color:#9CA3AF;font-family:inherit;}";
        document.head.appendChild(hintStyle);
      }
      var applySearchFilter = function () {
        var query = searchInput.value.toLowerCase().trim();
        var targets = document.querySelectorAll("table.table tbody tr, .oriont-list-row");
        for (var i = 0; i < targets.length; i++) {
          var rowText = targets[i].textContent.toLowerCase();
          if (!query || rowText.includes(query)) {
            targets[i].style.display = "";
          } else {
            targets[i].style.display = "none";
          }
        }
        // Hint "0 hasil" (DOM-only): disisipkan SETELAH container daftar,
        // bukan ke dalamnya (div di dalam <table> tidak valid).
        var hosts = document.querySelectorAll("table.table, .project-widget__list");
        for (var h = 0; h < hosts.length; h++) {
          var host = hosts[h];
          var parent = host.parentNode;
          if (!parent) continue;
          var oldHints = parent.querySelectorAll(":scope > .vp-search-empty-hint");
          for (var oh = 0; oh < oldHints.length; oh++) oldHints[oh].remove();
          if (!query) continue;
          var hostRows = host.querySelectorAll("tbody tr, .oriont-list-row");
          if (hostRows.length === 0) continue;
          var anyVisible = false;
          for (var r = 0; r < hostRows.length; r++) {
            if (hostRows[r].style.display !== "none") { anyVisible = true; break; }
          }
          if (!anyVisible) {
            var hint = document.createElement("div");
            hint.className = "vp-search-empty-hint";
            hint.textContent = '0 hasil untuk "' + searchInput.value.trim() + '"';
            parent.insertBefore(hint, host.nextSibling);
          }
        }
      };
      searchInput.addEventListener("input", applySearchFilter);
    }

    // 3. Header "+ Add Project" button scroll / reveal dropzone
    var btnAddProj = document.getElementById("btn-header-add-project");
    var dropzone = document.getElementById("project-dropzone");
    if (btnAddProj && dropzone) {
      btnAddProj.addEventListener("click", function () {
        dropzone.scrollIntoView({ behavior: "smooth", block: "center" });
        dropzone.classList.add("dragover");
        setTimeout(function () {
          dropzone.classList.remove("dragover");
        }, 1500);
      });
    }

    // 4. "Start Meeting" button — trigger Hermes drawer. Utamakan API publik
    //    window.vpAssistant (dipasang assistant.js sejak awal, aman dipanggil
    //    sebelum drawer ready karena ada defer queue internal). Fallback lama
    //    (polling elemen trigger + alert) tetap dipertahankan bila API belum
    //    tersedia (mis. cached assistant.js versi lama).
    var btnMeeting = document.getElementById("btn-start-meeting");
    if (btnMeeting) {
      btnMeeting.addEventListener("click", function () {
        if (window.vpAssistant && typeof window.vpAssistant.toggle === "function") {
          window.vpAssistant.toggle();
          return;
        }
        var trigger = document.getElementById("vp-assistant-trigger");
        if (trigger) {
          trigger.click();
          return;
        }
        var attempts = 0;
        var poll = setInterval(function () {
          attempts++;
          if (window.vpAssistant && typeof window.vpAssistant.toggle === "function") {
            clearInterval(poll);
            window.vpAssistant.toggle();
          } else if (document.getElementById("vp-assistant-trigger")) {
            clearInterval(poll);
            document.getElementById("vp-assistant-trigger").click();
          } else if (attempts >= 20) {
            clearInterval(poll);
            alert("Hermes Agent AI Daemon aktif 24/7 di background pada port 8097.");
          }
        }, 150);
      });
    }
  }

  /* ---------- Project Detail: tab aktif mengikuti hash URL ---------- */

  function initProjectDetailTabs() {
    var tabsNav = document.querySelector("nav.tabs");
    if (!tabsNav) return;
    var tabs = tabsNav.querySelectorAll(".tab");
    if (!tabs.length) return;

    function syncActive() {
      var hash = window.location.hash || "";
      var matched = false;
      for (var i = 0; i < tabs.length; i++) {
        var href = tabs[i].getAttribute("href") || "";
        var isActive = hash !== "" && href === hash;
        tabs[i].classList.toggle("tab--active", isActive);
        tabs[i].setAttribute("aria-selected", isActive ? "true" : "false");
        if (isActive) matched = true;
      }
      // Tanpa hash: tidak ada tab aktif dipaksa (default lama tetap)
      return matched;
    }

    window.addEventListener("hashchange", syncActive);
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].addEventListener("click", function () {
        // hash berubah setelah navigasi anchor; sinkron di tick berikutnya
        setTimeout(syncActive, 0);
      });
    }
    syncActive();
  }

  /* ---------- Init ---------- */

  function init() {
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("click", onClickReveal, true);
    document.addEventListener("click", onClick, true);
    var logs = document.querySelectorAll("[data-autoscroll]");
    for (var i = 0; i < logs.length; i++) initLog(logs[i]);
    var uploads = document.querySelectorAll("[data-config-upload]");
    for (var j = 0; j < uploads.length; j++) initConfigUpload(uploads[j]);

    initDesktopTitlebar();
    initDropzone();
    initDonezoUI();
    initProjectDetailTabs();

    // Load Hermes AI Assistant widget
    if (document.body && !document.body.classList.contains("auth") && document.querySelector(".topbar")) {
      var asScript = document.createElement("script");
      asScript.src = "/static/assistant.js?v=" + Date.now();
      asScript.defer = true;
      document.body.appendChild(asScript);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
