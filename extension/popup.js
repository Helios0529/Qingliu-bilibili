"use strict";
const $ = id => document.getElementById(id);
const autosave = ["enabled", "includeSuspected"];
let saving = Promise.resolve();
let allowedVideos = [];
function status(text, error = false) { $("status").textContent = text; $("status").classList.toggle("error", error); }
function renderAllowedVideos() {
  $("allowList").replaceChildren();
  if (!$("allowDetails").open) return;
  if (!allowedVideos.length) {
    const empty = document.createElement("li"); empty.className = "allow-empty"; empty.textContent = "暂无放行视频"; $("allowList").append(empty); return;
  }
  const fragment = document.createDocumentFragment();
  for (const id of allowedVideos) {
    const row = document.createElement("li"), label = document.createElement("span"), remove = document.createElement("button");
    label.textContent = id; remove.textContent = "移除"; remove.type = "button";
    remove.setAttribute("aria-label", `移除放行 ${id}`);
    remove.addEventListener("click", () => void update(value => { value.allowVideos = value.allowVideos.filter(item => item !== id); return value; }, "已移除，视频将重新参与过滤"));
    row.append(label, remove); fragment.append(row);
  }
  $("allowList").append(fragment);
}
function paint(value, includeRules = true) {
  for (const name of autosave) $(name).checked = value[name];
  document.querySelector(`input[name="mode"][value="${value.mode}"]`).checked = true;
  $("state").textContent = value.enabled ? "正在守护你的推荐列表" : "已暂停，原有卡片已恢复";
  $("controls").disabled = !value.enabled;
  if (includeRules) $("blockWords").value = value.blockWords.join("\n");
  allowedVideos = value.allowVideos;
  $("allowSummary").textContent = `已放行视频（${allowedVideos.length} / ${BiliFilterShared.MAX_ALLOW_VIDEOS}）`;
  renderAllowedVideos();
}
function update(change, message = "已保存，打开的 B 站页面即时生效") {
  saving = saving.then(async () => {
    const data = await chrome.storage.local.get("settings");
    const value = BiliFilterShared.settings(change(BiliFilterShared.settings(data.settings)));
    await chrome.storage.local.set({ settings: value });
    paint(value, false);
    status(message);
    return true;
  }).catch(error => { status(error.message || "保存失败，请重试", true); return false; });
  return saving;
}
function save(patch) { return update(value => ({ ...value, ...patch })); }
chrome.storage.local.get("settings").then(data => paint(BiliFilterShared.settings(data.settings))).catch(() => status("读取失败，请重新打开插件", true));
for (const name of autosave) $(name).addEventListener("change", () => void save({ [name]: $(name).checked }));
for (const input of document.querySelectorAll('input[name="mode"]')) input.addEventListener("change", () => void save({ mode: input.value }));
$("saveRules").addEventListener("click", () => {
  void save({ blockWords: $("blockWords").value });
});
$("allowForm").addEventListener("submit", async event => {
  event.preventDefault();
  const input = $("allowInput").value.trim();
  const id = BiliFilterShared.videoId(input);
  if (!id) { status("请输入有效 BV 号或 B 站视频链接", true); return; }
  const result = await update(value => {
    if (value.allowVideos.includes(id)) throw new Error("该视频已经放行");
    if (value.allowVideos.length >= BiliFilterShared.MAX_ALLOW_VIDEOS) throw new Error("已达 500 条上限，请先展开列表移除记录");
    value.allowVideos.push(id); return value;
  }, "已添加放行，当前页面即时生效");
  if (result && $("allowInput").value.trim() === input) $("allowInput").value = "";
});
$("allowDetails").addEventListener("toggle", renderAllowedVideos);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) paint(BiliFilterShared.settings(changes.settings.newValue), false);
});
$("clearCache").addEventListener("click", async () => {
  try { const result = await chrome.runtime.sendMessage({ type: "clear-cache" }); status(result?.ok ? "缓存已清理，将重新识别" : "清理失败，请重试", !result?.ok); }
  catch { status("清理失败，请重试", true); }
});
