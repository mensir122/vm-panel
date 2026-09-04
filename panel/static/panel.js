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
      ? e.target.closest('a[data-confirm]')
      : null;
    if (!trigger) return;
    e.preventDefault();
    openConfirm(trigger);
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

  /* ---------- Init ---------- */

  function init() {
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("click", onClick, true);
    var logs = document.querySelectorAll("[data-autoscroll]");
    for (var i = 0; i < logs.length; i++) initLog(logs[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
