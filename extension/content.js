(() => {
  "use strict";
  const Shared = BiliFilterShared;
  const Classifier = BiliFilterClassifier;
  const CARD_SELECTOR = ".feed-card, .bili-video-card, .video-page-card-small, .recommend-video-card, .video-card, .small-item, .rank-item, .bili-dyn-card-video";
  const TITLE_SELECTOR = ".bili-video-card__info--tit, .video-name, .title, .info-title, .bili-dyn-card-video__title, h3, h4";
  const PROTECTED_SELECTOR = "header, nav, .bili-header, #biliMainHeader, .video-info-container, #bilibili-player, .bpx-player-container";
  let preferences = Shared.settings();
  let initialized = false;
  let reveal = false;
  let scanTimer;
  let toolbar;
  let currentPage = location.href;
  let pageMetadata = null;
  let pageMetadataId = "";
  let pageRetryAt = 0;
  let pageRequest = null;
  let commitTimer;
  let uiTimer;
  let pageDataRead = false;
  const records = new WeakMap();
  const hiddenSlots = new Map();
  const compactLists = new Set();
  const cards = new Set();
  const metadata = new Map();
  const stagedMetadata = new Map();
  const fetching = new Set();
  const failures = new Map();
  const nearViewport = new WeakSet();
  const enabled = () => preferences.enabled;
  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) { nearViewport.add(entry.target); processCard(entry.target); }
      else nearViewport.delete(entry.target);
    }
  }, { rootMargin: "500px" });

  function ui(tag, className, text) {
    const element = document.createElement(tag);
    element.dataset.bafUi = "true";
    element.className = className;
    if (text) element.textContent = text;
    return element;
  }
  function pageIsReady() {
    if (document.readyState === "loading") return false;
    if (document.querySelector('[data-server-rendered="true"]')) return false;
    // Bilibili mounts its navigation asynchronously, even after DOMContentLoaded.
    // Inserting notices or starting cached metadata checks before that mount can
    // leave the navigation empty on a directly opened video page.
    const header = document.querySelector("#biliMainHeader, #internationalHeader");
    // The server-rendered fallback already contains links. Wait for the runtime
    // header, not that fallback; Vue must finish adopting the SSR DOM first.
    return !header || Boolean(header.querySelector(".left-entry-main a[href]") && header.textContent.trim());
  }
  function readCard(card) {
    if (card.closest(PROTECTED_SELECTOR)) return null;
    let links = [...card.querySelectorAll('a[href*="/video/BV"]')];
    // Ranking items can also link to the previous ranking's different video in
    // a hover tooltip. Identify the ranked work from its own title anchor.
    const rankedTitle = card.matches(".rank-item") ? card.querySelector('.content .info > a.title[href*="/video/BV"]') : null;
    const rankedId = rankedTitle && Shared.videoId(rankedTitle.getAttribute("href"));
    if (rankedId) links = links.filter(a => Shared.videoId(a.getAttribute("href")) === rankedId);
    // A navigation menu or collection containing several videos is not one card.
    const ids = new Set(links.map(a => Shared.videoId(a.getAttribute("href"))).filter(Boolean));
    if (ids.size !== 1) return null;
    const link = links.find(a => Shared.videoId(a.getAttribute("href")));
    if (!link) return null;
    const bvid = Shared.videoId(link.getAttribute("href"));
    const titleNode = rankedTitle || card.querySelector(TITLE_SELECTOR);
    const titleLink = links.find(a => a.getAttribute("title"));
    const textLink = links.find(a => a.textContent.trim());
    const title = preferences.blockWords.length ? Classifier.normalize(titleNode?.getAttribute("title") || titleNode?.textContent || titleLink?.getAttribute("title") || textLink?.textContent || "") : "";
    const declarationNode = card.querySelector(".video-argue, .argue-info, .argue, .ai-label, [data-ai-label]");
    return { bvid, title, declaration: declarationNode?.textContent || "" };
  }
  function resetCard(card) {
    card.classList.remove("baf-hidden", "baf-marked", "baf-card-anchor");
    releaseSlot(card);
    card.querySelector(":scope > .baf-badge")?.remove();
  }
  function releaseSlot(card) {
    const slot = hiddenSlots.get(card);
    hiddenSlots.delete(card);
    if (slot && ![...hiddenSlots.values()].includes(slot)) slot.classList.remove("baf-slot-hidden");
  }
  function layoutSlot(card) {
    // Search uses .video-list.row > .col_* > .bili-video-card. The column must
    // disappear too, otherwise flex/grid keeps an empty place for every result.
    if (location.hostname !== "search.bilibili.com") return card;
    for (let node = card, depth = 0; node?.parentElement && depth < 5; node = node.parentElement, depth++) {
      if (!node.parentElement.matches(".video-list")) continue;
      if (node.matches(PROTECTED_SELECTOR) || !node.contains(card)) return card;
      const ids = new Set([...node.querySelectorAll('a[href*="/video/BV"]')].map(a => Shared.videoId(a.getAttribute("href"))).filter(Boolean));
      return ids.size === 1 ? node : card;
    }
    return card;
  }
  function syncListLayouts() {
    // These lists assign the gutter with :nth-child(odd). Hidden items retain
    // their DOM index: two surviving odd items then overflow a two-column row.
    // Keep the original card widths and vertical spacing, but use one column-gap
    // on the list instead of margins tied to the original odd/even positions.
    const lists = new Set([...compactLists, ...document.querySelectorAll(".popular-list .card-list, .popular-video-container .card-list, .rank-list")]);
    for (const list of lists) {
      const children = [...list.children];
      const compact = list.isConnected && enabled() && children.some(child => child.classList.contains("baf-hidden") || child.classList.contains("baf-slot-hidden"));
      if (compact) {
        if (!compactLists.has(list)) {
          const listStyle = getComputedStyle(list);
          const nativeGap = parseFloat(listStyle.columnGap) || 0;
          const margin = Math.max(0, ...children.map(child => {
            const style = getComputedStyle(child);
            return (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
          }));
          let gap = nativeGap + margin;
          // Ranking uses space-between instead of odd-item margins. Preserve the
          // distributed gutter too when switching to stable start alignment.
          if (listStyle.justifyContent === "space-between") {
            const width = children.map(child => child.getBoundingClientRect().width).find(value => value > 0);
            const available = list.getBoundingClientRect().width - (parseFloat(listStyle.paddingLeft) || 0) - (parseFloat(listStyle.paddingRight) || 0) - (parseFloat(listStyle.borderLeftWidth) || 0) - (parseFloat(listStyle.borderRightWidth) || 0);
            if (width) {
              const columns = Math.max(1, Math.floor((available + gap + 0.01) / (width + gap)));
              if (columns > 1) gap = Math.max(gap, (available - columns * width) / (columns - 1));
            }
          }
          list.style.setProperty("--baf-list-gap", `${gap}px`);
          compactLists.add(list);
          list.classList.add("baf-compact-list");
        }
      } else {
        list.classList.remove("baf-compact-list");
        list.style.removeProperty("--baf-list-gap");
        compactLists.delete(list);
      }
    }
  }
  function syncHidden(card, shouldHide) {
    card.classList.toggle("baf-hidden", shouldHide);
    const target = shouldHide ? layoutSlot(card) : null;
    if (hiddenSlots.get(card) !== target) releaseSlot(card);
    if (target && target !== card) {
      hiddenSlots.set(card, target);
      target.classList.add("baf-slot-hidden");
    }
  }
  async function allow(bvid, button) {
    try {
      // Read the latest value, so other settings changed in the popup are retained.
      const data = await chrome.storage.local.get("settings");
      const next = Shared.settings(data.settings);
      if (next.allowVideos.includes(bvid)) return;
      if (next.allowVideos.length >= Shared.MAX_ALLOW_VIDEOS) {
        if (button) { button.textContent = "放行已满"; button.title = "最多放行 500 条，请先在插件设置中移除不需要的记录"; }
        return;
      }
      next.allowVideos.push(bvid);
      await chrome.storage.local.set({ settings: next });
    } catch { /* An invalidated context is resolved by refreshing the page. */ }
  }
  function render(card, input, result) {
    resetCard(card);
    if (!result.matched || !enabled()) return;
    const shouldHide = preferences.mode === "hide" && (result.confidence !== "medium" || preferences.includeSuspected) && !reveal;
    syncHidden(card, shouldHide);
    card.classList.add("baf-marked");
    // Absolute positioning preserves the site's flex rows and fixed card heights.
    // Leave absolute/sticky cards (including virtual lists) in their original mode.
    if (["static", ""].includes(getComputedStyle(card).position)) card.classList.add("baf-card-anchor");
    const label = result.source === "custom" ? "关键词屏蔽" : result.confidence === "medium" ? "B站提示:疑似 AI" : "B站标注:AI 生成";
    const badge = ui("div", "baf-badge");
    badge.title = result.reason;
    badge.append(ui("span", "baf-badge-label", label));
    const button = ui("button", "baf-allow", "放行");
    button.type = "button";
    button.title = "将这条视频加入白名单";
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void allow(input.bvid, button); });
    badge.append(button);
    card.append(badge);
  }
  function processCard(card, force = false) {
    if (!initialized || !card.isConnected || enabled() && !pageIsReady()) return;
    const input = readCard(card);
    const previous = records.get(card);
    if (!input) { resetCard(card); records.delete(card); return; }
    const detail = preferences.checkMetadata ? metadata.get(input.bvid) : null;
    const combined = { ...input, declaration: detail?.declaration || input.declaration };
    const signature = JSON.stringify(combined);
    if (force || previous?.signature !== signature || enabled() && previous?.result.matched && !card.querySelector(":scope > .baf-badge")) {
      const result = Classifier.classify(combined, preferences);
      records.set(card, { signature, result, bvid: input.bvid });
      render(card, input, result);
    }
    const result = records.get(card)?.result;
    syncHidden(card, Boolean(enabled() && result?.matched && preferences.mode === "hide" && (result.confidence !== "medium" || preferences.includeSuspected) && !reveal));
    if (enabled() && preferences.checkMetadata && !detail && nearViewport.has(card) && result?.source !== "allow" && (!result?.matched || result.confidence === "medium")) {
      const bounds = card.getBoundingClientRect();
      void check(input.bvid, bounds.top < innerHeight && bounds.bottom >= 0);
    }
  }
  function queueToolbar() {
    if (!uiTimer) uiTimer = setTimeout(() => { uiTimer = null; updateToolbar(); }, 80);
  }
  function flushMetadata() {
    commitTimer = null;
    const changed = new Set(stagedMetadata.keys());
    for (const [id, value] of stagedMetadata) metadata.set(id, value);
    stagedMetadata.clear();
    while (metadata.size > 1000) metadata.delete(metadata.keys().next().value);
    // Network replies do not introduce new DOM cards. Update only their cards;
    // the mutation observer discovers newly inserted cards independently.
    if (enabled() && !pageIsReady()) { schedule(); return; }
    for (const card of cards) if (changed.has(records.get(card)?.bvid)) processCard(card);
    updateToolbar();
    checkCurrentVideo();
  }
  async function check(bvid, priority = false) {
    if (fetching.has(bvid) || stagedMetadata.has(bvid) || (failures.get(bvid) || 0) > Date.now()) return;
    fetching.add(bvid);
    queueToolbar();
    try {
      const result = await chrome.runtime.sendMessage({ type: "metadata", bvid, priority });
      if (result?.ok) {
        stagedMetadata.set(bvid, result.value);
        // Apply a small group in one DOM pass instead of collapsing one card per
        // network callback. The timer is bounded, so slow requests cannot hold it.
        if (!commitTimer) commitTimer = setTimeout(flushMetadata, 600);
        failures.delete(bvid);
      } else failures.set(bvid, result?.retryAt || Date.now() + 60000);
    } catch { failures.set(bvid, Date.now() + 60000); }
    finally { fetching.delete(bvid); }
    queueToolbar();
  }
  function updateToolbar() {
    syncListLayouts();
    let hidden = 0;
    let marked = 0;
    for (const card of cards) {
      if (!card.isConnected) { resetCard(card); cards.delete(card); intersection.unobserve(card); continue; }
      if (card.classList.contains("baf-hidden")) hidden++;
      if (card.classList.contains("baf-marked")) marked++;
    }
    const waiting = fetching.size + stagedMetadata.size;
    if (!enabled() || !marked && !waiting || !document.body) { toolbar?.remove(); toolbar = null; return; }
    if (!toolbar) {
      toolbar = ui("aside", "baf-toolbar");
      toolbar.setAttribute("aria-label", "清流 AI 过滤状态");
      toolbar.append(ui("span", "baf-summary"));
      const toggle = ui("button", "baf-toggle");
      toggle.type = "button";
      toggle.addEventListener("click", () => {
        reveal = !reveal;
        for (const card of cards) processCard(card, true);
        updateToolbar();
      });
      toolbar.append(toggle);
      document.body.append(toolbar);
    }
    toolbar.querySelector(".baf-summary").textContent = (hidden ? `清流 · 已屏蔽 ${hidden} 条` : marked ? `清流 · 已标注 ${marked} 条` : "清流") + (waiting ? ` · 检查中 ${waiting}` : "");
    const toggle = toolbar.querySelector("button");
    toggle.hidden = preferences.mode !== "hide" || !marked;
    toggle.textContent = reveal ? "恢复屏蔽" : "查看已屏蔽";
    toggle.setAttribute("aria-pressed", String(reveal));
  }
  function checkCurrentVideo() {
    const bvid = Shared.videoId(location.pathname);
    const existing = document.querySelector(".baf-page-notice");
    if (!bvid || !enabled()) { existing?.remove(); return; }
    if (!pageIsReady()) return;
    if (pageMetadataId !== bvid) {
      pageMetadata = null; pageMetadataId = bvid; pageRetryAt = 0;
      if (pageRequest?.bvid !== bvid) pageRequest = null;
    }
    if (preferences.checkMetadata && metadata.has(bvid)) pageMetadata = metadata.get(bvid);
    const titleNode = document.querySelector("h1.video-title") || document.querySelector(".video-info-container h1, .video-info-title-inner");
    if (!titleNode) return;
    const declaration = document.querySelector(".video-info-container .video-argue, .video-info-container .argue, .video-info-container .argue-info")?.textContent || "";
    const input = { bvid, title: titleNode.textContent, declaration: (preferences.checkMetadata && pageMetadata?.declaration) || declaration };
    const result = Classifier.classify(input, preferences);
    if (!result.matched) existing?.remove();
    else if (existing?.dataset.bvid !== bvid || existing.title !== result.reason) {
      existing?.remove();
      const notice = ui("div", "baf-page-notice");
      notice.dataset.bvid = bvid;
      notice.title = result.reason;
      notice.append(ui("span", "", result.source === "custom" ? "关键词屏蔽 · 可查看匹配词" : result.confidence === "medium" ? "B站提示:疑似 AI · 可查看声明" : "B站标注:AI 生成"));
      const button = ui("button", "baf-allow", "放行此视频");
      button.type = "button";
      button.addEventListener("click", () => void allow(bvid, button));
      notice.append(button);
      // Keep notices outside the fixed-height title and statistics container.
      document.body?.append(notice);
    }
    // Render a native declaration immediately. Unknown videos need an API check;
    // their titles, descriptions and tags never determine the result.
    if (!preferences.checkMetadata || pageMetadata || pageRequest || Date.now() < pageRetryAt || result.source === "allow" || result.matched && result.confidence !== "medium") return;
    const request = { bvid };
    pageRequest = request;
    let response;
    try { response = chrome.runtime.sendMessage({ type: "metadata", bvid, priority: true }); }
    catch { pageRequest = null; pageRetryAt = Date.now() + 60000; return; }
    response.then(answer => {
      if (pageRequest !== request || bvid !== Shared.videoId(location.pathname) || !enabled() || !preferences.checkMetadata) return;
      if (answer?.ok) {
        pageMetadata = answer.value;
        metadata.set(bvid, answer.value);
        if (pageIsReady()) for (const card of cards) if (records.get(card)?.bvid === bvid) processCard(card);
        queueToolbar();
      } else pageRetryAt = answer?.retryAt || Date.now() + 60000;
    }).catch(() => {
      if (pageRequest === request) pageRetryAt = Date.now() + 60000;
    }).finally(() => {
      if (pageRequest !== request) return;
      pageRequest = null;
      checkCurrentVideo();
    });
  }
  function scan(force = false) {
    if (!initialized || enabled() && !pageIsReady()) return;
    if (location.href !== currentPage) {
      currentPage = location.href; pageMetadata = null; pageRequest = null; pageRetryAt = 0; reveal = false; pageDataRead = false;
      document.querySelector(".baf-page-notice")?.remove();
    }
    if (!pageDataRead && globalThis.CleanFeedPageData) {
      for (const value of CleanFeedPageData.read(document)) metadata.set(value.bvid, value);
      pageDataRead = true;
    }
    // Queue the intentionally opened video before nearby recommendation checks.
    checkCurrentVideo();
    const candidates = [...document.querySelectorAll(CARD_SELECTOR)].filter(candidate => readCard(candidate));
    const valid = new Set(candidates);
    const selected = new Set();
    for (const candidate of candidates) {
      // A homepage feed-card contains a bili-video-card: handle the outer grid item once.
      let ancestor = candidate.parentElement?.closest(CARD_SELECTOR);
      let nested = false;
      while (ancestor) {
        if (valid.has(ancestor)) { nested = true; break; }
        ancestor = ancestor.parentElement?.closest(CARD_SELECTOR);
      }
      if (nested) continue;
      selected.add(candidate);
      if (!cards.has(candidate)) { cards.add(candidate); intersection.observe(candidate); }
      processCard(candidate, force);
    }
    // Cards can be reused for skeletons/non-video content or moved between slots.
    for (const card of cards) if (!selected.has(card)) {
      resetCard(card); records.delete(card); cards.delete(card); intersection.unobserve(card);
    }
    updateToolbar();
  }
  function schedule() { if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 100); }
  document.addEventListener("DOMContentLoaded", schedule, { once: true });
  window.addEventListener("load", schedule, { once: true });
  window.addEventListener("popstate", schedule);
  new MutationObserver(mutations => {
    const changed = mutations.some(m => {
      const element = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
      if (element?.closest("[data-baf-ui]")) return false;
      return m.type !== "childList" || [...m.addedNodes, ...m.removedNodes].some(n => !n.dataset?.bafUi);
    });
    if (changed) schedule();
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "title", "data-server-rendered"] });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) {
      preferences = Shared.settings(changes.settings.newValue);
      pageRequest = null;
      reveal = false;
      scan(true);
    }
    if (changes.metadataCacheV1 && !changes.metadataCacheV1.newValue) {
      metadata.clear(); stagedMetadata.clear(); failures.clear(); pageMetadata = null; pageRequest = null; pageRetryAt = 0; scan(true);
    }
  });
  chrome.storage.local.get(["settings", "metadataCacheV1"]).then(data => {
    preferences = Shared.settings(data.settings);
    for (const [id, entry] of Object.entries(data.metadataCacheV1 || {})) {
      if (entry?.expires > Date.now() && entry.value && Shared.videoId(id)) metadata.set(id, { bvid: id, declaration: Classifier.normalize(entry.value.declaration) });
    }
    initialized = true; scan();
  }).catch(() => { initialized = true; scan(); });
  // Retry temporary failures and detect SPA navigations that do not change card DOM.
  setInterval(() => { if (!document.hidden && enabled()) scan(); }, 15000);
})();
