// app.js — 화면 조립 + 흐름 제어.
//
// 사용자는 HTML 을 보지 않는다. 워드처럼 글 위에서 바로 고친다(contenteditable).
// 화면 문구는 전부 일상어로 쓴다.
//
// 흐름: 키워드 → 글 → (빈칸 채움) → 버튼 → 확인 → 게시하기(복사 + 티스토리 열기)
//
// ⚠ 티스토리 오픈 API 는 2024년 2월에 종료됐다. 자동 게시는 불가능하다.
//    [게시하기] 는 글을 복사해 두고 티스토리 글쓰기 창을 열어 주는 것까지만 한다.

import * as store from "./store.js";
import { mdToHtml, splitTitle, esc, escAttr } from "./markdown.js";
import * as gemini from "./gemini.js";
import * as buttons from "./buttons.js";
import * as checks from "./checks.js";
import * as history from "./history.js";
import { markBlanks, unmarkBlanks } from "./editor.js";

const $ = (id) => document.getElementById(id);

// 상태 표시. className 을 통째로 덮어쓰면 식별용 클래스가 날아가므로 상태 클래스만 교체한다.
const KINDS = ["ok", "warn", "err", "loading"];
function say(el, text, kind) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove(...KINDS);
  if (kind) el.classList.add(kind);
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "처리 중…"; }
  else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
}

let settings = store.load();
let lastImage = null;

// ────────────────────────── 본문 읽고 쓰기 ──────────────────────────
// 화면에는 빈칸이 칠해진 상태로 두고, 밖으로 나갈 때는 칠을 벗긴다.
const bodyEl = () => $("postBody");
const getBody = () => unmarkBlanks(bodyEl().innerHTML);

function setBody(html) {
  bodyEl().innerHTML = markBlanks(html);
  afterBodyChange();
}

function afterBodyChange() {
  renderPlaceholders();
  saveDraft();
  if (!$("preview").classList.contains("hidden")) renderPreview();
}

// ────────────────────────── 위쪽 탭 (글쓰기 / 썸네일) ──────────────────────────
document.querySelectorAll(".mtab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".mtab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.panel;
    $("panel-write").classList.toggle("hidden", which !== "write");
    $("panel-thumb").classList.toggle("hidden", which !== "thumb");
    // 썸네일 탭에서는 게시 버튼이 할 일이 없다.
    $("publishBtn").classList.toggle("hidden", which !== "write");
  })
);

// ────────────────────────── 설정 ──────────────────────────
const SETTING_FIELDS = { sGeminiKey: "geminiKey", sGeminiModel: "geminiModel", sBlogUrl: "blogUrl" };

// 목록은 gemini.js 가 갖고 있다. 모델/분야가 바뀌어도 HTML 을 안 고치도록 여기서 채운다.
$("sGeminiModel").innerHTML = gemini.TEXT_MODELS
  .map((m) => `<option value="${escAttr(m.id)}">${esc(m.label)}</option>`).join("");
$("topic").innerHTML = gemini.TOPIC_TONES
  .map((t) => `<option value="${escAttr(t.id)}">${esc(t.id)}</option>`).join("");
$("thumbStyle").innerHTML = gemini.THUMB_STYLES
  .map((t) => `<option value="${escAttr(t.id)}">${esc(t.id)} 풍</option>`).join("");

function fillSettingsForm() {
  for (const [id, key] of Object.entries(SETTING_FIELDS)) $(id).value = settings[key] || "";
  if (!$("sGeminiModel").value) $("sGeminiModel").value = gemini.TEXT_MODEL_DEFAULT;
}

$("settingsBtn").addEventListener("click", () => { fillSettingsForm(); $("settingsDlg").showModal(); });

