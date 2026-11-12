// KeepTab content script.
//
// In a pinned tab, a link click or form submission that would navigate the
// whole page is retargeted to "_blank", so it opens in a new tab and the pin
// stays where it is.
//
// We decide *after* the page's own handlers have run: if the page called
// preventDefault() (e.g. a SPA router handling the click in-place), we leave it
// alone so pinned web apps keep working normally.

(() => {
  if (window.top !== window) return;

  let pinned = false;
  const settings = { enabled: true, scope: "all" };

  const alive = () => !!chrome.runtime?.id; // false after extension reload/update

  chrome.storage.sync.get(settings).then((s) => Object.assign(settings, s)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k in changes) settings[k] = changes[k].newValue;
  });
  chrome.runtime
    .sendMessage({ type: "getState" })
    .then((r) => (pinned = !!r?.pinned))
    .catch(() => {});
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "pinned") pinned = msg.pinned;
  });

  const active = () => alive() && pinned && settings.enabled;

  const siteOf = (u) => u.hostname.replace(/^www\./, "");

  function isLeaving(url) {
    let to;
    try {
      to = new URL(url, location.href);
    } catch {
      return false;
    }
    if (to.protocol !== "http:" && to.protocol !== "https:") return false;
    const here = new URL(location.href);
    const strip = (u) => u.href.split("#")[0];
    if (strip(to) === strip(here)) return false; // same document / hash link
    if (settings.scope === "cross-site" && siteOf(to) === siteOf(here)) return false;
    return true;
  }

  function baseTarget() {
    return document.querySelector("base[target]")?.getAttribute("target") || "";
  }

  // Does this target keep the navigation in the current tab?
  function isSelfTarget(target) {
    const t = (target || "").toLowerCase();
    return t === "" || t === "_self" || t === "_top" || t === "_parent";
  }

  // Temporarily set an attribute; restore after the current event dispatch
  // (the browser reads it during the default action, which runs synchronously).
  function setTemporarily(el, attr, value) {
    const had = el.hasAttribute(attr);
    const old = el.getAttribute(attr);
    el.setAttribute(attr, value);
    setTimeout(() => (had ? el.setAttribute(attr, old) : el.removeAttribute(attr)), 0);
  }

  // Run `fn` at the very end of event dispatch: a capture listener on window
  // appends a bubble listener on window, which therefore runs after every
  // other handler on the page.
  function runLast(type, fn) {
    window.addEventListener(
      type,
      (e) => {
        if (!active()) return;
        const handler = (ev) => {
          window.removeEventListener(type, handler);
          if (ev === e) fn(ev);
        };
        window.addEventListener(type, handler);
        // If propagation was stopped we never reach bubble phase; clean up.
        setTimeout(() => window.removeEventListener(type, handler), 0);
      },
      true
    );
  }

  // ---- links ----------------------------------------------------------------

  runLast("click", (e) => {
    if (!active() || e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const a = e
      .composedPath()
      .find(
        (n) =>
          (n instanceof HTMLAnchorElement || n instanceof HTMLAreaElement) &&
          n.hasAttribute("href")
      );
    if (!a || a.hasAttribute("download")) return;
    if (!isSelfTarget(a.getAttribute("target") ?? baseTarget())) return; // already opens elsewhere
    if (!isLeaving(a.href)) return;

    setTemporarily(a, "target", "_blank");
  });

  // ---- forms ----------------------------------------------------------------

  runLast("submit", (e) => {
    if (!active() || e.defaultPrevented) return;
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = e.submitter;

    const method = (
      (submitter?.hasAttribute("formmethod") && submitter.getAttribute("formmethod")) ||
      form.method ||
      "get"
    ).toLowerCase();
    if (method === "dialog") return;

    const target = submitter?.hasAttribute("formtarget")
      ? submitter.getAttribute("formtarget")
      : form.getAttribute("target") ?? baseTarget();
    if (!isSelfTarget(target)) return;

    const action = submitter?.hasAttribute("formaction") ? submitter.formAction : form.action;
    let dest = action;
    if (method === "get") {
      try {
        const u = new URL(action, location.href);
        u.search = new URLSearchParams(new FormData(form, submitter)).toString();
        dest = u.href;
      } catch {}
    }
    // A POST always loads a new page, so in "all" mode it's always intercepted.
    const leaving =
      method === "get" ? isLeaving(dest) : settings.scope === "all" || isLeaving(action);
    if (!leaving) return;

    if (submitter?.hasAttribute("formtarget")) setTemporarily(submitter, "formtarget", "_blank");
    else setTemporarily(form, "target", "_blank");
  });
})();
