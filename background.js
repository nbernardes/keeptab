// KeepTab background service worker.
//
// Primary interception happens in content.js (link clicks / form submits are
// redirected to a new tab before the pinned tab ever navigates). This worker:
//   1. Tells content scripts whether their tab is pinned.
//   2. Acts as a fallback for navigations the content script can't see
//      (location.href = ..., form.submit(), omnibox, etc.): when a pinned tab
//      commits a new page, open that URL in a new tab and send the pin back.
//   3. Reopens pinned tabs that get closed. Chrome has no API to block
//      closing a tab, so a closed pin is restored right away from Chrome's
//      recently-closed list, which brings back its history too. To get rid of
//      a pin, unpin it first (right-click → Unpin), then close it.

const DEFAULTS = { enabled: true, scope: "all", preventClose: true }; // scope: "all" | "cross-site"

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

// ---- per-tab state (survives service worker restarts) ----------------------

const lastKey = (tabId) => `last:${tabId}`;
const restoreKey = (tabId) => `restore:${tabId}`;

async function getLastUrl(tabId) {
  return (await chrome.storage.session.get(lastKey(tabId)))[lastKey(tabId)];
}
function setLastUrl(tabId, url) {
  return chrome.storage.session.set({ [lastKey(tabId)]: url });
}
async function consumeRestoring(tabId) {
  const k = restoreKey(tabId);
  const v = (await chrome.storage.session.get(k))[k];
  if (v) await chrome.storage.session.remove(k);
  return !!v;
}

// ---- helpers ----------------------------------------------------------------

const BLANKISH = /^(about:blank|chrome:\/\/newtab|chrome-search:\/\/|chrome:\/\/new-tab-page)/;

function stripHash(url) {
  return url.split("#")[0];
}

function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Navigations that represent the user going somewhere new.
const INTERCEPT_TYPES = new Set([
  "link",
  "typed",
  "form_submit",
  "generated",
  "keyword",
  "keyword_generated",
  "auto_bookmark",
]);

function shouldIntercept(details, prevUrl, settings) {
  if (!prevUrl || BLANKISH.test(prevUrl)) return false; // pin not "set" yet
  if (!/^https?:/.test(details.url)) return false;
  if (!INTERCEPT_TYPES.has(details.transitionType)) return false;
  const q = details.transitionQualifiers || [];
  if (q.includes("forward_back") || q.includes("client_redirect")) return false;
  if (stripHash(details.url) === stripHash(prevUrl)) return false;
  if (settings.scope === "cross-site" && siteOf(details.url) === siteOf(prevUrl)) return false;
  return true;
}

// ---- rate limiting ------------------------------------------------------------
// Stops runaway loops: a pinned page that keeps navigating itself by script
// would otherwise open endless tabs, and something that keeps closing a pin
// (another extension, a policy) would fight with us forever.

const LIMIT = 3;
const WINDOW_MS = 10_000;
const hits = new Map();

function allow(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

// ---- fallback: pinned tab committed a new page ------------------------------

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  if (details.documentLifecycle && details.documentLifecycle !== "active") return; // prerender

  const { tabId } = details;
  const prevUrl = await getLastUrl(tabId);
  await setLastUrl(tabId, details.url);

  if (await consumeRestoring(tabId)) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.pinned) return;

  const settings = await getSettings();
  if (!settings.enabled || !shouldIntercept(details, prevUrl, settings)) return;
  if (!allow(`nav:${tabId}`)) return; // looping page: leave it in the pin

  await chrome.tabs.create({
    url: details.url,
    windowId: tab.windowId,
    openerTabId: tabId,
    active: true,
  });

  // Put the pin back where it was. goBack is fastest (bfcache); fall back to
  // loading the previous URL explicitly.
  try {
    await chrome.tabs.goBack(tabId);
  } catch {
    await chrome.storage.session.set({ [restoreKey(tabId)]: true });
    await chrome.tabs.update(tabId, { url: prevUrl });
  }
});