// 설정은 고치는 즉시 저장한다. 예전에는 [저장]을 눌러야만 남아서, [닫기]나 Esc 로 닫으면
// 키와 블로그 주소가 날아가 다음에 켤 때 다시 넣어야 했다.
function saveSettingsForm() {
  const patch = {};
  for (const [id, key] of Object.entries(SETTING_FIELDS)) patch[key] = $(id).value.trim();
  try {
    settings = store.save(patch);
    return true;
  } catch (_) {
    // 사생활 보호 모드 등에서 저장소가 막힌 경우. 조용히 넘어가면 "왜 또 물어보지?"가 된다.
    say($("settingsStatus"), "이 브라우저에서는 저장이 막혀 있습니다. 시크릿 창이 아닌 일반 창에서 열어 주세요.", "err");
    return false;
  }
}

for (const id of Object.keys(SETTING_FIELDS)) $(id).addEventListener("input", saveSettingsForm);
$("settingsDlg").addEventListener("close", saveSettingsForm);

$("saveSettings").addEventListener("click", () => {
  if (saveSettingsForm()) say($("topStatus"), "설정을 저장했습니다.", "ok");
});

// 브라우저가 저장 공간이 모자랄 때 이 사이트 데이터를 지우지 않게 부탁해 둔다.
navigator.storage?.persist?.().catch(() => {});

$("testGemini").addEventListener("click", async () => {
  const btn = $("testGemini");
  const apiKey = $("sGeminiKey").value.trim();
  const model = $("sGeminiModel").value;
  if (!apiKey) return say($("settingsStatus"), "키를 붙여넣어 주세요.", "err");
  busy(btn, true, "확인 중…");
  say($("settingsStatus"), "확인 중…", "loading");
  try {
    await gemini.testKey({ apiKey, model });
    // 확인만 하고 [닫기] 를 누르면 키가 날아간다. 성공했으면 바로 저장해 준다.
    settings = store.save({ geminiKey: apiKey, geminiModel: model });
    say($("settingsStatus"), "잘 됩니다! 저장했습니다.", "ok");
  } catch (e) {
    say($("settingsStatus"), "안 됩니다: " + e.message, "err");
  } finally {
    busy(btn, false);
  }
});

// 무료 한도가 진짜로 바닥난 경우에만 결제 얘기를 꺼낸다.
// 분당 한도는 기다리면 풀리므로 결제와 무관하다.
function quotaHelp(e) {
  return gemini.isPlanQuota(e?.rawBody)
    ? "\n\n무료 한도를 다 쓰셨습니다. Google AI Studio 에서 결제를 붙이면 열립니다."
    : "";
}

// ────────────────────────── 1. 글 만들기 ──────────────────────────
// 무료 한도에서는 좋은 AI 가 자주 붐비고(503) 분당 요청 수도 금방 찬다(429).
// gemini.js 가 기다렸다 재시도해도 안 되면 가벼운 AI 로 한 번 더 시도한다.
async function generateWithFallback(args) {
  const chosen = settings.geminiModel || gemini.TEXT_MODEL_DEFAULT;
  const onWait = (sec) => say($("textStatus"), `사용량이 잠깐 찼습니다. ${sec}초 기다렸다 이어서 만듭니다…`, "loading");

  try {
    return { ...(await gemini.generateText({ ...args, model: chosen, onWait })), fellBack: false };
  } catch (e) {
    // 이 AI 가 붐비거나 분당 한도에 걸렸으면 가벼운 AI 로 넘어간다.
    const busyModel = e?.status === 503 || e?.status === 500 || e?.status === 429;
    if (!busyModel || chosen === gemini.TEXT_MODEL_DEFAULT) throw e;

    say($("textStatus"), "고른 AI 가 붐빕니다. 가벼운 AI 로 다시 시도 중…", "loading");
    const r = await gemini.generateText({ ...args, model: gemini.TEXT_MODEL_DEFAULT, onWait });
    return { ...r, fellBack: true };
  }
}

