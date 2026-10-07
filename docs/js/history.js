// history.js — 만든 글 보관함.
//
// 지금까지는 쓰던 글 하나만 남아서([새로 쓰기] 를 누르면 사라졌다) 지난 글을 되찾을 수 없었다.
// 여기서는 글을 목록으로 쌓아 두고 다시 불러올 수 있게 한다.
//
// 설계상 지킨 것:
// - 저장소를 인자로 받는다. localStorage 가 없는 곳(selftest)에서도 돌려 볼 수 있게 하려는 것이다.
// - 순수 로직(목록 다루기)과 저장(읽기/쓰기)을 나눈다. 순수 쪽만 selftest 가 검사한다.
// - 빈 글은 보관하지 않는다. 자동 저장이 빈 값으로 덮어쓰지 않는 것과 같은 이유다.
// - 같은 글을 고쳐서 다시 보관하면 새 항목을 만들지 않고 그 자리를 갱신한다(id 로 가린다).
//   안 그러면 자동 보관 때마다 똑같은 글이 수십 개 쌓인다.

export const HISTORY_KEY = "gap.history.v1";

// 브라우저 저장소는 보통 5MB 쯤이다. 글 하나가 수 KB 이니 넉넉하지만,
// 무한정 쌓이면 어느 순간 저장이 막혀 조용히 실패한다. 오래된 것부터 버린다.
export const MAX_ITEMS = 50;

// ────────────────────────── 순수 로직 ──────────────────────────

// 제목이 비어 있으면 본문 글자에서 앞부분을 끌어다 쓴다.
// 목록에 "(제목 없음)" 만 줄줄이 있으면 어느 글인지 구분할 수 없다.
export function makeLabel(title, bodyText) {
  const t = String(title || "").trim();
  if (t) return t;
  const b = String(bodyText || "").replace(/\s+/g, " ").trim();
  if (!b) return "(제목 없음)";
  return b.length > 40 ? b.slice(0, 40) + "…" : b;
}

// 본문 HTML 에서 사람이 읽을 글자만 꺼낸다. 목록의 미리보기 한 줄과 글자 수에 쓴다.
// DOM 없이 돌아야 한다(selftest 는 순수 함수만 검사한다).
export function plainText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function makeSnippet(bodyText, max = 90) {
  const s = String(bodyText || "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// 한 항목을 만든다. id 가 없으면 새로 붙인다.
export function makeEntry({ id, title, body, at }) {
  const text = plainText(body);
  return {
    id: id || newId(),
    title: String(title || ""),
    body: String(body || ""),
    label: makeLabel(title, text),
    snippet: makeSnippet(text),
    chars: text.replace(/\s/g, "").length,
    at: at || Date.now(),
  };
}

export function newId() {
  // crypto.randomUUID 는 오래된 브라우저에 없다. 없으면 시간+난수로 만든다.
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (_) {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 목록에 넣는다. 같은 id 가 있으면 갈아끼우고 맨 앞으로 올린다.
// 새 항목도 맨 앞이다 — 최근에 쓴 글을 먼저 보여 주려는 것이다.
export function upsert(list, entry) {
  const rest = (list || []).filter((e) => e && e.id !== entry.id);
  return [entry, ...rest].slice(0, MAX_ITEMS);
}

export function remove(list, id) {
  return (list || []).filter((e) => e && e.id !== id);
}

export function find(list, id) {
  return (list || []).find((e) => e && e.id === id) || null;
}

// 저장소에서 읽은 것이 목록 모양인지 확인한다.
// 사람이 손으로 고쳤거나 예전 버전이 남아 있을 수 있다. 깨진 항목은 버린다.
export function sanitize(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === "object" && typeof e.id === "string")
    .map((e) => ({
      id: e.id,
      title: String(e.title || ""),
      body: String(e.body || ""),
      label: String(e.label || makeLabel(e.title, plainText(e.body))),
      snippet: String(e.snippet || ""),
      chars: Number.isFinite(e.chars) ? e.chars : plainText(e.body).replace(/\s/g, "").length,
      at: Number.isFinite(e.at) ? e.at : 0,
    }))
    .slice(0, MAX_ITEMS);
}

// 보관할 만한 글인가. 제목도 본문도 없으면 넣지 않는다.
export function worthSaving({ title, body }) {
  return Boolean(String(title || "").trim() || plainText(body));
}

// 목록에 보여 줄 시각. 오늘 쓴 글은 시각만, 그 전은 날짜까지.
export function formatWhen(at, now = Date.now()) {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

// ────────────────────────── 저장소 ──────────────────────────
// storage 를 받는 이유: selftest 에서 가짜 저장소를 넣어 검사하려는 것이다.

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    // 사생활 보호 모드에서는 접근 자체가 던질 수 있다.
    return null;
  }
}

export function load(storage = defaultStorage()) {
  if (!storage) return [];
  try {
    return sanitize(JSON.parse(storage.getItem(HISTORY_KEY) || "[]"));
  } catch (_) {
    return [];
  }
}

// 저장에 실패해도 앱은 계속 돌아야 한다. 저장 공간이 찼으면 절반을 버리고 한 번 더 해 본다.
export function persist(list, storage = defaultStorage()) {
  if (!storage) return false;
  const tries = [list, list.slice(0, Math.ceil(list.length / 2)), list.slice(0, 5)];
  for (const candidate of tries) {
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(candidate));
      return true;
    } catch (_) {}
  }
  return false;
}

// 글 하나를 보관한다. 돌려주는 것은 갱신된 목록과 그 항목이다.
export function saveEntry({ id, title, body, at }, storage = defaultStorage()) {
  if (!worthSaving({ title, body })) return { list: load(storage), entry: null };
  const entry = makeEntry({ id, title, body, at });
  const list = upsert(load(storage), entry);
  persist(list, storage);
  return { list, entry };
}

export function removeEntry(id, storage = defaultStorage()) {
  const list = remove(load(storage), id);
  persist(list, storage);
  return list;
}

export function clearAll(storage = defaultStorage()) {
  if (!storage) return;
  try { storage.removeItem(HISTORY_KEY); } catch (_) {}
}
