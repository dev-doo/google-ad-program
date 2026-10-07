// tistory-main.js — 페이지와 **같은 세계(main world)** 에서 도는 스크립트.
//
// 왜 따로 있나: 보통의 content script 는 격리된 세계에서 돌아 페이지의 JS 변수
// (여기서는 window.tinymce)에 닿지 못한다. <script> 태그를 심는 우회법도 있지만
// 티스토리의 CSP 가 막을 수 있다. manifest 의 "world": "MAIN" 이 정공법이다.
//
// 하는 일: tistory.js(격리된 세계)가 CustomEvent 로 부탁하면, tinymce 를 만져 주고
// 결과를 돌려준다. 둘 사이의 유일한 통로가 이 이벤트다.
//
// ⚠ 핵심은 save() 다. setContent() 만 하면 숨은 textarea#editor-tistory 가 비어 있어
//    **빈 글이 발행된다.** 서버로 가는 값이 그 textarea 이기 때문이다.

(() => {
  const REQ = "gap-main-req";
  const RES = "gap-main-res";

  function reply(id, result) {
    window.dispatchEvent(new CustomEvent(RES, { detail: { id, result } }));
  }

  function editor() {
    const tm = window.tinymce;
    if (!tm) return null;
    return tm.get("editor-tistory") || tm.activeEditor || null;
  }

  // 서버로 제출되는 숨은 textarea 의 길이. 이것이 0 이면 빈 글이 나간다.
  function submittedLength() {
    const ta = document.getElementById("editor-tistory");
    return ta ? String(ta.value || "").length : -1;
  }

  function syncToTextarea(ed) {
    const tm = window.tinymce;
    try { if (ed && typeof ed.save === "function") ed.save(); } catch (_) {}
    try { if (tm && typeof tm.triggerSave === "function") tm.triggerSave(); } catch (_) {}
  }

  const actions = {
    // 지금 상태를 알려 준다. tistory.js 가 어느 경로로 갈지 정하는 데 쓴다.
    probe() {
      const ed = editor();
      return {
        hasTinymce: !!window.tinymce,
        hasEditor: !!ed,
        submitted: submittedLength(),
      };
    },

    // 본문을 넣고, 제출될 값까지 확인해서 돌려준다.
    setBody({ html }) {
      const ed = editor();
      if (!ed) return { ok: false, reason: "TinyMCE 편집기를 찾지 못했습니다", submitted: submittedLength() };
      try {
        ed.setContent(String(html || ""));
      } catch (e) {
        return { ok: false, reason: "본문을 넣지 못했습니다: " + (e?.message || e), submitted: submittedLength() };
      }
      syncToTextarea(ed);
      try { ed.fire("change"); } catch (_) {}
      const len = submittedLength();
      return {
        ok: len > 0,
        reason: len === 0 ? "넣었지만 저장될 값이 비어 있습니다" : len < 0 ? "저장용 칸을 찾지 못했습니다" : "",
        submitted: len,
      };
    },

    // 직접 넣기(대비책) 뒤에 동기화만 한 번 시도한다.
    sync() {
      syncToTextarea(editor());
      return { submitted: submittedLength() };
    },
  };

  window.addEventListener(REQ, (e) => {
    const { id, action, args } = e.detail || {};
    const fn = actions[action];
    if (!fn) return reply(id, { error: "알 수 없는 요청: " + action });
    try {
      reply(id, fn(args || {}));
    } catch (err) {
      reply(id, { error: String(err?.message || err) });
    }
  });

  // 준비됐음을 알린다. tistory.js 가 이 표시를 보고 기다릴지 말지 정한다.
  document.documentElement.dataset.gapMainReady = "1";
})();