$("genText").addEventListener("click", async () => {
  const btn = $("genText");
  const keyword = $("kw").value.trim();
  if (!keyword) return say($("textStatus"), "무엇에 대해 쓸지 먼저 적어 주세요.", "warn");
  if (!settings.geminiKey) return say($("textStatus"), "먼저 [설정]에서 Gemini 키를 넣어 주세요.", "err");
  if (bodyEl().textContent.trim() &&
      !confirm("지금 쓰고 있는 글을 새로 만든 글로 바꿉니다. 쓰던 글은 [지난 글]에 보관됩니다. 계속할까요?")) return;
  // 새로 만든 글은 따로 보관한다. 쓰던 글을 먼저 넣어 두고 연결을 끊어야
  // 아래 setBody 가 지난 글을 덮어쓰지 않는다.
  archiveNow();
  currentId = null;

  busy(btn, true, "만드는 중…");
  say($("textStatus"), "만드는 중… 30초쯤 걸립니다.", "loading");
  try {
    const { text, truncated, fellBack } = await generateWithFallback({
      apiKey: settings.geminiKey,
      keyword,
      topic: $("topic").value,
      lang: $("lang").value,
      mode: $("blankMode").checked ? "blanks" : "complete",
    });
    const { title, body } = splitTitle(text);
    if (title) $("postTitle").value = title;
    // 모델이 버튼 자리를 빼먹으면 코드로 넣어 준다.
    setBody(buttons.ensureButtonSlots(mdToHtml(body || text)));

    const note = fellBack ? "\n(고른 AI 가 붐벼서 다른 AI 로 만들었습니다)" : "";
    say($("textStatus"), (truncated ? "다 됐습니다 (조금 잘렸을 수 있어요)" : "다 됐습니다") + note,
      truncated || fellBack ? "warn" : "ok");
  } catch (e) {
    say($("textStatus"), e.message + quotaHelp(e), "err");
  } finally {
    busy(btn, false);
  }
});

// ────────────────────────── 2. 링크 버튼 ──────────────────────────
// 글에 남아 있는 버튼 자리마다 입력칸을 만들어 준다. 개수 제한은 없다.
function renderPlaceholders() {
  const body = getBody();
  const found = buttons.findPlaceholders(body);
  const box = $("phList");

  // 지금 글에 버튼이 몇 개 들어가 있는지 항상 보이게 한다.
  const n = buttons.countButtons(body).total;
  $("btnCount").textContent = n ? `${n}개 들어감` : "";

  if (!found.length) {
    box.innerHTML = "";
    return;
  }

  box.innerHTML = `<p class="hint">아직 비어 있는 자리 ${found.length}개 — 여기를 채우면 그 자리에 들어갑니다.</p>` +
    found.map((p, i) => `
    <div class="ph" data-i="${i}">
      <label>빈 자리 ${i + 1}</label>
      <input class="ph-text" type="text" placeholder="버튼 문구" value="${escAttr(p.text)}">
      <input class="ph-url" type="text" placeholder="https://..." value="${escAttr(p.url)}">
      <button type="button" class="ph-apply accent">여기에 넣기</button>
    </div>`).join("");

  box.querySelectorAll(".ph-apply").forEach((b) =>
    b.addEventListener("click", () => applyPlaceholder(Number(b.closest(".ph").dataset.i)))
  );
}

function applyPlaceholder(i) {
  const box = $("phList").querySelectorAll(".ph")[i];
  if (!box) return;
  const text = box.querySelector(".ph-text").value.trim();
  const url = box.querySelector(".ph-url").value.trim();
  if (!text || !url) return say($("btnStatus"), "버튼 문구와 링크 주소를 모두 넣어 주세요.", "warn");

  // 글이 그새 바뀌었을 수 있으므로 그때그때 다시 찾는다.
  const current = getBody();
  const found = buttons.findPlaceholders(current);
  const target = found[i];
  if (!target) return say($("btnStatus"), "버튼 자리를 찾지 못했습니다.", "err");

  let next = buttons.replaceAt(current, target.index, target.raw, buttons.buttonHtml({ text, url }));
  next = buttons.appendNotice(next);
  setBody(next);
  const n = buttons.countButtons(getBody()).total;
  say($("btnStatus"), `${n}번째 버튼을 넣었습니다.`, "ok");
}

