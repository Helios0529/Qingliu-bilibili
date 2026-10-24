"use strict";
importScripts("shared.js", "classifier.js");
const CACHE_KEY = "metadataCacheV1";
const TTL = 24 * 60 * 60 * 1000;
const CONCURRENCY = 2;
const REQUEST_SPACING = 250;
const queue = [];
const pending = new Map();
let cache = {};
let preferences = BiliFilterShared.settings();
let active = 0;
let blockedUntil = 0;
let nextRequestAt = 0;
let persistTimer;
let cacheHits = 0;
let networkRequests = 0;
const ready = chrome.storage.local.get([CACHE_KEY, "apiBlockedUntil", "settings"]).then(data => {
  preferences = BiliFilterShared.settings(data.settings);
  for (const [id, entry] of Object.entries(data[CACHE_KEY] || {})) {
    if (/^BV[0-9A-Za-z]{10}$/.test(id) && entry?.expires > Date.now() && entry.value) cache[id] = { expires: entry.expires, value: { bvid: id, declaration: BiliFilterClassifier.normalize(entry.value.declaration) } };
  }
  blockedUntil = Number(data.apiBlockedUntil) || 0;
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) preferences = BiliFilterShared.settings(changes.settings.newValue);
});
const enabled = () => preferences.enabled && preferences.checkMetadata;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    cache = Object.fromEntries(Object.entries(cache).filter(([, item]) => item.expires > Date.now()).slice(-1000));
    chrome.storage.local.set({ [CACHE_KEY]: cache }).catch(() => {});
  }, 300);
}
async function json(path) {
  const start = Math.max(Date.now(), nextRequestAt);
  nextRequestAt = start + REQUEST_SPACING;
  if (start > Date.now()) await sleep(start - Date.now());
  if (!enabled()) throw new Error("disabled");
  if (Date.now() < blockedUntil) throw new Error("rate-limit");
  networkRequests++;
  const response = await fetch(`https://api.bilibili.com${path}`, {
    credentials: "omit", signal: AbortSignal.timeout(6000), referrerPolicy: "no-referrer"
  });
  if ([403, 412, 429].includes(response.status)) throw new Error("rate-limit");
  if (response.status === 404) throw new Error("unsupported");
  if (!response.ok) throw new Error("network");
  const body = await response.json();
  if ([-412, -352, -509, -799].includes(body.code)) throw new Error("rate-limit");
  if (body.code === -404) throw new Error("unsupported");
  if (body.code !== 0 || !body.data) throw new Error("unavailable");
  return body.data;
}
async function load(bvid) {
  const view = await json(`/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
  const value = BiliFilterClassifier.fromView(view);
  value.bvid = bvid;
  value.declaration = value.declaration.slice(0, 400);
  return value;
}
async function run(job) {
  let answer;
  if (!enabled()) answer = { ok: false, error: "disabled" };
  else if (Date.now() < blockedUntil) answer = { ok: false, error: "cooldown", retryAt: blockedUntil };
  else {
    try {
      const value = await load(job.bvid);
      cache[job.bvid] = { expires: Date.now() + TTL, value };
      persist();
      answer = { ok: true, value };
    } catch (error) {
      const limited = error.message === "rate-limit";
      if (limited) {
        blockedUntil = Math.max(blockedUntil, Date.now() + 5 * 60 * 1000);
        await chrome.storage.local.set({ apiBlockedUntil: blockedUntil }).catch(() => {});
      }
      answer = { ok: false, error: limited ? "cooldown" : error.message === "disabled" ? "disabled" : "unavailable", retryAt: limited ? blockedUntil : Date.now() + 60000 };
      cache[job.bvid] = { expires: Date.now() + 60000, value: null, failure: answer };
    }
  }
  job.resolve(answer);
  pending.delete(job.bvid);
}
function drain() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    run(job).finally(() => { active--; drain(); });
  }
}
async function metadata(bvid, priority = false) {
  await ready;
  if (!enabled()) return { ok: false, error: "disabled" };
  if (cache[bvid]?.expires > Date.now()) {
    cacheHits++;
    return cache[bvid].value ? { ok: true, value: cache[bvid].value } : cache[bvid].failure;
  }
  if (pending.has(bvid)) return pending.get(bvid);
  if (queue.length >= 80) return { ok: false, error: "busy", retryAt: Date.now() + 15000 };
  const result = new Promise(resolve => {
    const job = { bvid, resolve, priority };
    const index = priority ? queue.findIndex(item => !item.priority) : -1;
    index < 0 ? queue.push(job) : queue.splice(index, 0, job);
  });
  pending.set(bvid, result);
  drain();
  return result;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return;
  if (message.type === "metadata" && typeof message.bvid === "string" && /^BV[0-9A-Za-z]{10}$/.test(message.bvid)) {
    metadata(message.bvid, message.priority === true).then(sendResponse).catch(() => sendResponse({ ok: false, error: "unavailable" }));
    return true;
  }
  if (message.type === "clear-cache") {
    ready.then(async () => { cache = {}; await chrome.storage.local.remove(CACHE_KEY); sendResponse({ ok: true }); }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === "diagnostics") {
    ready.then(() => sendResponse({ active, queued: queue.length, cacheHits, networkRequests, cooldownUntil: blockedUntil }));
    return true;
  }
});
