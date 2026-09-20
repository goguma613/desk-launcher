import { createApp } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";
import App from "./App.vue";
import SettingsApp from "./SettingsApp.vue";

/**
 * 설정은 별도 창입니다. 같은 번들을 두 창이 함께 쓰고, 어느 화면을 그릴지는
 * 창 라벨로 정합니다.
 *
 * URL 쿼리로 가르지 않는 이유가 있습니다. Rust 쪽 `WebviewUrl::App`이 PathBuf를
 * 받기 때문에 "index.html?view=settings"를 넘기면 '?'가 파일명의 일부로
 * 퍼센트 인코딩되어 404가 납니다.
 *
 * ?view=settings 쿼리는 브라우저로 미리 볼 때만 씁니다(Tauri 밖).
 */
function currentView() {
  const query = new URLSearchParams(location.search).get("view");
  if (query) return query;
  try {
    return getCurrentWindow().label === "settings" ? "settings" : "main";
  } catch {
    return "main"; // Tauri 밖 (브라우저 미리보기)
  }
}

const view = currentView();

try {
  createApp(view === "settings" ? SettingsApp : App).mount("#app");
} catch (e) {
  // 창이 투명해서, 마운트에 실패하면 아무것도 안 보입니다. 원인을 띄워 둡니다.
  console.error("마운트 실패", e);
  const el = document.querySelector("#app");
  if (el) {
    el.style.cssText =
      "background:#16181c;color:#e9ebee;font:12px/1.6 sans-serif;padding:16px;height:100%";
    el.textContent = `화면을 그리지 못했습니다: ${e}`;
  }
}