$("insertButton").addEventListener("click", () => {
  const text = $("btnText").value.trim();
  const url = $("btnUrl").value.trim();
  if (!text || !url) return say($("btnStatus"), "버튼 문구와 링크 주소를 모두 넣어 주세요.", "warn");

  const node = insertBlockAtCursor(buttons.buttonHtml({ text, url }));
  ensureNoticeNode();
  touchBody();
  node?.scrollIntoView({ block: "center", behavior: "smooth" });

  $("btnText").value = "";
  $("btnUrl").value = "";
  const n = buttons.countButtons(getBody()).total;
  say($("btnStatus"), `${n}번째 버튼을 넣었습니다. 계속 넣으셔도 됩니다.`, "ok");
});

// 빈 버튼 자리를 원하는 위치에 하나 더 만든다. 개수 제한은 없다.
$("addSlot").addEventListener("click", () => {
  const node = insertBlockAtCursor(`<p>${gemini.BUTTON_PLACEHOLDER}</p>`);
  touchBody();
  node?.scrollIntoView({ block: "center", behavior: "smooth" });
  say($("btnStatus"), "버튼 자리를 하나 더 만들었습니다. 위에서 문구와 주소를 채우세요.", "ok");
});

// ────────────────────────── 3. 올리기 전 확인 ──────────────────────────
function renderChecks() {
  const { list, allOk } = checks.runChecks(getBody());
  $("checkList").innerHTML = list.map((c) =>
    `<li class="${c.ok ? "ok" : "warn"}">` +
    `<span class="mark">${c.ok ? "✔" : "✕"}</span> <b>${esc(c.label)}</b> — ${esc(c.detail)}` +
    (c.help ? `<span class="help">${esc(c.help)}</span>` : "") +
    `</li>`
  ).join("");
  say($("topStatus"),
    allOk ? "다 됐습니다. 올리셔도 좋습니다." : "올리기 전에 아래를 먼저 봐 주세요.",
    allOk ? "ok" : "warn");
}

$("runCheck").addEventListener("click", renderChecks);

// ────────────────────────── 게시하기 ──────────────────────────
// 티스토리는 자동 게시가 불가능하다. 글을 복사해 두고 글쓰기 창을 열어 주는 것까지만 한다.
//
// 화면 밖 임시 영역을 선택해서 복사한다. 브라우저가 서식(text/html)과 글자(text/plain)를
// 알아서 둘 다 만들어 주고, 화면의 글을 직접 선택할 때 딸려오는 노란 칠도 섞이지 않는다.
function copyViaSelection(html) {
  const holder = document.createElement("div");
  holder.contentEditable = "true";
  holder.style.cssText = "position:fixed;left:-9999px;top:0;width:600px;";
  holder.innerHTML = html;
  document.body.appendChild(holder);

  const sel = window.getSelection();
  let ok = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(holder);
    sel.removeAllRanges();
    sel.addRange(range);
    ok = document.execCommand("copy");
  } catch (_) { /* 아래에서 최신 방식으로 한 번 더 */ }

  sel.removeAllRanges();
  holder.remove();
  return ok;
}

async function copyRich(html, plain) {
  if (copyViaSelection(html)) return true;
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      })]);
      return true;
    }
  } catch (_) { /* 실패로 처리한다 */ }
  return false;
}

function tistoryWriteUrl() {
  const raw = String(settings.blogUrl || "").trim();
  if (!raw) return "";
  const host = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://${host}/manage/newpost/`;
}

// 확장 프로그램이 깔려 있으면 bridge.js 가 이 표시를 남긴다.
const hasExtension = () => !!document.documentElement.dataset.gapExtension;

// 확장에 글을 넘긴다. 확장이 티스토리 글쓰기 창을 열고 제목·본문을 채운다.
function sendToExtension(title, html) {
  return new Promise((resolve) => {
    const onResult = (e) => {
      if (e.source !== window || e.data?.tag !== "gap-tistory" || e.data?.type !== "PUBLISH_RESULT") return;
      window.removeEventListener("message", onResult);
      resolve(e.data);
    };
    window.addEventListener("message", onResult);
    window.postMessage({ tag: "gap-tistory", type: "PUBLISH", title, html, blogUrl: settings.blogUrl || "" }, "*");
    // 확장이 응답을 안 주면 5초 뒤 실패로 본다.
    setTimeout(() => { window.removeEventListener("message", onResult); resolve(null); }, 5000);
  });
}

