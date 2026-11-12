const DEFAULTS = { enabled: true, scope: "all", preventClose: true };

const enabled = document.getElementById("enabled");
const preventClose = document.getElementById("preventClose");
const radios = document.querySelectorAll('input[name="scope"]');

chrome.storage.sync.get(DEFAULTS).then((s) => {
  enabled.checked = s.enabled;
  preventClose.checked = s.preventClose;
  radios.forEach((r) => (r.checked = r.value === s.scope));
});

enabled.addEventListener("change", () => chrome.storage.sync.set({ enabled: enabled.checked }));
preventClose.addEventListener("change", () =>
  chrome.storage.sync.set({ preventClose: preventClose.checked })
);
radios.forEach((r) =>
  r.addEventListener("change", () => r.checked && chrome.storage.sync.set({ scope: r.value }))
);
