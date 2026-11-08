/**
 * 웹뷰의 브라우저 동작을 막습니다. 런처 창과 설정 창이 함께 씁니다.
 *
 * WebView2는 배포 빌드에서도 브라우저처럼 동작하는 부분이 남아 있습니다.
 *   - 빈 곳을 우클릭하면 「뒤로 · 새로 고침 · 다른 이름으로 저장 · 인쇄」 메뉴
 *   - F5 · Ctrl+R 새로 고침, Ctrl+P 인쇄, Ctrl+F · F3 페이지 찾기, Alt+← 뒤로
 * 새로 고침하면 런처가 처음부터 다시 뜨고, 나머지는 런처에 의미가 없습니다.
 *
 * 입력칸의 우클릭 메뉴(잘라내기 · 복사 · 붙여넣기)는 쓸모가 있어 그대로 둡니다.
 * 런처가 직접 띄우는 메뉴는 각 요소의 contextmenu 핸들러가 처리합니다.
 */

function isTextField(el) {
  return (
    !!el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

function blockedKey(e) {
  const k = e.key;
  if (k === "F5" || k === "F3" || k === "F7" || k === "BrowserBack" || k === "BrowserForward") {
    return true;
  }
  if (e.altKey && (k === "ArrowLeft" || k === "ArrowRight")) return true;
  if (e.ctrlKey) {
    const lower = k.length === 1 ? k.toLowerCase() : k;
    // Ctrl+F는 런처가 검색으로 씁니다. 그 처리는 막지 않고 기본 동작만 막습니다.
    if (["r", "p", "f", "g", "u", "s", "j", "h"].includes(lower)) return true;
  }
  return false;
}

export function installWebviewGuard() {
  document.addEventListener("contextmenu", (e) => {
    if (isTextField(e.target)) return;
    e.preventDefault();
  });

  // 캡처 단계에서 기본 동작만 막습니다. 전파는 그대로 두어 앱의 단축키
  // (Ctrl+F 검색 등)는 계속 동작합니다.
  window.addEventListener(
    "keydown",
    (e) => {
      if (blockedKey(e)) e.preventDefault();
    },
    true
  );

  // 마우스 뒤로 · 앞으로 버튼
  window.addEventListener("mouseup", (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
}