$("publishBtn").addEventListener("click", async () => {
  const html = getBody().trim();
  if (!html) return say($("topStatus"), "아직 글이 없습니다.", "warn");
  const title = $("postTitle").value.trim();

  // 확장이 있으면 티스토리 화면까지 자동으로 채워 준다.
  if (hasExtension()) {
    if (!settings.blogUrl) return say($("topStatus"), "[설정]에 블로그 주소를 먼저 넣어 주세요.", "err");
    say($("topStatus"), "티스토리 글쓰기 창을 열고 글을 채우는 중…", "loading");
    // 확장이 편집기를 못 찾을 때를 대비해 클립보드에도 넣어 둔다.
    await copyRich(html, bodyEl().innerText);
    const r = await sendToExtension(title, html);
    if (r?.ok) {
      return say($("topStatus"), "티스토리 창에 글을 채웠습니다. 내용을 확인하고 발행하세요.", "ok");
    }
    say($("topStatus"), `확장 프로그램이 응답하지 않습니다${r?.error ? ` (${r.error})` : ""}. 복사해서 직접 붙여넣어 주세요.`, "warn");
  }

  const copied = await copyRich(html, bodyEl().innerText);
  const url = tistoryWriteUrl();

  if (url) window.open(url, "_blank", "noopener");

  const where = url ? "열린 티스토리 글쓰기 창에" : "티스토리 글쓰기에서";
  if (copied) {
    say($("topStatus"),
      `글을 복사했습니다. ${where} 붙여넣기(Ctrl+V) 하시고 제목을 넣어 발행하세요.` +
      (url ? "" : "\n(설정에 블로그 주소를 넣으면 글쓰기 창까지 열어 드립니다)"),
      "ok");
  } else {
    // 복사가 막히면 사용자가 직접 복사할 수 있게 글을 선택해 준다.
    bodyEl().focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(bodyEl());
    sel.removeAllRanges();
    sel.addRange(range);
    say($("topStatus"), "자동 복사가 막혔습니다. 글이 선택돼 있으니 Ctrl+C 를 눌러 주세요.", "warn");
  }
});

// ────────────────────────── 썸네일 ──────────────────────────
$("genImage").addEventListener("click", async () => {
  const btn = $("genImage");
  // 비어 있으면 글쓰기 탭 키워드를 가져다 쓴다.
  const keyword = $("thumbKw").value.trim() || $("kw").value.trim();
  if (!keyword) return say($("imgStatus"), "어떤 그림을 만들지 적어 주세요.", "warn");
  if (!settings.geminiKey) return say($("imgStatus"), "먼저 [설정]에서 Gemini 키를 넣어 주세요.", "err");
  $("thumbKw").value = keyword;

  busy(btn, true, "만드는 중…");
  say($("imgStatus"), "그림을 만드는 중… 1분쯤 걸릴 수 있습니다.", "loading");
  $("thumbPreview").innerHTML = "";
  $("saveImage").classList.add("hidden");
  try {
    lastImage = await gemini.generateImage({
      apiKey: settings.geminiKey, keyword, style: $("thumbStyle").value,
      onWait: (sec) => say($("imgStatus"), `사용량이 잠깐 찼습니다. ${sec}초 기다렸다 이어서 만듭니다…`, "loading"),
    });
    const img = document.createElement("img");
    img.src = lastImage.dataUrl;
    img.alt = keyword;
    $("thumbPreview").appendChild(img);
    $("saveImage").classList.remove("hidden");
    say($("imgStatus"), "다 됐습니다. 내려받아 티스토리에 올리세요.", "ok");
  } catch (e) {
    $("thumbPreview").innerHTML = `<p class="hint">그림을 만들지 못했습니다.</p>`;
    say($("imgStatus"), e.message + quotaHelp(e), "err");
  } finally {
    busy(btn, false);
  }
});