// Keep the "current URL" up to date for in-page (SPA / hash) navigations.
const trackSameDoc = (d) => {
  if (d.frameId === 0) setLastUrl(d.tabId, d.url);
};
chrome.webNavigation.onHistoryStateUpdated.addListener(trackSameDoc);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(trackSameDoc);

// ---- pinned tab registry ----------------------------------------------------
// onRemoved doesn't tell us whether the tab was pinned, so we keep track of
// every pinned tab ourselves. The list is kept in memory and in session
// storage so it survives service worker restarts.

let pinsCache = null;

async function loadPins() {
  if (!pinsCache) pinsCache = (await chrome.storage.session.get("pins")).pins || {};
  return pinsCache;
}

async function syncPins() {
  const tabs = await chrome.tabs.query({ pinned: true });
  const next = {};
  for (const t of tabs) {
    next[t.id] = { windowId: t.windowId, index: t.index, url: t.url || t.pendingUrl || "" };
  }
  pinsCache = next;
  await chrome.storage.session.set({ pins: next });
}

chrome.tabs.onCreated.addListener((tab) => tab.pinned && syncPins());
chrome.tabs.onMoved.addListener(() => syncPins());
chrome.tabs.onAttached.addListener(() => syncPins());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.pinned !== undefined || (changeInfo.url && tab.pinned)) syncPins();
});
chrome.runtime.onStartup.addListener(() => syncPins());

// ---- reopen closed pinned tabs ------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let restoreQueue = Promise.resolve(); // one restore at a time (e.g. closing several tabs at once)

async function findClosedSession(rec) {
  // The closed tab can take a moment to appear in the recently-closed list.
  for (let i = 0; i < 5; i++) {
    const entries = await chrome.sessions.getRecentlyClosed({ maxResults: 10 });
    const hit = entries.find((e) => e.tab && e.tab.url === rec.url);
    if (hit) return hit.tab.sessionId;
    await sleep(100);
  }
  return null;
}

async function reopenPin(rec) {
  let tab = null;
  const sessionId = await findClosedSession(rec);
  if (sessionId) {
    const restored = await chrome.sessions.restore(sessionId).catch(() => null);
    tab = restored?.tab ?? null;
  }
  if (!tab) {
    // Fallback: open a new pinned tab at the same URL (without the old history).
    tab = await chrome.tabs.create({
      url: rec.url || undefined,
      windowId: rec.windowId,
      index: rec.index,
      pinned: true,
      active: true,
    }).catch(() => null);
  }
  if (tab && !tab.pinned) await chrome.tabs.update(tab.id, { pinned: true }).catch(() => {});
  if (tab) await chrome.tabs.move(tab.id, { index: rec.index }).catch(() => {});
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  chrome.storage.session.remove([lastKey(tabId), restoreKey(tabId)]);
  hits.delete(`nav:${tabId}`);

  const pins = await loadPins();
  const rec = pins[tabId];
  if (!rec) return;
  delete pins[tabId];
  chrome.storage.session.set({ pins });

  // Closing the whole window (or quitting Chrome) is allowed.
  if (removeInfo.isWindowClosing) return;
  const { preventClose } = await getSettings();
  if (!preventClose) return;
  // Tab ids change on every reopen, so key the limit by URL.
  if (!allow(`reopen:${rec.windowId}:${rec.url}`)) return;

  restoreQueue = restoreQueue.then(() => reopenPin(rec)).catch(() => {});
});

chrome.tabs.onReplaced.addListener(async (added, removed) => {
  const url = await getLastUrl(removed);
  if (url) await setLastUrl(added, url);
  chrome.storage.session.remove([lastKey(removed), restoreKey(removed)]);
});

// ---- content script communication -------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "getState") {
    sendResponse({ pinned: !!sender.tab?.pinned });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.pinned !== undefined) {
    chrome.tabs.sendMessage(tabId, { type: "pinned", pinned: changeInfo.pinned }).catch(() => {});
  }
});

// ---- install: inject into already-open tabs & seed URLs ---------------------

chrome.runtime.onInstalled.addListener(async () => {
  syncPins();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url) setLastUrl(tab.id, tab.url);
    if (!/^https?:/.test(tab.url || "")) continue;
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
      .catch(() => {});
  }
});
