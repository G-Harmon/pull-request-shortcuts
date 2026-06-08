// Service worker: owns dynamic content-script registration for user-added hosts.
//
// Why a worker (vs. doing it all in the popup): Chrome closes the action popup when the
// permission prompt appears, so any popup code AFTER `permissions.request` never runs. By
// driving registration off `permissions.onAdded` here, a host gets registered the moment
// its permission is granted, even though the popup is already gone. The popup also messages
// us for the already-granted case (no prompt → no onAdded). Both paths call the same
// idempotent enableHost.
"use strict";

const CONTENT = { js: ["content.js"], css: ["overlay.css"], runAt: "document_idle" };
const idFor = (h) => `prks-${h}`;
const originFor = (h) => `https://${h}/*`;

function hostFromOrigin(origin) {
  const m = /^https:\/\/([^/]+)\/\*$/.exec(origin || "");
  return m ? m[1].toLowerCase() : null;
}

async function getHosts() {
  const { customHosts = [] } = await chrome.storage.sync.get("customHosts");
  return Array.isArray(customHosts) ? [...new Set(customHosts)] : [];
}
async function setHosts(hosts) {
  await chrome.storage.sync.set({ customHosts: [...new Set(hosts)] });
}
async function isRegistered(host) {
  const regs = await chrome.scripting.getRegisteredContentScripts();
  return regs.some((r) => r.id === idFor(host));
}

// Register + persist a host (idempotent), then activate any already-open tabs on it.
async function enableHost(host) {
  if (!host || host === "github.com") return; // github.com is static in the manifest
  if (!(await chrome.permissions.contains({ origins: [originFor(host)] }))) return;
  if (!(await isRegistered(host))) {
    try {
      await chrome.scripting.registerContentScripts([
        { id: idFor(host), matches: [originFor(host)], ...CONTENT },
      ]);
    } catch (e) {
      /* already registered / transient */
    }
  }
  const hosts = await getHosts();
  if (!hosts.includes(host)) await setHosts([...hosts, host]);
  await injectOpenTabs(host);
}

async function disableHost(host) {
  if (!host) return;
  if (await isRegistered(host)) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [idFor(host)] });
    } catch (e) {
      /* ignore */
    }
  }
  const hosts = await getHosts();
  if (hosts.includes(host)) await setHosts(hosts.filter((h) => h !== host));
  try {
    await chrome.permissions.remove({ origins: [originFor(host)] });
  } catch (e) {
    /* ignore */
  }
}

// Inject into already-open tabs on this host so it works without a manual reload. tab.url is
// readable for hosts we hold permission for (just granted), so no "tabs" permission needed.
// content.js's __prksLoaded guard makes a redundant inject a no-op.
async function injectOpenTabs(host) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let h;
    try {
      h = new URL(tab.url).hostname.toLowerCase();
    } catch (e) {
      continue;
    }
    if (h !== host) continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: CONTENT.css });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT.js });
    } catch (e) {
      /* tab not injectable (e.g. mid-navigation) */
    }
  }
}

chrome.permissions.onAdded.addListener((perms) => {
  for (const o of perms.origins || []) enableHost(hostFromOrigin(o));
});
chrome.permissions.onRemoved.addListener((perms) => {
  for (const o of perms.origins || []) disableHost(hostFromOrigin(o));
});
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "enable") enableHost(msg.host);
  else if (msg.type === "disable") disableHost(msg.host);
});

// Safety net: keep registrations consistent with stored hosts + granted permissions.
async function reconcile() {
  for (const h of await getHosts()) {
    if (await chrome.permissions.contains({ origins: [originFor(h)] })) await enableHost(h);
    else await disableHost(h);
  }
}
chrome.runtime.onInstalled.addListener(reconcile);
chrome.runtime.onStartup.addListener(reconcile);