$("saveImage").addEventListener("click", () => {
  if (!lastImage) return;
  const name = ($("thumbKw").value.trim() || "thumbnail").replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
  const a = document.createElement("a");
  a.href = lastImage.dataUrl;
  a.download = name + "." + (lastImage.mime.split("/")[1] || "png").replace("jpeg", "jpg");
  a.click();
  say($("imgStatus"), "내려받았습니다.", "ok");
});

// ────────────────────────── 글 편집 ──────────────────────────
// 글 안에서 마지막으로 커서가 있던 문단을 기억해 둔다.
// 버튼 문구 칸을 클릭하는 순간 글의 커서가 풀리기 때문에, 기억해 두지 않으면
// 넣을 위치를 잃고 전부 글 끝에 쌓인다.
let lastBlock = null;

function currentBlock() {
  const el = bodyEl();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let n = sel.getRangeAt(0).startContainer;
  if (!el.contains(n)) return null;
  // 편집기의 바로 아래 자식(= 문단 단위)까지 거슬러 올라간다.
  while (n && n.parentNode !== el) n = n.parentNode;
  return n && n !== el ? n : null;
}

function rememberBlock() {
  const b = currentBlock();
  if (b) lastBlock = b;
}
["keyup", "mouseup", "input"].forEach((ev) => bodyEl().addEventListener(ev, rememberBlock));

// 버튼처럼 덩어리로 된 것은 문단 "사이"에 넣는다.
// 문단 안에 끼워 넣으면 <p> 안에 <div> 가 들어가 문단이 쪼개진다.
function insertBlockAtCursor(html) {
  const el = bodyEl();
  const frag = document.createRange().createContextualFragment(html);
  const nodes = [...frag.childNodes];

  const at = currentBlock() || (el.contains(lastBlock) ? lastBlock : null);
  if (at) at.after(frag);
  else el.appendChild(frag);

  // 다음 버튼은 이 버튼 뒤에 오도록 위치를 옮겨 둔다. 연속으로 넣기 편하다.
  lastBlock = nodes[nodes.length - 1] || lastBlock;
  return nodes[0] || null;
}

// 화면을 통째로 다시 그리지 않고 필요한 것만 갱신한다.
// 통째로 다시 그리면 커서와 기억해 둔 위치가 날아가 연속 삽입이 안 된다.
function touchBody() {
  bodyEl().querySelectorAll("mark.blank").forEach((m) => {
    const t = m.textContent.trim();
    if (!gemini.BLANKS.includes(t) && !/^\[버튼\s*:[^\]]*\]$/.test(t)) m.replaceWith(...m.childNodes);
  });
  afterBodyChange();
}

// 제휴 고지를 글 끝에 붙인다. 이미 있으면 그대로 둔다(다시 그리지 않는다).
function ensureNoticeNode() {
  if (buttons.hasNotice(bodyEl().innerHTML)) return;
  bodyEl().appendChild(document.createRange().createContextualFragment(buttons.noticeHtml()));
}

// 노란 빈칸을 클릭하면 그 자리를 통째로 선택해 준다. 바로 타이핑하면 덮어써진다.
bodyEl().addEventListener("click", (e) => {
  const mark = e.target.closest?.("mark.blank");
  if (!mark) return;
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(mark);
  sel.removeAllRanges();
  sel.addRange(range);
});

// 빈칸에 글자를 넣기 시작하면 노란 칠을 벗겨 준다(다 채운 티가 나야 한다).
bodyEl().addEventListener("input", () => {
  bodyEl().querySelectorAll("mark.blank").forEach((m) => {
    const t = m.textContent.trim();
    const stillBlank = gemini.BLANKS.includes(t) || /^\[버튼\s*:[^\]]*\]$/.test(t);
    if (!stillBlank) m.replaceWith(...m.childNodes);
  });
  afterBodyChange();
});

// 붙여넣기는 서식을 버리고 글자만 받는다. 남의 사이트 스타일이 딸려오면 티스토리에서 깨진다.
bodyEl().addEventListener("paste", (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  document.execCommand("insertText", false, text);
});

