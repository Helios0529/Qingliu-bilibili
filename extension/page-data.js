(function (root) {
  "use strict";
  function jsonObject(source, offset = 0) {
    const start = source.indexOf("{", offset);
    if (start < 0) return null;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) { try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; } }
      }
    }
    return null;
  }
  function extract(data) {
    const results = new Map();
    const stack = [data];
    let visited = 0;
    while (stack.length && visited++ < 10000 && results.size < 500) {
      const value = stack.pop();
      if (!value || typeof value !== "object") continue;
      if (/^BV[0-9A-Za-z]{10}$/.test(value.bvid || "") && value.argue_info?.argue_msg) {
        results.set(value.bvid, BiliFilterClassifier.fromView(value));
      }
      for (const [key, item] of Object.entries(value)) {
        // Do not traverse account/contact/comment payloads, which are unrelated
        // to determining the authorship of the current video.
        if (/^(?:author|owner|user|userInfo|user_info|comments?|commentList|im|messages?|contacts?|cookies?|token)$/i.test(key)) continue;
        if (item && typeof item === "object") stack.push(item);
      }
    }
    return [...results.values()];
  }
  function read(document) {
    const results = new Map();
    for (const script of document.querySelectorAll('script[type="application/json"], script:not([src]):not([type])')) {
      const source = script.textContent;
      if (!source || source.length > 2000000) continue;
      let data;
      try {
        if (script.type === "application/json") data = JSON.parse(source);
        else {
          const marker = source.indexOf("__INITIAL_STATE__");
          if (marker < 0) continue;
          data = jsonObject(source, marker);
        }
      } catch { continue; }
      for (const value of extract(data)) results.set(value.bvid, value);
    }
    return [...results.values()];
  }
  root.CleanFeedPageData = Object.freeze({ jsonObject, extract, read });
  if (typeof module !== "undefined") module.exports = root.CleanFeedPageData;
})(globalThis);
