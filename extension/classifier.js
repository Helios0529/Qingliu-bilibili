(function (root) {
  "use strict";
  const normalize = text => String(text || "").normalize("NFKC").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const AI = /(?:\bai\b|aigc|人工智能)/i;
  const SUSPECTED = /疑似|可能|或含|或使用/;
  function classify(input = {}, preferences = {}) {
    const declaration = normalize(input.declaration);
    const clear = { matched: false, confidence: "none", reason: "", source: "none" };
    const hit = (reason, confidence, source) => ({ matched: true, confidence, reason, source });
    if (preferences.allowVideos?.includes(input.bvid)) return { ...clear, source: "allow" };
    // Title matching is opt-in and contains only the user's own keywords.
    const title = normalize(input.title).toLocaleLowerCase();
    const keyword = preferences.blockWords?.find(word => normalize(word) && title.includes(normalize(word).toLocaleLowerCase()));
    if (keyword) return hit(`自定义屏蔽词：${keyword}`, "high", "custom");
    // Automatic AI filtering uses only the site's declaration field.
    if (declaration && AI.test(declaration) && /合成|生成|制作|创作/.test(declaration)) {
      return hit(`作者或平台声明：${declaration}`, SUSPECTED.test(declaration) ? "medium" : "confirmed", "declaration");
    }
    return clear;
  }
  function fromView(data) {
    return {
      bvid: data.bvid,
      declaration: normalize(data.argue_info?.argue_msg)
    };
  }
  root.BiliFilterClassifier = Object.freeze({ classify, fromView, normalize });
  if (typeof module !== "undefined") module.exports = root.BiliFilterClassifier;
})(globalThis);