$("toolbar").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cmd]");
  if (!btn) return;
  bodyEl().focus();
  const cmd = btn.dataset.cmd;
  if (cmd === "heading") document.execCommand("formatBlock", false, "h3");
  else document.execCommand(cmd, false, null);
  afterBodyChange();
});

// ── 글 쓰기 / 미리보기 ──
let previewTimer = null;
function renderPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const title = $("postTitle").value.trim();
    // 미리보기는 실제 발행 모습이어야 하므로 노란 칠을 벗긴 상태로 보여준다.
    // <base target="_blank"> — 링크를 눌렀을 때 미리보기 자체가 딴 페이지로 바뀌지 않고
    // 새 탭에서 열린다. 버튼이 진짜로 동작하는지 여기서 확인할 수 있어야 한다.
    $("preview").srcdoc =
      `<!doctype html><meta charset="utf-8"><base target="_blank">` +
      `<style>body{font:16px/1.85 -apple-system,"Malgun Gothic",sans-serif;padding:24px;max-width:720px;` +
      `margin:0 auto;color:#1a202c}img{max-width:100%}h1{font-size:26px}h2{font-size:22px;margin-top:1.6em}` +
      `h3{font-size:19px;margin-top:1.6em}p{margin:0 0 1em}` +
      `pre{background:#f1f5f9;padding:12px;border-radius:8px;overflow:auto}</style>` +
      (title ? `<h1>${esc(title)}</h1>` : "") +
      getBody();
  }, 150);
}

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const showPreview = tab.dataset.view === "preview";
    bodyEl().classList.toggle("hidden", showPreview);
    $("toolbar").classList.toggle("hidden", showPreview);
    $("preview").classList.toggle("hidden", !showPreview);
    if (showPreview) renderPreview();
  })
);

// ── 쓰던 글 자동 보관 ──
const DRAFT_KEY = "gap.draft.v1";
let draftTimer = null;

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const title = $("postTitle").value, body = bodyEl().innerHTML;
    // 빈 상태는 저장하지 않는다. 저장하면 앱을 새 탭에서 열자마자
    // 다른 탭에서 쓰던 글이 빈 값으로 덮여 사라진다. 비우는 것은 [새로 쓰기] 로만.
    if (!title && !bodyEl().textContent.trim()) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ title, body, at: Date.now(), id: currentId }));
    } catch (_) {}
    // 쓰던 글은 보관함에도 같이 넣어 둔다. currentId 가 있으므로 같은 항목이 갱신된다.
    archiveNow();
  }, 500);
}

// ── 지난 글 보관함 ──
// 글은 "지금 쓰는 글" 하나와 "보관된 지난 글" 여러 개로 나뉜다.
// currentId 가 지금 쓰는 글이 보관함에서 어느 항목인지 가리킨다.
// 이게 없으면 자동 저장이 돌 때마다 같은 글이 새 항목으로 쌓인다.
let currentId = null;
let histList = [];

function archiveNow() {
  // 본문은 칠(mark)을 벗겨서 보관한다. 안 벗기면 형광펜이 그어진 채로 되살아난다.
  const title = $("postTitle").value;
  const body = getBody();
  if (!history.worthSaving({ title, body })) return;
  const { list, entry } = history.saveEntry({ id: currentId, title, body });
  if (entry) {
    currentId = entry.id;
    histList = list;
    renderHistory();
  }
}

function renderHistory() {
  const ul = $("histList");
  const n = histList.length;
  $("histCount").textContent = n ? `${n}개` : "";
  $("histClear").classList.toggle("hidden", n === 0);

  if (!n) {
    ul.innerHTML = `<li><span class="empty">아직 보관된 글이 없습니다.</span></li>`;
    return;
  }

  const now = Date.now();
  ul.innerHTML = histList
    .map((e) => {
      const when = history.formatWhen(e.at, now);
      const mine = e.id === currentId ? " current" : "";
      const tag = e.id === currentId ? " · 지금 쓰는 글" : "";
      return `<li class="hist-item${mine}" data-id="${escAttr(e.id)}">
        <button type="button" class="pick" title="이 글을 불러옵니다">
          <span class="t">${esc(e.label)}</span>
          ${e.snippet ? `<span class="s">${esc(e.snippet)}</span>` : ""}
          <span class="m">${esc(when)} · ${e.chars.toLocaleString()}자${tag}</span>
        </button>
        <button type="button" class="del" title="이 글을 보관함에서 지웁니다">✕</button>
      </li>`;
    })
    .join("");
}

