// tistory.js — 티스토리 글쓰기 화면에 글을 채워 넣는다.
//
// ⚠ 남의 화면을 조작하는 코드다. 티스토리가 편집기를 바꾸면 깨진다.
// 그래서 선택자를 하나로 못 박지 않고 여러 방법으로 찾는다. 못 찾으면 조용히 실패하지 말고
// 화면에 무엇을 못 찾았는지 띄운다 — 그래야 고칠 수 있다.
//
// ── 티스토리 편집기 구조 (조사로 확인, 2026-10) ────────────────────────
// 에디터 스택: KEditor + TinyMCE + CodeMirror 5. 작성 모드가 3개다.
//   기본(카카오)  iframe#editor-tistory_ifr 안의 contenteditable  ← 1순위로 쓴다
//   마크다운      .cm-s-tistory-markdown (CodeMirror)
//   HTML          .cm-s-tistory-html (CodeMirror)
// 숨은 textarea#editor-tistory 가 있고, **티스토리가 서버로 보내는 값은 이것**이다.
//
// ⚠ 조용히 실패하는 함정 — 조사에서 실측으로 확인된 것들
// 1. TinyMCE setContent() 만 하면 textarea#editor-tistory 가 비어 있어 **빈 글이 발행된다.**
//    반드시 save()(또는 triggerSave()) 로 textarea 에 동기화하고, 길이로 검증해야 한다.
// 2. CodeMirror setValue() 는 React state 에 반영되지 않아 역시 빈 글이 나간다.
//    그래서 CodeMirror(마크다운/HTML 모드) 경로는 **쓰지 않는다.** 기본모드로 유도한다.
// 3. 마크다운/HTML CodeMirror 는 둘 다 미리 마운트되어 display 로만 토글된다.
//    .CodeMirror 를 그냥 잡으면 안 보이는 쪽을 잡는다 — display:none 을 걸러야 한다.
// 4. 진입 시 confirm 이 뜬다("저장된 글이 있습니다. 이어서 작성하시겠습니까?").
//    처리하지 않으면 무한 대기한다. content script 는 confirm 을 직접 못 막으므로
//    (페이지 컨텍스트가 다르다) 사람에게 안내한다.
//
// 출처: tistory-mcp, blog-automation, helena_phone 등 복수 구현의 실측 보고.
// 로그인 화면에서 직접 확인한 것은 아니므로, 실제로 돌려 보고 다듬을 것.

