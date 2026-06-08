// Toolbar popup: manage which hosts the shortcuts run on. github.com is built in (static
// content_scripts in the manifest). Additional hosts (e.g. GitHub Enterprise) are stored in
// chrome.storage.sync and injected via dynamically-registered content scripts.
//
// The popup only requests/removes the per-site permission and renders the list; background.js
// does the registration + storage + tab-injection. That split matters: Chrome closes this
// popup when the permission prompt appears, so any code here after permissions.request may
// never run — but the worker's permissions.onAdded handler still fires.
"use strict";

const originFor = (h) => `https://${h}/*`;

const hostsEl = document.getElementById("hosts");
const inputEl = document.getElementById("host");
const addBtn = document.getElementById("add");
const msgEl = document.getElementById("msg");

function setMsg(text, kind) {
  msgEl.textContent = text || "";
  msgEl.className = "msg" + (kind ? " " + kind : "");
}

// "git.example.com", "https://git.example.com", "https://git.example.com/x" → "git.example.com".
function normalizeHost(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let host;
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch (e) {
    return null;
  }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

async function getHosts() {
  const { customHosts = [] } = await chrome.storage.sync.get("customHosts");
  return Array.isArray(customHosts) ? [...new Set(customHosts)] : [];
}

async function render() {
  const hosts = await getHosts();
  hostsEl.textContent = "";
  hostsEl.appendChild(rowEl("github.com", true));
  for (const h of hosts) hostsEl.appendChild(rowEl(h, false));
}

function rowEl(host, builtin) {
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.className = "host";
  span.textContent = host;
  li.appendChild(span);
  if (builtin) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "built-in";
    li.appendChild(tag);
  } else {
    const btn = document.createElement("button");
    btn.className = "remove";
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => removeHost(host));
    li.appendChild(btn);
  }
  return li;
}

function addHost() {
  const host = normalizeHost(inputEl.value);
  if (!host) {
    setMsg("Enter a valid host, e.g. git.example.com", "err");
    return;
  }
  if (host === "github.com") {
    setMsg("github.com is already built in.", "err");
    return;
  }
  setMsg("Requesting permission…");
  // Callback form keeps the call inside the user-gesture stack (required for the prompt).
  chrome.permissions.request({ origins: [originFor(host)] }, (granted) => {
    if (chrome.runtime.lastError || !granted) {
      setMsg("Permission denied — not added.", "err");
      return;
    }
    // Hand off to the worker (covers the already-granted case where no onAdded fires). If the
    // popup was closed by the prompt, the worker's permissions.onAdded handler does this.
    chrome.runtime.sendMessage({ type: "enable", host });
    inputEl.value = "";
    setMsg(`Added ${host}.`, "ok");
  });
}

function removeHost(host) {
  chrome.runtime.sendMessage({ type: "disable", host });
  setMsg(`Removed ${host}. Reload its tabs to fully deactivate.`, "ok");
}

// Live-update the list as the worker changes storage (add/remove/reconcile).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.customHosts) render();
});
addBtn.addEventListener("click", addHost);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addHost();
});
render();