function loadFromHistory(id) {
  const e = history.find(histList, id);
  if (!e) return;
  if (e.id === currentId) return say($("topStatus"), "지금 보고 있는 글입니다.", "warn");

  // 지금 쓰던 글을 먼저 보관한다. 안 그러면 불러오는 순간 사라진다.
  archiveNow();

  currentId = e.id;
  $("postTitle").value = e.title || "";
  setBody(e.body || "");
  $("checkList").innerHTML = "";
  renderHistory();
  say($("topStatus"), `"${e.label}" 을 불러왔습니다.`, "ok");
}

$("histList").addEventListener("click", (ev) => {
  const li = ev.target.closest(".hist-item");
  if (!li) return;
  const id = li.dataset.id;

  if (ev.target.closest(".del")) {
    const e = history.find(histList, id);
    if (e && !confirm(`"${e.label}" 을 보관함에서 지웁니다. 계속할까요?`)) return;
    histList = history.removeEntry(id);
    // 지금 쓰는 글을 지웠으면 화면의 글은 그대로 두고 연결만 끊는다.
    // 글이 눈앞에서 사라지면 사용자는 쓰던 내용을 잃었다고 생각한다.
    if (id === currentId) currentId = null;
    renderHistory();
    say($("topStatus"), "보관함에서 지웠습니다.", "ok");
    return;
  }

  if (ev.target.closest(".pick")) loadFromHistory(id);
});

$("histClear").addEventListener("click", () => {
  if (!confirm(`보관된 글 ${histList.length}개를 모두 지웁니다. 되돌릴 수 없습니다. 계속할까요?`)) return;
  history.clearAll();
  histList = [];
  currentId = null;
  renderHistory();
  say($("topStatus"), "보관함을 비웠습니다. 화면의 글은 그대로 있습니다.", "ok");
});

function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (!d || (!d.title && !d.body)) return;
    // 보관함의 어느 항목이었는지 이어받는다. 없으면(예전 버전 초안) 다음 저장 때 새로 붙는다.
    if (d.id && history.find(histList, d.id)) currentId = d.id;
    $("postTitle").value = d.title || "";
    bodyEl().innerHTML = markBlanks(unmarkBlanks(d.body || ""));
    renderPlaceholders();
    const when = d.at ? new Date(d.at).toLocaleString() : "";
    say($("topStatus"), `쓰시던 글을 되살렸습니다${when ? ` (${when})` : ""}.`, "ok");
  } catch (_) {}
}

$("newPost").addEventListener("click", () => {
  if (($("postTitle").value || bodyEl().textContent.trim()) &&
      !confirm("지금 글을 비우고 새로 시작합니다. 쓰던 글은 [지난 글]에 보관됩니다. 계속할까요?")) return;
  // 비우기 전에 보관한다. 예전에는 그냥 사라졌다.
  archiveNow();
  currentId = null;
  $("postTitle").value = "";
  bodyEl().innerHTML = "";
  try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  afterBodyChange();
  $("checkList").innerHTML = "";
  renderHistory();
  say($("topStatus"), "새로 시작합니다. 쓰던 글은 [지난 글]에 있습니다.", "ok");
});

$("postTitle").addEventListener("input", () => {
  saveDraft();
  if (!$("preview").classList.contains("hidden")) renderPreview();
});

// ────────────────────────── 시작 ──────────────────────────
fillSettingsForm();
// 보관함을 먼저 읽는다. restoreDraft 가 "쓰던 글이 보관함의 어느 항목인지" 를 여기서 찾는다.
histList = history.load();
restoreDraft();
renderHistory();
renderPlaceholders();