(() => {
  const BOX_ID = "gap-panel";

  // ── 화면 알림 ──────────────────────────────────────────
  function panel(html, kind = "info") {
    let el = document.getElementById(BOX_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = BOX_ID;
      el.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;" +
        "font:13px/1.6 -apple-system,'Malgun Gothic',sans-serif;padding:14px 16px;border-radius:10px;" +
        "box-shadow:0 8px 30px rgba(0,0,0,.25);background:#fff;color:#1a202c;border:1px solid #e2e8f0";
      document.body.appendChild(el);
    }
    el.style.borderColor = kind === "err" ? "#e53e3e" : kind === "ok" ? "#38a169" : "#e2e8f0";
    el.innerHTML = html;
    return el;
  }

  const visible = (n) => {
    if (!n) return false;
    const r = n.getBoundingClientRect();
    if (!(r.width > 80 && r.height > 20)) return false;
    // 숨겨 둔 편집기를 고르지 않도록 display 까지 본다(함정 3).
    const cs = (n.ownerDocument.defaultView || window).getComputedStyle(n);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };

  // ── 제목 칸 찾기 ───────────────────────────────────────
  // 티스토리 제목은 textarea#post-title-inp (class="textarea_tit") 다. input 이 아니다.
  // 그래서 태그를 가리지 않는 선택자를 쓴다.
  function findTitle(doc) {
    const byId = doc.querySelector(
      "#post-title-inp, textarea.textarea_tit, [name='title'], #title");
    if (byId) return byId;

    const inputs = [...doc.querySelectorAll("input[type='text'], input:not([type]), textarea")].filter(visible);
    const hinted = inputs.find((i) =>
      /제목|title/i.test(`${i.placeholder || ""} ${i.getAttribute("aria-label") || ""} ${i.name || ""}`));
    if (hinted) return hinted;

    return inputs.find((i) => i.getBoundingClientRect().top < 400) || null;
  }

  // ── 지금 어느 작성 모드인가 ─────────────────────────────
  // CodeMirror 가 보이면 마크다운/HTML 모드다. 그 모드에서는 넣어도 저장이 안 된다(함정 2).
  function currentMode() {
    const shown = (sel) => [...document.querySelectorAll(sel)].some(visible);
    if (shown(".cm-s-tistory-html")) return "html";
    if (shown(".cm-s-tistory-markdown")) return "markdown";
    return "kakao"; // 기본모드
  }

  // ── 페이지 쪽(main world)에 부탁하기 ───────────────────
  // content script 는 격리된 세계에서 돌아 페이지의 window.tinymce 에 닿지 못한다.
  // tistory-main.js 가 페이지와 같은 세계에서 돌고 있으므로 이벤트로 부탁한다.
  // (<script> 주입은 티스토리 CSP 가 막을 수 있어 쓰지 않는다.)
  const REQ = "gap-main-req";
  const RES = "gap-main-res";

  function ask(action, args = {}) {
    return new Promise((resolve) => {
      const id = "r" + Math.random().toString(36).slice(2);
      const onDone = (e) => {
        if (e.detail?.id !== id) return;
        window.removeEventListener(RES, onDone);
        resolve(e.detail.result);
      };
      window.addEventListener(RES, onDone);
      window.dispatchEvent(new CustomEvent(REQ, { detail: { id, action, args } }));
      setTimeout(() => {
        window.removeEventListener(RES, onDone);
        resolve({ error: "페이지 쪽 스크립트가 응답하지 않습니다" });
      }, 3000);
    });
  }

  const mainReady = () => document.documentElement.dataset.gapMainReady === "1";

  // 기본모드 TinyMCE 에 본문을 넣는다. 넣은 뒤 **제출될 값(숨은 textarea)** 까지
  // 확인해서 돌려준다 — 0 이면 빈 글이 발행되므로 실패로 본다(함정 1).
  function fillViaTinyMCE(html) {
    return ask("setBody", { html });
  }

  // ── 본문 편집 영역 찾기 (TinyMCE 가 없을 때의 대비책) ──
  function findBody() {
    const pick = (doc) =>
      [...doc.querySelectorAll("[contenteditable='true'], [contenteditable=''], [role='textbox']")]
        .filter(visible)
        .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0] || null;

    // 기본모드 본문은 iframe#editor-tistory_ifr 안에 있다. 그쪽을 먼저 본다.
    const named = document.querySelector("iframe#editor-tistory_ifr");
    for (const f of [named, ...document.querySelectorAll("iframe")].filter(Boolean)) {
      let d;
      try { d = f.contentDocument; } catch (_) { continue; } // 다른 출처면 못 본다
      if (!d) continue;
      const inner = pick(d);
      if (inner) return { el: inner, doc: d, where: "본문(iframe)" };
      if (d.body && d.body.isContentEditable) return { el: d.body, doc: d, where: "본문(iframe body)" };
    }

    const direct = pick(document);
    if (direct) return { el: direct, doc: document, where: "본문(직접)" };
    return null;
  }

  // ── 채우기 ─────────────────────────────────────────────
  function setTitle(el, text) {
    if (!el) return false;
    // 제목은 textarea 다. React controlled 이므로 네이티브 setter 로 박고 이벤트를 알린다.
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    el.focus();
    if (setter) setter.call(el, text); else el.value = text;
    for (const t of ["input", "change", "keyup", "blur"]) {
      el.dispatchEvent(new Event(t, { bubbles: true }));
    }
    return String(el.value || "") === String(text);
  }

  function setBodyDirect(target, html) {
    const { el, doc } = target;
    el.focus();
    try {
      const sel = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (doc.execCommand("insertHTML", false, html)) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return "insertHTML";
      }
    } catch (_) { /* 아래로 */ }

    el.innerHTML = html;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "innerHTML";
  }

  // ── 발행 버튼 찾기 ─────────────────────────────────────
  // #publish-layer-btn("완료")로 발행 레이어를 열고, 그 안의 #publish-btn 이 최종 발행이다.
  // 여기서는 레이어만 연다 — 마지막 클릭은 사람이 한다(14장).
  function findPublishLayer() {
    const byId = document.querySelector("#publish-layer-btn");
    if (byId && visible(byId)) return byId;
    return [...document.querySelectorAll("button, a, [role='button']")]
      .filter(visible)
      .find((b) => /^\s*(완료|발행|등록)\s*$/.test(b.textContent || "")) || null;
  }

  // ── 흐름 ───────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: "TAKE_PENDING" }, async (res) => {
    const post = res?.post;
    if (!post) return; // 사용자가 그냥 글쓰기 화면에 들어온 경우

    // 편집기가 늦게 뜬다. load 이벤트는 안 뜨는 화면이므로 폴링으로 기다린다(함정 4 참고).
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const titleEl = findTitle(document);
      const hasEditor = document.querySelector("#editor-tistory, iframe#editor-tistory_ifr, .CodeMirror");
      const body = findBody();

      // 최대 20초 기다린다. 제목칸과 편집기 둘 중 하나라도 보이면 진행한다.
      // TinyMCE 는 늦게 준비되므로, 편집기가 보여도 페이지 쪽 스크립트가 아직이면 좀 더 기다린다.
      if (!hasEditor && !body && tries < 40) return;
      if (!mainReady() && tries < 40) return;
      clearInterval(timer);

      const mode = currentMode();

      // 1순위: 기본모드 TinyMCE. 저장까지 확인된 유일한 경로다.
      // (마크다운/HTML 모드의 CodeMirror 는 넣어도 React state 에 반영되지 않아 빈 글이 나간다.)
      let filled = null;
      if (mode === "kakao" && mainReady()) filled = await fillViaTinyMCE(post.html || "");

      const okTitle = setTitle(titleEl, post.title || "");

      // TinyMCE 로 넣고 검증까지 통과했으면 끝.
      if (filled?.ok) {
        done(okTitle, `기본모드 · 저장될 본문 ${Number(filled.submitted).toLocaleString()}자 확인`);
        return;
      }

      // 마크다운/HTML 모드면 넣어도 저장이 안 된다. 모드를 바꾸라고 안내한다.
      if (mode !== "kakao") {
        keep();
        panel(
          `<b>지금은 ${mode === "html" ? "HTML" : "마크다운"} 모드입니다.</b><br>` +
          `이 모드에서는 자동으로 넣은 글이 <b>저장되지 않습니다</b>(빈 글로 발행됨).<br>` +
          `오른쪽 위 <b>⋯ → 기본모드</b>로 바꾼 뒤 이 화면을 새로고침(F5)해 주세요.<br>` +
          `<div style="margin-top:8px;color:#718096;font-size:11px">` +
          `모드를 바꿀 때 "서식이 유지되지 않을 수 있습니다" 확인창이 뜨면 확인을 누르세요.<br>` +
          `급하면 글이 클립보드에 있으니 ${mode === "html" ? "여기에 그대로" : "기본모드에서"} <b>Ctrl+V</b> 하셔도 됩니다.</div>`,
          "err");
        return;
      }

      // TinyMCE 가 없거나 검증에 실패했을 때의 대비책: 편집 영역에 직접 넣는다.
      if (body) {
        const how = setBodyDirect(body, post.html || "");
        // 직접 넣은 경우도 숨은 textarea 동기화를 한 번 시도한다. 안 되면 사용자에게 알린다.
        const sync = await ask("sync");
        const len = Number(sync?.submitted);
        if (len > 0) {
          done(okTitle, `${body.where} · ${how} · 저장될 본문 ${len.toLocaleString()}자 확인`);
        } else {
          panel(
            `<b>글을 넣었지만 저장될지 확인하지 못했습니다.</b><br>` +
            `${body.where} · ${how}${filled?.reason ? ` (TinyMCE: ${filled.reason})` : ""}<br>` +
            `<b>발행 전에 본문이 보이는지 꼭 확인하세요.</b> 비어 있으면 ` +
            `클립보드의 글을 <b>Ctrl+V</b> 로 붙여넣어 주세요.`, "err");
        }
        return;
      }

      // 아무것도 못 찾았다. 글을 돌려놓고 알린다.
      keep();
      panel(
        `<b>본문 칸을 찾지 못했습니다.</b><br>티스토리 편집기가 바뀐 것 같습니다.` +
        `${filled?.reason ? `<br>(${filled.reason})` : ""}<br>` +
        `글은 클립보드에 복사돼 있으니 <b>Ctrl+V</b> 로 붙여넣어 주세요.<br>` +
        `<div style="margin-top:8px;color:#718096;font-size:11px">` +
        `"저장된 글이 있습니다" 확인창이 떠 있으면 먼저 처리한 뒤 새로고침(F5)해 보세요.</div>`, "err");
    }, 500);

    // 실패했을 때 글을 되돌려 둔다. 새로고침하면 다시 시도할 수 있게 하려는 것이다.
    function keep() {
      try { chrome.runtime.sendMessage({ type: "KEEP_PENDING", post }); } catch (_) {}
    }

    function done(okTitle, detail) {
      panel(
        `<b>글을 채웠습니다.</b><br>` +
        `제목 ${okTitle ? "○" : "✕ (직접 입력해 주세요)"} · ${detail}<br>` +
        `<div style="margin-top:10px"><button id="gap-pub" style="padding:7px 14px;border:0;border-radius:7px;` +
        `background:#2563eb;color:#fff;font-weight:700;cursor:pointer">발행 창 열기</button> ` +
        `<button id="gap-close" style="padding:7px 12px;border:1px solid #cbd5e0;border-radius:7px;` +
        `background:#fff;cursor:pointer">닫기</button></div>` +
        `<div style="margin-top:8px;color:#718096;font-size:11px">내용을 확인한 뒤 눌러 주세요. ` +
        `공개 설정은 기본이 <b>비공개</b>입니다. 대표 이미지도 여기서 올리셔야 합니다.</div>`, "ok");

      document.getElementById("gap-close").onclick = () => document.getElementById(BOX_ID)?.remove();
      document.getElementById("gap-pub").onclick = () => {
        const btn = findPublishLayer();
        if (!btn) {
          panel(`<b>발행 버튼을 찾지 못했습니다.</b><br>화면 오른쪽 위의 [완료]를 직접 눌러 주세요.`, "err");
          return;
        }
        btn.click();
        panel(
          `발행 창을 열었습니다.<br><b>공개 설정을 확인하고</b> 마무리해 주세요.` +
          `<div style="margin-top:6px;color:#718096;font-size:11px">기본값이 비공개이므로, ` +
          `공개하려면 직접 바꿔야 합니다.</div>`, "ok");
      };
    }
  });
})();
