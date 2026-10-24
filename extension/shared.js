/* Shared between the service worker, isolated content script and settings page. */
(function (root) {
  "use strict";
  const MAX_ALLOW_VIDEOS = 500;
  const DEFAULTS = Object.freeze({ enabled: true, mode: "hide", checkMetadata: true, includeSuspected: false, allowVideos: [], blockWords: [] });
  function lines(value, limit = 200) {
    const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
    return [...new Set(list.filter(v => typeof v === "string").map(v => v.trim().slice(0, 100)).filter(Boolean))].slice(0, limit);
  }
  function settings(value = {}) {
    return {
      // Preserve a previously paused Bilibili site when migrating to one switch.
      enabled: (typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled) && value.bilibiliEnabled !== false,
      mode: value.mode === "mark" ? "mark" : "hide",
      checkMetadata: value.includeSuspected === true || (typeof value.checkMetadata === "boolean" ? value.checkMetadata : true),
      includeSuspected: value.includeSuspected === true,
      allowVideos: lines(value.allowVideos, MAX_ALLOW_VIDEOS).filter(v => /^BV[0-9A-Za-z]{10}$/.test(v)),
      blockWords: lines(value.blockWords)
    };
  }
  function videoId(input) {
    if (typeof input !== "string") return null;
    const match = input.match(/(?:^|\/)(BV[0-9A-Za-z]{10})(?=$|[/?#])/);
    return match ? match[1] : null;
  }
  root.BiliFilterShared = Object.freeze({ DEFAULTS, MAX_ALLOW_VIDEOS, settings, lines, videoId });
  if (typeof module !== "undefined") module.exports = root.BiliFilterShared;
})(globalThis);
