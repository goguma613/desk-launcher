<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";

import TabBar from "./components/TabBar.vue";
import ItemGrid from "./components/ItemGrid.vue";
import EmptyState from "./components/EmptyState.vue";

import { UI_ICONS } from "./icons";
import { cellHeight, clamp, fitBarWidth, shadowPad, spec, windowSize } from "./layout";
import {
  state,
  hydrate,
  rehydrate,
  flushSave,
  holdSync,
  releaseSync,
  loadFailure,
  activeTab,
  addItems,
  addTab,
  removeItem,
  restoreItem,
  moveItem,
  removeTab,
  moveTab,
  isSaneOffset,
  MAX_TABS,
} from "./store";
import { prefetch, clearLocal, pruneOrphans } from "./extractedIcons";
import { findUpdateQuietly } from "./updater";

/* ---------------------------------------------------------------------------
   기본 상태
   --------------------------------------------------------------------------- */

const ready = ref(false);
const editing = ref(false);
const dropActive = ref(false);
const toast = ref({ text: "", label: "", run: null });
const missing = ref(new Set());

/** null | 'item' | 'link' */
const overlay = ref(null);


const area = ref({ x: 0, y: 0, width: 1920, height: 1040, scale: 1 });
const basePos = ref({ x: 0, y: 0 });

const tab = computed(() => activeTab());
const items = computed(() => tab.value?.items ?? []);

/* ---------------------------------------------------------------------------
   검색
   ---------------------------------------------------------------------------
   탭이 8개면 항목이 200개를 넘어갑니다. 어느 탭에 넣었는지 기억해야
   찾을 수 있는 게 가장 큰 병목이라, 전체 탭을 한 번에 훑습니다.
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   업데이트 감지
   ---------------------------------------------------------------------------
   상시 띄워두는 도구라 재시작할 일이 거의 없습니다. 켤 때 한 번만 보면
   사실상 수동 확인에 기대는 셈이라, 돌아가는 동안에도 주기적으로 봅니다.
   토스트는 사라지므로 톱니 버튼에 점을 남겨 놓칠 수 없게 합니다.
   --------------------------------------------------------------------------- */

const UPDATE_EVERY = 6 * 60 * 60 * 1000; // 6시간

/** 받을 수 있는 새 버전. 없으면 "" */
const updateReady = ref("");
/** 같은 버전을 계속 알리지 않도록 */
let notifiedVersion = "";
let updateTimer = null;

async function pollUpdate() {
  const found = await findUpdateQuietly();
  updateReady.value = found ? found.version : "";
  if (!found || found.version === notifiedVersion) return;
  notifiedVersion = found.version;
  flash(`새 버전 v${found.version} 이 있습니다`, {
    label: "설정 열기",
    run: () => invoke("open_settings"),
  });
}

/** 항목을 끌어다 올린 탭 id */
const dragOverTab = ref("");

const searching = ref(false);
const query = ref("");
const searchInput = ref(null);

/* 검색 순위
   Enter가 첫 결과를 바로 실행하므로 순서가 곧 정확도입니다.
     0  이름이 검색어로 시작
     1  이름 속 단어가 검색어로 시작 · 머리글자(lol → League of Legends) · 초성
     2  이름 어딘가에 포함
     3  초성이 중간에 포함
     4  파일 이름(확장자 뺀)에 포함 — 폴더 경로는 보지 않습니다.
        C:\Windows\... 아래 항목이 「win」에 전부 걸리던 문제가 있었습니다.
   같은 순위면 자주 실행한 항목(launches), 그다음 지금 보고 있는 탭의 항목,
   그다음 원래 순서. */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
// 한글 입력기로 ㄹ, ㄱ 을 연달아 치면 겹받침 ㄺ 하나로 합쳐집니다.
const SPLIT_JAMO = {
  ㄳ: "ㄱㅅ", ㄵ: "ㄴㅈ", ㄶ: "ㄴㅎ", ㄺ: "ㄹㄱ", ㄻ: "ㄹㅁ", ㄼ: "ㄹㅂ",
  ㄽ: "ㄹㅅ", ㄾ: "ㄹㅌ", ㄿ: "ㄹㅍ", ㅀ: "ㄹㅎ", ㅄ: "ㅂㅅ",
};

function chosungOf(text) {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out += c >= 0xac00 && c <= 0xd7a3 ? CHO[Math.floor((c - 0xac00) / 588)] : ch;
  }
  return out;
}

/** 단어로 나눕니다. BlueStacks처럼 대문자로 이어 붙인 이름도 나눕니다 (bs). */
function wordsOf(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s\-_.()[\]·,]+/)
    .filter(Boolean);
}

function fileNameOf(item) {
  if (item.kind === "url") {
    try {
      return new URL(item.path).hostname;
    } catch {
      return item.path;
    }
  }
  const last = item.path.split(/[\\/]/).pop() || "";
  return last.replace(/\.[^.]+$/, "");
}

function matchScore(item, q, qCho) {
  const name = item.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  const words = wordsOf(item.name);
  if (words.some((w) => w.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  if (qCho) {
    const cho = chosungOf(name);
    const compact = cho.replace(/\s+/g, "");
    if (compact.startsWith(qCho)) return 1;
    const initials = wordsOf(cho).map((w) => w[0]).join("");
    if (initials.startsWith(qCho)) return 1;
    if (compact.includes(qCho)) return 3;
  } else if (q.length >= 2) {
    const initials = words.map((w) => w[0]).join("");
    if (initials.startsWith(q)) return 1;
  }
  if (fileNameOf(item).toLowerCase().includes(q)) return 4;
  return -1;
}

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  const split = [...q].map((c) => SPLIT_JAMO[c] || c).join("");
  const qCho = /^[ㄱ-ㅎ]+$/.test(split) ? split : null;

  const current = state.tabs.find((t) => t.id === state.activeTabId);
  const ordered = current
    ? [current, ...state.tabs.filter((t) => t !== current)]
    : state.tabs;

  const scored = [];
  let order = 0;
  for (const t of ordered) {
    for (const it of t.items) {
      const score = matchScore(it, q, qCho);
      if (score >= 0) scored.push({ it, score, order: order++ });
    }
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      (b.it.launches || 0) - (a.it.launches || 0) ||
      a.order - b.order
  );
  return scored.map((x) => x.it);
});

/** 검색어가 있을 때만 검색 결과를 보여줍니다. 칸만 열어둔 상태에서는
    지금 탭을 그대로 둡니다. 안 그러면 타이핑을 시작하기 전까지 비어 보입니다. */
const filtering = computed(() => searching.value && query.value.trim() !== "");

/** 격자에 실제로 그릴 목록 */
const shown = computed(() => (filtering.value ? matches.value : items.value));

function openSearch() {
  editing.value = false;
  searching.value = true;
  // 같은 이벤트 안에서 바로 포커스를 줍니다. (입력칸 주석 참고)
  searchInput.value?.focus();
}

function closeSearch() {
  searching.value = false;
  query.value = "";
  searchInput.value?.blur();
}
const preset = computed(() => spec(state.settings.preset));
const axis = computed(() => preset.value.axis);

/** 그림자가 잘리지 않도록 창 안쪽에 확보한 여백 */
const padStyle = computed(() => {
  const p = shadowPad(state.settings.preset);
  return {
    paddingTop: p.top + "px",
    paddingRight: p.right + "px",
    paddingBottom: p.bottom + "px",
    paddingLeft: p.left + "px",
  };
});

/* ---------------------------------------------------------------------------
   드롭 오버레이 수명 관리
   ---------------------------------------------------------------------------
   Windows에서 드래그앤드롭 이벤트가 깔끔하게 끝나지 않습니다.
     - drop 다음에 over가 한 번 더 들어와 오버레이가 되살아납니다
     - 창 밖으로 빠르게 빼면 leave를 놓쳐 오버레이가 그대로 남습니다
   그래서 드롭 직후 잠깐 무시하는 구간과, over가 끊기면 스스로 닫는
   감시 타이머를 둡니다.
   --------------------------------------------------------------------------- */

let dropGuardUntil = 0;
let dropWatchdog = null;

function armDropWatchdog() {
  if (dropWatchdog) clearTimeout(dropWatchdog);
  dropWatchdog = setTimeout(() => {
    dropWatchdog = null;
    dropActive.value = false;
  }, 700);
}

/* 탐색기에서 끌어온 파일을 탭 이름 위에 놓으면 그 탭에 넣습니다.
   그러려면 탭 바가 드롭 안내에 가려지면 안 되므로, 안내는 항목 영역만 덮습니다. */
const dropInset = ref({});

function measureDropInset() {
  const panel = document.querySelector(".panel");
  const head = panel?.querySelector(".tabbar");
  const foot = panel?.querySelector(".footer");
  if (!panel || !head || !foot) {
    dropInset.value = {};
    return;
  }
  const pr = panel.getBoundingClientRect();
  const hr = head.getBoundingClientRect();
  const fr = foot.getBoundingClientRect();
  dropInset.value =
    axis.value === "horizontal"
      ? { left: hr.right - pr.left + "px", right: pr.right - fr.left + "px" }
      : { top: hr.bottom - pr.top + "px", bottom: pr.bottom - fr.top + "px" };
}

/** 드롭 좌표(창 물리 픽셀) 아래에 있는 탭 id. 없으면 "" */
function tabAt(position) {
  if (!position) return "";
  const r = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(position.x / r, position.y / r);
  return el?.closest?.("[data-tab-id]")?.getAttribute("data-tab-id") || "";
}

/** 드롭하면 들어갈 탭 이름 */
const dropTargetName = computed(() => {
  const id = dragOverTab.value || state.activeTabId;
  return state.tabs.find((t) => t.id === id)?.name || "";
});

function endDrop() {
  if (dropWatchdog) {
    clearTimeout(dropWatchdog);
    dropWatchdog = null;
  }
  dropActive.value = false;
  dragOverTab.value = "";
  dropGuardUntil = Date.now() + 600;
}

let toastTimer = null;
const EMPTY_TOAST = { text: "", label: "", run: null };

/* 하단 가로 바는 폭이 화면 전체라, 가운데에 띄우면 왼쪽에 몰린 항목에서
   한참 떨어진 곳에 「되돌리기」가 뜹니다. 마지막 항목 바로 옆에 띄웁니다. */
const toastStyle = ref({});

function placeToast() {
  if (axis.value !== "horizontal") {
    toastStyle.value = {};
    return;
  }
  const panel = document.querySelector(".panel");
  if (!panel) return;
  const pr = panel.getBoundingClientRect();
  const tiles = panel.querySelectorAll(".body .tile");
  const anchor = tiles.length
    ? tiles[tiles.length - 1].getBoundingClientRect().right
    : panel.querySelector(".tabbar")?.getBoundingClientRect().right ?? pr.left;
  // 항목이 바 끝까지 차 있으면 오른쪽 끝에서 알림 폭만큼 안쪽으로.
  const x = Math.min(anchor - pr.left + 16, pr.width - 440);
  toastStyle.value = { left: Math.max(12, Math.round(x)) + "px" };
}

/**
 * 알림. 두 번째 인자를 주면 「되돌리기」 같은 버튼이 함께 뜹니다.
 * 버튼이 있으면 읽고 누를 시간이 필요하므로 더 오래 남깁니다.
 */
function flash(text, action = null) {
  placeToast();
  toast.value = { text, label: action?.label || "", run: action?.run || null };
  // 방금 지운 항목처럼 DOM이 바뀌는 중이면 한 박자 뒤에 다시 맞춥니다.
  nextTick(placeToast);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast.value = { ...EMPTY_TOAST };
    },
    action ? 6000 : 1800
  );
}

function runToastAction() {
  const run = toast.value.run;
  if (toastTimer) clearTimeout(toastTimer);
  toast.value = { ...EMPTY_TOAST };
  if (run) run();
}

/* ---------------------------------------------------------------------------
   창 배치 / 레이어
   --------------------------------------------------------------------------- */

let placing = false;

async function applyLayout() {
  placing = true;
  try {
    const s = state.settings;
    area.value = await invoke("work_area", { monitor: s.monitor || "" });
    const size = windowSize(
      area.value,
      filtering.value ? matches.value.length : undefined
    );
    if (fitBar.value) size.width = await measureFitWidth();

    const off = s.offsets[s.preset] || { x: 0, y: 0 };
    const placed = await invoke("place_window", {
      preset: s.preset,
      width: size.width,
      height: size.height,
      offX: off.x,
      offY: off.y,
      monitor: s.monitor || "",
    });
    basePos.value = { x: placed.baseX, y: placed.baseY };
  } catch (e) {
    console.error("창 배치 실패", e);
  } finally {
    setTimeout(() => {
      placing = false;
    }, 150);
  }
}

/* 하단 바 「항목에 맞춤」 — 독처럼 내용만큼의 폭으로 가운데에 놓습니다.
   탭 이름 길이에 따라 탭 바 폭이 달라지므로 실제 DOM을 재서 더합니다. */
const fitBar = computed(
  () => state.settings.preset === "bottom" && state.settings.barFit === true
);

async function measureFitWidth() {
  await nextTick();
  const panel = document.querySelector(".panel");
  const head = panel?.querySelector(".tabbar");
  const strip = head?.querySelector(".tabs");
  const foot = panel?.querySelector(".footer");
  // 탭 바는 좁아지면 줄어들므로, 줄어든 만큼(넘친 폭)을 되돌려 더합니다.
  const headW = head
    ? head.offsetWidth + (strip ? strip.scrollWidth - strip.clientWidth : 0)
    : 0;
  const footW = foot ? foot.offsetWidth : 0;
  return fitBarWidth(area.value, headW, footW);
}

let relayoutTimer = null;

/** 디스플레이 변경 이벤트는 몰려서 들어옵니다. 마지막 것 하나만 처리합니다. */
function scheduleRelayout() {
  if (relayoutTimer) clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    relayoutTimer = null;
    if (ready.value) applyLayout();
  }, 400);
}

async function applyLayer() {
  try {
    await invoke("set_layer", { bottom: state.settings.mode === "desktop" });
  } catch (e) {
    console.error("레이어 전환 실패", e);
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
}

function applyOpacity() {
  document.documentElement.style.setProperty(
    "--panel-alpha",
    String(state.settings.opacity)
  );
}

async function applyShortcut() {
  // 단축키는 런처 창만 등록합니다. 설정 창까지 등록하면 충돌합니다.
  try {
    await invoke("set_shortcut", { accel: state.settings.shortcut });
  } catch (e) {
    console.error("단축키 등록 실패", e);
    // 조용히 실패하면 "왜 단축키가 안 되지"만 남습니다.
    flash("단축키를 등록하지 못했습니다 — 다른 프로그램이 쓰는 중입니다", {
      label: "설정 열기",
      run: () => invoke("open_settings"),
    });
  }
}

async function applyAutostart() {
  try {
    const current = await isAutostartEnabled();
    if (state.settings.autostart) {
      // 켜져 있어도 다시 등록합니다. 등록값에는 실행 파일 경로가 들어 있어서,
      // 빌드 폴더에서 켰다가 설치본을 쓰거나 설치 위치가 바뀌면 옛 경로가 남아
      // 자동 실행이 조용히 안 됩니다. enable은 지금 경로로 덮어씁니다.
      // 개발 실행(npm run tauri dev)은 설치본과 같은 이름으로 등록되므로 건드리지 않습니다.
      if (!current || !import.meta.env.DEV) await enableAutostart();
    } else if (current) {
      await disableAutostart();
    }
  } catch (e) {
    console.error("자동 실행 설정 실패", e);
  }
}

/* ---------------------------------------------------------------------------
   항목 조작
   --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   실행
   ---------------------------------------------------------------------------
   바탕화면 아이콘은 더블클릭이 습관이라, 한 번 클릭으로 실행하는 이 런처에서
   두 번 실행되곤 했습니다. 같은 항목을 곧바로 다시 누르면 무시하고,
   누른 순간 아이콘이 튀어 올라 실행됐다는 걸 보여줍니다.
   --------------------------------------------------------------------------- */

const REPEAT_GUARD = 1500;
let lastLaunch = { id: "", at: 0 };
const launchedId = ref("");
let launchedTimer = null;

function openItem(item, { admin = false } = {}) {
  // 관리자 실행은 프로그램만. 폴더 · 문서에 Ctrl+Shift+클릭하면 그냥 엽니다.
  const elevate = item.kind === "app" && (admin || item.admin === true);
  const now = Date.now();
  if (lastLaunch.id === item.id && now - lastLaunch.at < REPEAT_GUARD) return;
  lastLaunch = { id: item.id, at: now };

  launchedId.value = item.id;
  if (launchedTimer) clearTimeout(launchedTimer);
  launchedTimer = setTimeout(() => (launchedId.value = ""), 600);

  invoke("launch", { path: item.path, admin: elevate })
    .then(() => {
      // 검색 순위에 씁니다. 저장 파일이 끝없이 커지지 않게 상한을 둡니다.
      item.launches = Math.min((item.launches || 0) + 1, 9999);
      if (searching.value) closeSearch();
      // 오버레이는 불러내서 하나 실행하고 끝나는 용도입니다.
      if (state.settings.mode === "overlay") {
        setTimeout(() => invoke("hide_window").catch(() => {}), 160);
      }
    })
    .catch((e) => {
      lastLaunch = { id: "", at: 0 };
      // UAC 창에서 「아니요」를 누른 것. 사용자가 고른 것이니 알리지 않습니다.
      if (String(e) === "cancelled") return;
      flash(`실행하지 못했습니다: ${e}`);
    });
}

/** 파일 위치 열기. 우클릭 메뉴와 가운데 클릭이 같이 씁니다. 웹 링크는 그냥 엽니다. */
function revealItem(item) {
  if (item.kind === "url") {
    openItem(item);
    return;
  }
  invoke("reveal", { path: item.path }).catch((e) =>
    flash(`위치를 열지 못했습니다: ${e}`)
  );
}

/** 항목이 들어 있는 탭. 검색 결과는 여러 탭에서 오므로 활성 탭으로 단정할 수 없습니다. */
function ownerOf(item) {
  return state.tabs.find((t) => t.items.some((it) => it.id === item.id));
}

function onRemove(item) {
  const owner = ownerOf(item);
  if (!owner) return;
  const undo = removeItem(owner.id, item.id);
  missing.value.delete(item.id);
  if (!undo) return;

  // 편집 모드의 ✕는 확인 없이 지웁니다. 매번 확인을 묻는 것보다
  // 되돌릴 수 있게 하는 편이 이 동작에 맞습니다.
  flash(`'${item.name}' 삭제`, {
    label: "되돌리기",
    run: () => {
      if (restoreItem(undo)) {
        flash("되돌렸습니다");
        checkPaths();
      }
    },
  });
}

function onMove(from, to) {
  moveItem(state.activeTabId, from, to);
}

/** 항목을 다른 탭으로 옮깁니다. 끌어다 놓기와 우클릭 메뉴가 같이 씁니다. */
function onDropOnTab(tabId, item) {
  if (!item) return;
  const to = state.tabs.find((t) => t.id === tabId);
  const from = ownerOf(item);
  if (!to || !from || from.id === to.id) return;
  if (to.items.some((it) => it.path === item.path)) {
    flash(`${to.name} 탭에 이미 있는 항목입니다`);
    return;
  }
  const i = from.items.findIndex((it) => it.id === item.id);
  const [moved] = from.items.splice(i, 1);
  to.items.push(moved);
  flash(`${to.name} 탭으로 옮겼습니다`, {
    label: "되돌리기",
    run: () => {
      const back = to.items.findIndex((it) => it.id === moved.id);
      if (back >= 0) {
        to.items.splice(back, 1);
        from.items.splice(Math.min(i, from.items.length), 0, moved);
      }
    },
  });
}

async function registerPaths(paths, tabId = state.activeTabId) {
  if (!paths.length) return;
  try {
    const infos = await invoke("inspect_paths", { paths });
    const added = addItems(infos, tabId);
    const skipped = infos.length - added;
    // 다른 탭에 넣었으면 그 탭을 보여줍니다. 안 그러면 들어갔는지 알 수 없습니다.
    const elsewhere = tabId !== state.activeTabId;
    if (elsewhere) state.activeTabId = tabId;
    const where = elsewhere
      ? `${state.tabs.find((t) => t.id === tabId)?.name || ""} 탭에 `
      : "";
    if (added && skipped) flash(`${where}${added}개 추가, ${skipped}개는 이미 있음`);
    else if (added) flash(`${where}${added}개 추가했습니다`);
    else flash("이미 등록된 항목입니다");
    prefetch(infos.map((i) => i.path));
    checkPaths();
  } catch (e) {
    flash(`등록하지 못했습니다: ${e}`);
  }
}

/** 경로가 사라진 항목의 대상만 바꿉니다. 이름·아이콘은 그대로 둡니다. */
async function relocateItem(item) {
  if (!item) return;
  try {
    const picked = await openDialog({
      multiple: false,
      directory: item.kind === "folder",
      title: item.name + " 의 새 위치 고르기",
    });
    if (!picked) return;
    const [info] = await invoke("inspect_paths", { paths: [picked] });
    item.path = info.path;
    item.ext = info.ext;
    if (info.isDir) item.kind = "folder";
    prefetch([info.path]);
    checkPaths();
    flash("경로를 바꿨습니다");
  } catch (e) {
    flash(`경로를 바꾸지 못했습니다: ${e}`);
  }
}

async function browseFiles() {
  try {
    const picked = await openDialog({
      multiple: true,
      directory: false,
      title: "런처에 추가할 파일 고르기",
    });
    if (!picked) return;
    await registerPaths(Array.isArray(picked) ? picked : [picked]);
  } catch (e) {
    flash(`파일을 고르지 못했습니다: ${e}`);
  }
}

async function browseFolders() {
  try {
    const picked = await openDialog({
      multiple: true,
      directory: true,
      title: "런처에 추가할 폴더 고르기",
    });
    if (!picked) return;
    await registerPaths(Array.isArray(picked) ? picked : [picked]);
  } catch (e) {
    flash(`폴더를 고르지 못했습니다: ${e}`);
  }
}

/* ---------------------------------------------------------------------------
   우클릭 메뉴
   ---------------------------------------------------------------------------
   예전에는 우클릭하면 편집 시트가 떴습니다. 하단 가로 바는 높이가 96px라
   시트를 담으려고 창이 위로 크게 늘어났다 줄어들었고, 지우기 하나에도
   그 과정을 거쳐야 했습니다. 지금은 Windows 기본 메뉴를 씁니다.
   창 밖으로 펼쳐지므로 어느 배치에서든 창 크기가 그대로입니다.
   --------------------------------------------------------------------------- */

const renamingItemId = ref("");
const renamingTabId = ref("");

/* 메뉴를 만들고 띄우는 동안 우클릭이 또 들어오면 무시합니다. popup은 메뉴가
   닫힐 때까지 돌아오지 않는데(Windows 메뉴 루프), 그 사이에 두 번째 메뉴를
   띄우면 메뉴 루프가 겹칩니다. */
let menuOpen = false;

async function popup(entries) {
  if (menuOpen) return;
  menuOpen = true;
  try {
    const built = [];
    for (const e of entries) {
      if (e === "-") built.push(await PredefinedMenuItem.new({ item: "Separator" }));
      else if (e.items) built.push(await Submenu.new(e));
      else if ("checked" in e) built.push(await CheckMenuItem.new(e));
      else built.push(await MenuItem.new(e));
    }
    const menu = await Menu.new({ items: built });
    await menu.popup();
    // 메뉴 동작은 popup이 끝난 뒤에 도착할 수 있어서 바로 닫지 않습니다.
    setTimeout(() => menu.close().catch(() => {}), 5000);
  } finally {
    menuOpen = false;
  }
}

async function showItemMenu(item) {
  if (overlay.value) return;
  const owner = ownerOf(item);
  if (!owner) return;
  const others = state.tabs.filter((t) => t.id !== owner.id);
  const isUrl = item.kind === "url";

  const entries = [{ text: "열기", action: () => openItem(item) }];
  // 게임 런처 · 시스템 도구처럼 관리자 권한이 필요한 프로그램용.
  // 늘 관리자로 실행하도록 해 두었으면 「열기」가 이미 그렇게 하므로 숨깁니다.
  if (item.kind === "app" && !item.admin) {
    entries.push({
      text: "관리자 권한으로 실행",
      action: () => openItem(item, { admin: true }),
    });
  }
  if (!isUrl) {
    entries.push({ text: "파일 위치 열기", action: () => revealItem(item) });
  }
  if (missing.value.has(item.id)) {
    entries.push({ text: "새 위치 찾기…", action: () => relocateItem(item) });
  }
  entries.push("-");
  entries.push({ text: "이름 바꾸기", action: () => startItemRename(item) });
  if (others.length) {
    entries.push({
      text: "다른 탭으로",
      items: others.map((t) => ({
        text: t.name,
        action: () => onDropOnTab(t.id, item),
      })),
    });
  }
  entries.push({
    text: isUrl ? "주소 · 아이콘 바꾸기…" : "아이콘 바꾸기…",
    action: () => openEditor(item),
  });
  if (item.kind === "app") {
    entries.push({
      text: "항상 관리자 권한으로 실행",
      checked: item.admin === true,
      action: () => toggleAdmin(item),
    });
  }
  entries.push("-");
  entries.push({ text: "삭제", action: () => onRemove(item) });

  try {
    await popup(entries);
  } catch (e) {
    // 메뉴를 못 띄우면 예전처럼 시트로 엽니다.
    console.error("메뉴 실패", e);
    openEditor(item);
  }
}

function toggleAdmin(item) {
  if (item.admin) {
    delete item.admin;
    flash(`${item.name} — 이제 관리자 권한 없이 실행합니다`);
  } else {
    item.admin = true;
    flash(`${item.name} — 이제 늘 관리자 권한으로 실행합니다`);
  }
}

/* 빈 곳 우클릭. 브라우저 기본 메뉴(새로 고침 · 인쇄 …)는 webviewGuard.js가
   막고, 그 자리에 런처 메뉴를 띄웁니다. 항목 · 탭 · 입력칸은 각자 처리합니다.
   「여러 개 지우기」(편집 모드)는 푸터 버튼에서 이리로 옮겼습니다. 하나씩
   지우기는 우클릭과 Delete로 되니, 편집 모드는 가끔 쓰는 기능입니다. */
async function showPanelMenu(e) {
  if (overlay.value) return;
  if (e.target.closest?.(".tile, [data-tab-id], input, textarea, button")) return;
  const entries = [
    { text: "파일 · 프로그램 추가…", action: browseFiles },
    { text: "폴더 추가…", action: browseFolders },
    { text: "웹 링크 추가…", action: openLinkAdder },
    "-",
    editing.value
      ? { text: "여러 개 지우기 끝내기", action: () => (editing.value = false) }
      : {
          text: "여러 개 지우기",
          enabled: items.value.length > 0,
          action: () => {
            if (searching.value) closeSearch();
            editing.value = true;
          },
        },
    {
      text: "새 탭",
      enabled: state.tabs.length < MAX_TABS,
      action: onAddTab,
    },
    "-",
    {
      text: "기본 자리로",
      action: async () => {
        state.settings.offsets[state.settings.preset] = { x: 0, y: 0 };
        await applyLayout();
      },
    },
    { text: "설정…", action: () => invoke("open_settings") },
  ];
  try {
    await popup(entries);
  } catch (err) {
    console.error("메뉴 실패", err);
  }
}

function startItemRename(item) {
  const owner = ownerOf(item);
  if (!owner) return;
  if (searching.value) closeSearch();
  editing.value = false;
  state.activeTabId = owner.id;
  holdSync();
  renamingItemId.value = item.id;
}

async function finishItemRename(item, value) {
  const name = (value || "").trim();
  if (item && name && name !== item.name) item.name = name;
  renamingItemId.value = "";
  await flushSave();
  await releaseSync();
}

async function cancelItemRename() {
  renamingItemId.value = "";
  await releaseSync();
}

async function showTabMenu(t) {
  if (overlay.value) return;
  const i = state.tabs.findIndex((x) => x.id === t.id);
  const n = t.items.length;
  try {
    await popup([
      { text: "이름 바꾸기", action: () => startTabRename(t.id) },
      { text: "왼쪽으로 옮기기", enabled: i > 0, action: () => moveTab(i, i - 1) },
      {
        text: "오른쪽으로 옮기기",
        enabled: i < state.tabs.length - 1,
        action: () => moveTab(i, i + 1),
      },
      "-",
      {
        text: n ? `탭 삭제 (항목 ${n}개 포함)` : "탭 삭제",
        enabled: state.tabs.length > 1,
        action: () => deleteTab(t.id),
      },
    ]);
  } catch (e) {
    console.error("메뉴 실패", e);
  }
}

function startTabRename(id) {
  if (searching.value) closeSearch();
  state.activeTabId = id;
  holdSync();
  renamingTabId.value = id;
}

async function finishTabRename(id, value) {
  const t = state.tabs.find((x) => x.id === id);
  const name = (value || "").trim();
  if (t && name && name !== t.name) t.name = name;
  renamingTabId.value = "";
  await flushSave();
  await releaseSync();
}

async function cancelTabRename() {
  renamingTabId.value = "";
  await releaseSync();
}

/** 탭 삭제는 항목까지 같이 사라지므로 되돌릴 수 있게 합니다. */
function deleteTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = state.tabs[i];
  const wasActive = state.activeTabId === id;
  if (!removeTab(id)) return;
  flash(`'${t.name}' 탭 삭제`, {
    label: "되돌리기",
    run: () => {
      if (state.tabs.some((x) => x.id === t.id) || state.tabs.length >= MAX_TABS) return;
      state.tabs.splice(Math.min(i, state.tabs.length), 0, t);
      if (wasActive) state.activeTabId = t.id;
      flash("되돌렸습니다");
    },
  });
}

async function showAddMenu() {
  if (overlay.value) return;
  try {
    await popup([
      { text: "파일 · 프로그램 추가…", action: browseFiles },
      { text: "폴더 추가…", action: browseFolders },
      { text: "웹 링크 추가…", action: openLinkAdder },
    ]);
  } catch (e) {
    console.error("메뉴 실패", e);
    browseFiles();
  }
}

/* 아이콘 · 주소 편집과 웹 링크 추가는 설정 창에서 엽니다.
   런처 안에 시트로 띄우면 하단 가로 바(높이 96px)가 그 시트를 담느라 위로
   크게 늘어났다 줄어듭니다. 설정 창은 별도 창이라 런처 크기가 그대로입니다. */
async function openEditor(item) {
  if (searching.value) closeSearch();
  await flushSave(); // 방금 바꾼 것을 설정 창이 읽을 수 있게
  invoke("open_settings", { request: { view: "item", id: item.id } }).catch((e) =>
    flash(`편집 창을 열지 못했습니다: ${e}`)
  );
}

async function openLinkAdder() {
  await flushSave();
  invoke("open_settings", {
    request: { view: "link", tabId: state.activeTabId },
  }).catch((e) => flash(`창을 열지 못했습니다: ${e}`));
}

/** 예전 시트용. 이제 런처 안에 시트는 없지만 Esc 처리 등에서 부릅니다. */
async function closeOverlay() {
  overlay.value = null;
}

function onAddTab() {
  if (state.tabs.length >= MAX_TABS) {
    flash(`탭은 최대 ${MAX_TABS}개까지입니다`);
    return;
  }
  const t = addTab("새 탭");
  // 「새 탭」으로 남겨두지 않도록 바로 이름을 받습니다.
  if (t) startTabRename(t.id);
}

/* ---------------------------------------------------------------------------
   경로 유효성 검사
   --------------------------------------------------------------------------- */

/* 켤 때만 확인하면, 상시 떠 있는 동안 프로그램을 지우거나 외장 드라이브를 빼도
   재시작 전까지 정상으로 보입니다. 창이 포커스를 받거나 불려 나올 때, 그리고
   10분마다 다시 봅니다. 연결이 끊긴 네트워크 경로는 응답이 수십 초 걸릴 수
   있어서, 확인이 겹치지 않게 하고 너무 잦지 않게 간격을 둡니다. */
const RECHECK_GAP = 15 * 1000;
const RECHECK_EVERY = 10 * 60 * 1000;
let checking = false;
let checkAgain = false;
let lastCheck = 0;
let recheckTimer = null;

function recheckPaths() {
  if (checking || Date.now() - lastCheck < RECHECK_GAP) return;
  checkPaths();
}

async function checkPaths() {
  const all = state.tabs
    .flatMap((t) => t.items)
    .filter((it) => it.kind !== "url");
  if (!all.length) {
    missing.value = new Set();
    return;
  }
  if (checking) {
    checkAgain = true;
    return;
  }
  checking = true;
  lastCheck = Date.now();
  try {
    const infos = await invoke("inspect_paths", {
      paths: all.map((it) => it.path),
    });
    const set = new Set();
    infos.forEach((info, i) => {
      if (!info.exists) set.add(all[i].id);
    });
    missing.value = set;
  } catch (e) {
    console.error("경로 확인 실패", e);
  } finally {
    checking = false;
    // 확인하는 사이 항목이 바뀌었으면 (추가 · 되돌리기 등) 한 번 더 봅니다.
    if (checkAgain) {
      checkAgain = false;
      checkPaths();
    }
  }
}

function prefetchAll() {
  prefetch(state.tabs.flatMap((t) => t.items).map((it) => it.path));
}

/* ---------------------------------------------------------------------------
   바뀐 것만 적용하기
   ---------------------------------------------------------------------------
   예전에는 설정이 저장될 때마다 전부 다시 돌렸습니다. 설정 창에서 슬라이더를
   끄는 동안 350ms마다 창이 재배치되고 전역 단축키가 해제·재등록되면서,
   그 찰나에 단축키가 먹지 않고 창 위치까지 어긋났습니다.
   지금은 지문을 떠서 실제로 바뀐 항목만 손댑니다.
   --------------------------------------------------------------------------- */

function fingerprint() {
  const s = state.settings;
  return {
    preset: s.preset,
    mode: s.mode,
    theme: s.theme,
    opacity: s.opacity,
    shortcut: s.shortcut,
    autostart: s.autostart,
    showNames: s.showNames,
    monitor: s.monitor || "",
    barFit: !!s.barFit,
    // 독 폭은 탭 이름 길이에 따라 달라집니다
    tabNames: fitBar.value ? state.tabs.map((t) => t.name).join("\u0000") : "",
    emptyTab: items.value.length === 0,
    itemCount: state.tabs.reduce((n, t) => n + t.items.length, 0),
    overlayOpen: overlay.value !== null,
    searching: filtering.value,
    matchCount: filtering.value ? matches.value.length : -1,
    paths: state.tabs
      .flatMap((t) => t.items.map((it) => it.path))
      .join("\u0000"),
  };
}

let applied = null;

async function applyChanged() {
  const now = fingerprint();
  const was = applied || {};
  applied = now;

  if (now.theme !== was.theme) applyTheme();
  if (now.opacity !== was.opacity) applyOpacity();
  if (now.shortcut !== was.shortcut) await applyShortcut();
  if (now.autostart !== was.autostart) await applyAutostart();
  if (now.mode !== was.mode) await applyLayer();

  if (
    now.preset !== was.preset ||
    now.showNames !== was.showNames ||
    now.monitor !== was.monitor ||
    now.barFit !== was.barFit ||
    now.tabNames !== was.tabNames ||
    now.emptyTab !== was.emptyTab ||
    now.itemCount !== was.itemCount ||
    now.overlayOpen !== was.overlayOpen ||
    now.searching !== was.searching ||
    now.matchCount !== was.matchCount
  ) {
    await applyLayout();
  }

  if (now.paths !== was.paths) {
    prefetchAll();
    checkPaths();
  }
}

/* ---------------------------------------------------------------------------
   생명주기
   --------------------------------------------------------------------------- */

const unlisteners = [];

/* ---------------------------------------------------------------------------
   키보드
   ---------------------------------------------------------------------------
   단축키로 불러낸 뒤 손을 마우스로 옮기지 않아도 되게 합니다.
     - 아무 글자나 치면 검색이 열리고 그 글자부터 걸러집니다
     - 방향키로 고르고 Enter로 실행합니다. 검색 중이면 첫 결과가 골라져 있습니다
   --------------------------------------------------------------------------- */

const kbdIndex = ref(-1);
const focusId = computed(() => shown.value[kbdIndex.value]?.id || "");

watch(query, () => {
  kbdIndex.value = filtering.value && matches.value.length ? 0 : -1;
});
watch(
  () => state.activeTabId,
  () => {
    kbdIndex.value = -1;
    hoveredItem.value = null;
  }
);

function moveFocus(delta) {
  const n = shown.value.length;
  if (!n) return;
  const cur = kbdIndex.value;
  kbdIndex.value = cur < 0 ? 0 : clamp(cur + delta, 0, n - 1);
  nextTick(() =>
    document
      .querySelector(".tile.kbd")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  );
}

function isTextField(el) {
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

/** 마우스를 올려 둔 항목. F2 · Delete가 키보드 선택이 없을 때 이걸 씁니다. */
const hoveredItem = ref(null);

/** 방향키 · Enter · 바로 검색. 처리했으면 true */
function onNavKey(e) {
  if (overlay.value || renamingItemId.value || renamingTabId.value) return false;
  const inSearch = e.target === searchInput.value;
  const inField = isTextField(e.target);
  if (inField && !inSearch) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;

  // 탐색기와 같은 손버릇: F2 이름 바꾸기, Delete 삭제(되돌리기 가능)
  if (!inField && (e.key === "F2" || e.key === "Delete")) {
    const target = shown.value[kbdIndex.value] || hoveredItem.value;
    if (!target) return false;
    e.preventDefault();
    if (e.key === "F2") startItemRename(target);
    else onRemove(target);
    return true;
  }

  // 하단 가로 바는 한 줄이라 위아래도 옆으로 움직입니다.
  const rowStep = preset.value.cols || 1;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveFocus((e.key === "ArrowDown" ? 1 : -1) * rowStep);
    return true;
  }
  // 검색칸 안에서는 좌우가 글자 사이를 움직여야 합니다.
  if (!inSearch && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    moveFocus(e.key === "ArrowRight" ? 1 : -1);
    return true;
  }
  if (e.key === "Enter" && shown.value[kbdIndex.value]) {
    e.preventDefault();
    openItem(shown.value[kbdIndex.value]);
    return true;
  }

  if (inField) return false;
  // 기본 동작을 막지 않고 포커스만 옮깁니다. 그러면 이 글자부터 입력칸에
  // 들어갑니다. 한글 입력기가 켜져 있으면 key가 'Process'로 옵니다.
  if ((e.key.length === 1 && e.key !== " ") || e.key === "Process") {
    openSearch();
    return true;
  }
  return false;
}

function onKeydown(e) {
  // Ctrl+1~8 로 탭 바로 가기, Ctrl+Tab 으로 다음 탭
  if (e.ctrlKey && !overlay.value && state.tabs.length) {
    if (e.key === "Tab") {
      e.preventDefault();
      const i = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const step = e.shiftKey ? -1 : 1;
      const next = (i + step + state.tabs.length) % state.tabs.length;
      state.activeTabId = state.tabs[next].id;
      return;
    }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= state.tabs.length) {
      e.preventDefault();
      state.activeTabId = state.tabs[n - 1].id;
      return;
    }
  }

  if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    openSearch();
    return;
  }

  if (onNavKey(e)) return;

  if (e.key !== "Escape") return;
  if (overlay.value) closeOverlay();
  else if (searching.value) closeSearch();
  else if (editing.value) editing.value = false;
  else if (kbdIndex.value >= 0) kbdIndex.value = -1;
  else if (state.settings.mode === "overlay") invoke("hide_window");
}

/* 옆 모니터로 끌어 옮기면 그 모니터를 기억하고 같은 배치 자리로 맞춥니다.
   위치 보정값은 모니터마다 기준점이 달라 그대로 쓸 수 없어서 0으로 돌립니다. */
let monitorTimer = null;

async function checkMonitorMove() {
  monitorTimer = null;
  if (placing) return;
  try {
    const now = await invoke("current_monitor_name");
    if (!now || now === area.value.monitor) return;
    state.settings.monitor = now;
    state.settings.offsets[state.settings.preset] = { x: 0, y: 0 };
    // applyLayout은 monitor가 바뀐 것을 보고 watch에서 돕니다.
    flash("이 모니터에 놓았습니다");
  } catch (e) {
    console.error("모니터 확인 실패", e);
  }
}

/* 하단 바에서 항목이 넘치면 휠로 옆으로 넘깁니다 (탭 바와 같은 방식). */
function onBodyWheel(e) {
  if (axis.value !== "horizontal") return;
  const el = e.currentTarget;
  if (el.scrollWidth <= el.clientWidth) return;
  e.preventDefault();
  el.scrollLeft += e.deltaY || e.deltaX;
}

/** 마우스를 쓰기 시작하면 키보드 선택 표시는 걷어냅니다. */
function onPointerDownAnywhere() {
  if (kbdIndex.value >= 0) kbdIndex.value = -1;
}

onMounted(async () => {
  // 창이 숨김 상태로 시작하므로, 초기화가 어디서 실패하든 창은 반드시 띄웁니다.
  try {
    await hydrate();
    applyTheme();
    applyOpacity();
    await applyLayout();
    await applyLayer();
    await applyShortcut();
    await applyAutostart();
  } catch (e) {
    console.error("초기화 중 오류", e);
  } finally {
    applied = fingerprint();
    ready.value = true;
    invoke("show_window").catch((e) => console.error(e));
  }

  checkPaths();
  prefetchAll();
  // 지운 항목의 캐시 PNG가 계속 쌓이지 않도록 시작할 때 한 번 치웁니다.
  pruneOrphans(state.tabs.flatMap((t) => t.items).map((it) => it.path));

  // 웹폰트가 늦게 뜨면 탭 이름 폭이 달라집니다. 독 폭을 그 뒤에 다시 잽니다.
  document.fonts?.ready.then(() => {
    if (fitBar.value) scheduleRelayout();
  });

  // 새 버전이 있으면 알려만 줍니다. 설치는 설정 창에서.
  pollUpdate();
  updateTimer = setInterval(pollUpdate, UPDATE_EVERY);

  if (loadFailure.value) {
    flash("설정을 읽지 못해 기본값으로 시작했습니다", {
      label: "원본 위치 열기",
      run: () => invoke("open_config_dir"),
    });
  }

  unlisteners.push(
    await getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;

      if (p.type === "enter" || p.type === "over") {
        // 드롭 직후에도 over가 한 번 더 들어옵니다. 그대로 두면 방금 닫은
        // 오버레이가 곧바로 다시 켜져서 목록이 가려집니다.
        if (overlay.value || Date.now() < dropGuardUntil) return;
        if (!dropActive.value) measureDropInset();
        dropActive.value = true;
        dragOverTab.value = tabAt(p.position);
        armDropWatchdog();
        return;
      }

      if (p.type === "leave") {
        endDrop();
        return;
      }
      if (p.type !== "drop") return;

      const target = tabAt(p.position) || state.activeTabId;
      endDrop();
      if (overlay.value) return;
      await registerPaths(p.paths, target);
    })
  );

  // 사용자가 창을 끌어 옮긴 만큼을 프리셋 보정값으로 기억합니다.
  unlisteners.push(
    await getCurrentWindow().onMoved(async ({ payload }) => {
      if (placing || overlay.value) return;
      // 끌기를 멈추면 어느 모니터에 놓였는지 봅니다 (checkMonitorMove)
      if (monitorTimer) clearTimeout(monitorTimer);
      monitorTimer = setTimeout(checkMonitorMove, 450);
      // 최소화되면 Windows가 창을 (-32000, -32000)으로 보냅니다. 끌어 옮긴 게
      // 아닌데 이걸 보정값으로 저장해서 하단 바가 왼쪽 위 구석에 붙었었습니다.
      if (payload.x <= -30000 || payload.y <= -30000) return;
      try {
        if (await getCurrentWindow().isMinimized()) return;
      } catch {
        /* 확인 못 하면 좌표 검사만 믿습니다 */
      }
      const scale = area.value.scale || 1;
      const next = {
        x: Math.round(payload.x / scale - basePos.value.x),
        y: Math.round(payload.y / scale - basePos.value.y),
      };
      if (!isSaneOffset(next)) return;
      const cur = state.settings.offsets[state.settings.preset];
      if (!cur || cur.x !== next.x || cur.y !== next.y) {
        state.settings.offsets[state.settings.preset] = next;
      }
    })
  );

  // 단축키로 불러냈을 때. 지난번 검색이나 선택이 남아 있으면 걷어냅니다.
  unlisteners.push(
    await listen("launcher://shown", () => {
      kbdIndex.value = -1;
      if (searching.value) closeSearch();
      window.focus();
    })
  );

  // 설정 창의 「위치 초기화」
  unlisteners.push(
    await listen("launcher://reset-position", async () => {
      state.settings.offsets[state.settings.preset] = { x: 0, y: 0 };
      await applyLayout();
      flash("처음 자리로 되돌렸습니다");
    })
  );

  // 설정 창에서 바꾼 값을 받습니다.
  // 적용은 아래 watch가 바뀐 것만 골라서 합니다.
  unlisteners.push(
    await listen("launcher://state-saved", () => rehydrate())
  );

  // 트레이 종료 등으로 앱이 끝나기 직전, 디바운스 중인 저장을 내보냅니다.
  unlisteners.push(
    await listen("launcher://before-quit", () => flushSave())
  );

  // 설정 창에서 「아이콘 새로 고침」을 누르면 이 창의 메모리 캐시도 비웁니다.
  unlisteners.push(
    await listen("launcher://update-state", (e) => {
      updateReady.value = e.payload || "";
    })
  );
  unlisteners.push(
    await listen("launcher://icons-cleared", () => {
      clearLocal();
      prefetchAll();
    })
  );

  // 모니터 · 해상도 · 배율 · 작업표시줄이 바뀌면 다시 배치합니다.
  // 연달아 들어오므로 한 번으로 묶습니다.
  unlisteners.push(
    await listen("launcher://display-changed", () => scheduleRelayout())
  );
  unlisteners.push(await getCurrentWindow().onScaleChanged(scheduleRelayout));

  // 사라진 항목 다시 확인 (recheckPaths 참고)
  unlisteners.push(
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) recheckPaths();
    })
  );
  unlisteners.push(await listen("launcher://shown", () => recheckPaths()));
  recheckTimer = setInterval(recheckPaths, RECHECK_EVERY);

  window.addEventListener("keydown", onKeydown);
  window.addEventListener("pointerdown", onPointerDownAnywhere, true);
  window.addEventListener("beforeunload", flushSave);
});

onBeforeUnmount(() => {
  if (dropWatchdog) clearTimeout(dropWatchdog);
  if (toastTimer) clearTimeout(toastTimer);
  if (relayoutTimer) clearTimeout(relayoutTimer);
  if (launchedTimer) clearTimeout(launchedTimer);
  if (recheckTimer) clearInterval(recheckTimer);
  unlisteners.forEach((un) => {
    try {
      un();
    } catch {
      /* 이미 해제됨 */
    }
  });
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pointerdown", onPointerDownAnywhere, true);
  window.removeEventListener("beforeunload", flushSave);
});

/* 이 창에서 바꿨든 설정 창에서 바꿨든 한 곳으로 모읍니다.
   applyChanged가 지문을 비교해 실제로 달라진 것만 적용합니다. */
watch(
  () => JSON.stringify(fingerprint()),
  () => ready.value && applyChanged()
);
</script>

<template>
  <div class="stage" :style="padStyle">
  <div
    class="panel"
    :data-preset="state.settings.preset"
    :data-mode="state.settings.mode"
    :data-axis="axis"
    :data-fit="fitBar ? '' : null"
    :class="{ ready, editing, 'drop-on': dropActive }"
    @contextmenu="showPanelMenu"
  >
    <!-- 탭 바 -->
    <header class="tabbar" :inert="overlay !== null" data-tauri-drag-region>
      <!-- 검색 중에는 탭 바 자리를 입력칸이 씁니다.
           입력칸은 늘 만들어 두고 감춰만 둡니다. 첫 글자를 누른 그 순간에
           포커스를 줘야 이어서 빠르게 친 글자(그리고 한글 첫 글자)가
           입력칸으로 들어갑니다. 그때 가서 만들면 앞 글자들이 버려집니다. -->
      <input
        ref="searchInput"
        :value="query"
        class="search-input"
        :class="{ standby: !searching }"
        :tabindex="searching ? 0 : -1"
        :aria-hidden="!searching"
        type="text"
        placeholder="이름으로 찾기"
        spellcheck="false"
        @input="query = $event.target.value"
        @keydown.escape.stop="closeSearch"
      />
      <template v-if="searching">
        <button class="head-btn" title="검색 끝내기" @click="closeSearch">
          닫기
        </button>
      </template>

      <template v-else>
      <TabBar
        :tabs="state.tabs"
        :active-id="state.activeTabId"
        :drop-target="dragOverTab"
        :renaming-id="renamingTabId"
        @select="state.activeTabId = $event"
        @menu="showTabMenu"
        @rename-start="startTabRename"
        @rename-commit="finishTabRename"
        @rename-cancel="cancelTabRename"
      />

      <button class="head-btn" title="찾기 (Ctrl+F)" @click="openSearch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
             v-html="UI_ICONS.search" />
      </button>

      <button
        v-if="editing"
        class="head-btn done"
        title="편집 끝내기"
        @click="editing = false"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             v-html="UI_ICONS.check" />
        완료
      </button>
      <button
        v-else
        class="head-btn"
        title="탭 추가"
        :disabled="state.tabs.length >= MAX_TABS"
        @click="onAddTab"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" v-html="UI_ICONS.plus" />
      </button>
      </template>
    </header>

    <!-- 항목 격자 -->
    <main class="body" :inert="overlay !== null" @wheel="onBodyWheel">
      <ItemGrid
        v-if="shown.length"
        :key="filtering ? 'search' : state.activeTabId"
        :items="shown"
        :columns="preset.cols"
        :cell-w="preset.cellW"
        :cell-h="cellHeight()"
        :icon-box="preset.iconBox"
        :name-max="preset.nameMax"
        :editing="editing && !filtering"
        :reorderable="!filtering"
        :show-names="state.settings.showNames"
        :missing="missing"
        :focus-id="focusId"
        :launched-id="launchedId"
        :renaming-id="renamingItemId"
        @open="openItem"
        @edit="openEditor"
        @menu="showItemMenu"
        @rename-commit="finishItemRename"
        @rename-cancel="cancelItemRename"
        @remove="onRemove"
        @move="onMove"
        @over-tab="dragOverTab = $event"
        @drop-on-tab="onDropOnTab"
        @hover="hoveredItem = $event"
        @reveal="revealItem"
      />
      <div v-else-if="filtering" class="no-match">
        <span><strong>{{ query }}</strong>에 맞는 항목이 없습니다</span>
      </div>
      <EmptyState
        v-else
        :tab-name="tab?.name || ''"
        :compact="axis === 'horizontal'"
        @browse="browseFiles"
      />
    </main>

    <!-- 푸터 -->
    <footer class="footer" :inert="overlay !== null">
      <span
        class="status"
        data-tauri-drag-region
        title="끌어다 놓아 추가 · 우클릭으로 메뉴(빈 곳: 여러 개 지우기 등) · 끌어서 순서 변경 · 글자를 치면 검색"
      >
        <template v-if="filtering">{{ matches.length }}개 찾음</template>
        <template v-else-if="searching">이름을 입력하세요</template>
        <template v-else-if="editing">✕로 삭제</template>
        <template v-else-if="items.length">{{ items.length }}개</template>
        <template v-else>끌어다 놓아 추가</template>
      </span>

      <button
        class="foot-btn"
        title="추가 — 파일 · 폴더 · 웹 링크 (창 위로 끌어다 놓아도 됩니다)"
        @click="showAddMenu"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" v-html="UI_ICONS.plus" />
        <span class="foot-label">추가</span>
      </button>
      <button
        class="foot-btn"
        :class="{ badge: updateReady }"
        :title="
          updateReady
            ? `새 버전 v${updateReady} 이 있습니다 — 설정에서 설치`
            : '설정 — 배치 · 모드 · 탭 편집 · 단축키'
        "
        @click="invoke('open_settings')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
             v-html="UI_ICONS.gear" />
        <span class="foot-label">설정</span>
      </button>
    </footer>

    <!-- 파일을 창 위로 가져왔을 때 -->
    <Transition name="fade">
      <div v-if="dropActive" class="drop" :style="dropInset">
        <div class="drop-inner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
               v-html="UI_ICONS.drop" />
          <span><strong>{{ dropTargetName }}</strong> 탭에 추가</span>
          <em v-if="state.tabs.length > 1 && !dragOverTab" class="drop-hint">
            다른 탭 이름 위에 놓으면 그 탭으로
          </em>
        </div>
      </div>
    </Transition>

    <!-- 알림 -->
    <Transition name="fade">
      <div v-if="toast.text" class="toast" :style="toastStyle">
        <span class="toast-text">{{ toast.text }}</span>
        <button v-if="toast.label" class="toast-action" @click="runToastAction">
          {{ toast.label }}
        </button>
      </div>
    </Transition>

  </div>
  </div>
</template>

<style scoped>
/* 창 안에서 그림자가 번질 자리. 여기는 투명하게 둡니다. */
.stage {
  height: 100%;
  width: 100%;
}

.panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgb(var(--panel) / var(--panel-alpha));
  border: 1px solid rgb(var(--line) / var(--line-alpha));
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
  opacity: 0;
  transition: opacity var(--dur-overlay) var(--ease),
    box-shadow var(--dur-overlay) var(--ease);
}
.panel.ready {
  opacity: 1;
}

/* 오버레이 모드는 그림자가 더 깊고 테두리가 한 단계 밝습니다 */
.panel[data-mode="overlay"] {
  box-shadow: var(--shadow-overlay);
  border-color: rgb(var(--line) / calc(var(--line-alpha) + 0.04));
}

/* 세로 패널은 우측 가장자리에 밀착하므로 좌측 모서리만 둥급니다 */
.panel[data-preset="right"] {
  border-radius: var(--radius-panel) 0 0 var(--radius-panel);
  border-right: 0;
}
.panel[data-preset="center"] {
  border-radius: var(--radius-box);
}

/* 하단 가로 바 — 같은 구조를 가로로 눕힙니다 */
.panel[data-axis="horizontal"] {
  flex-direction: row;
  align-items: stretch;
}

/* 파일을 끌어왔을 때 패널 테두리도 액센트로 */
.panel.drop-on {
  border-color: rgb(var(--accent) / 0.75);
  box-shadow: var(--shadow-overlay), 0 0 0 4px rgb(var(--accent) / 0.18);
}

/* ---- 탭 바 ------------------------------------------------------------ */

.tabbar {
  flex: 0 0 auto;
  display: flex;
  align-items: stretch;
  gap: var(--space-1);
  height: 41px;
  padding-right: var(--space-2);
  border-bottom: 1px solid rgb(var(--line) / var(--divider-alpha));
}
.tabbar :deep(.tabs) {
  flex: 1 1 auto;
}

.panel[data-axis="horizontal"] .tabbar {
  /* 탭이 8개여도 항목 영역을 먹지 않도록. 넘치면 탭 바가 먼저 스크롤됩니다. */
  flex: 0 1 auto;
  max-width: 34%;
  min-width: 0;
  height: auto;
  align-items: center;
  padding: 0 var(--space-2) 0 var(--space-1);
  border-bottom: 0;
  border-right: 1px solid rgb(var(--line) / var(--divider-alpha));
}

/* 하단 바 「항목에 맞춤」: 탭 바가 제 폭을 다 씁니다. 창 폭은 그만큼 잡습니다. */
.panel[data-fit] .tabbar {
  max-width: none;
}

.search-input {
  flex: 1 1 auto;
  min-width: 0;
  align-self: center;
  height: 26px;
  padding: 0 9px;
  border-radius: var(--radius-control);
  background: rgb(var(--tile) / var(--surface-alpha));
  border: 1px solid rgb(var(--accent) / 0.55);
  outline: none;
  font-size: var(--fs-caption);
}
/* 검색 전에는 자리만 차지하지 않게 감춰 둡니다. display:none이면
   포커스를 줄 수 없어서 투명 · 크기 0으로 둡니다. */
.search-input.standby {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  opacity: 0;
  pointer-events: none;
}
.search-input::placeholder {
  color: rgb(var(--text-faint));
}

.no-match {
  display: grid;
  place-items: center;
  height: 100%;
  padding: var(--space-4);
  text-align: center;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: rgb(var(--text-faint));
}
.no-match strong {
  color: rgb(var(--text-item));
  font-weight: 700;
}

.head-btn {
  flex: 0 0 auto;
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--radius-control);
  font-size: var(--fs-caption);
  font-weight: 500;
  color: rgb(var(--text-dim));
  transition: background var(--dur-hover) var(--ease),
    color var(--dur-hover) var(--ease);
}
.head-btn svg {
  width: 13px;
  height: 13px;
}
.head-btn:hover:not(:disabled) {
  background: rgb(var(--tile) / var(--surface-alpha-hover));
  color: rgb(var(--text));
}
.head-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.head-btn.done {
  color: rgb(var(--accent-ink));
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  font-weight: 700;
}

/* ---- 항목 영역 -------------------------------------------------------- */

.body {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: var(--grid-pad) var(--panel-pad);
  overflow-y: auto;
  overflow-x: hidden;
}

.panel[data-axis="horizontal"] .body {
  padding: 0 var(--panel-pad);
  display: flex;
  align-items: center;
  overflow-y: hidden;
  overflow-x: auto;
}
.panel[data-axis="horizontal"] .body > * {
  flex: 1 1 auto;
}

/* ---- 푸터 ------------------------------------------------------------- */

.footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: 45px;
  padding: 0 var(--space-2) 0 var(--space-4);
  border-top: 1px solid rgb(var(--line) / var(--divider-alpha));
}

.panel[data-axis="horizontal"] .footer {
  height: auto;
  padding: 0 var(--space-2);
  border-top: 0;
  border-left: 1px solid rgb(var(--line) / var(--divider-alpha));
}
.panel[data-axis="horizontal"] .status {
  display: none;
}

.status {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-caption);
  color: rgb(var(--text-faint));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: grab;
}
.status:active {
  cursor: grabbing;
}

/* ---- 드롭 영역 -------------------------------------------------------- */

.drop {
  position: absolute;
  inset: 0;
  z-index: 15;
  display: grid;
  place-items: center;
  padding: var(--space-3);
  /* 혹시 남더라도 클릭을 막지 않게 합니다 */
  pointer-events: none;
  /* 항목 격자를 26%로 죽이고 그 위에 점선 드롭존을 올립니다 */
  background: rgb(var(--panel) / 0.74);
}
.drop-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  height: 100%;
  border: 1.5px dashed rgb(var(--accent) / var(--drop-line-alpha));
  border-radius: var(--radius-tile);
  color: rgb(var(--accent-ink));
  font-size: var(--fs-caption);
  text-align: center;
}
.drop-inner svg {
  width: 22px;
  height: 22px;
}
.drop-inner strong {
  font-weight: 700;
}
.drop-hint {
  font-style: normal;
  color: rgb(var(--text-faint));
}
.panel[data-axis="horizontal"] .drop-inner {
  flex-direction: row;
  gap: var(--space-3);
}

/* ---- 알림 ------------------------------------------------------------- */

.foot-btn {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-control);
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
  transition: background var(--dur-hover) var(--ease),
    color var(--dur-hover) var(--ease);
}
.foot-btn svg {
  width: 15px;
  height: 15px;
}
.foot-btn:hover {
  background: rgb(var(--tile) / var(--surface-alpha-hover));
  color: rgb(var(--text));
}
/* 새 버전이 있을 때. 토스트는 사라지지만 이 점은 남습니다. */
.foot-btn.badge::after {
  content: "";
  position: absolute;
  top: 2px;
  right: 2px;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: rgb(var(--accent));
  box-shadow: 0 0 0 2px rgb(var(--panel));
}

/* 하단 가로 바는 자리가 좁아 아이콘만 남깁니다 */
.panel[data-axis="horizontal"] .foot-label {
  display: none;
}
.panel[data-axis="horizontal"] .foot-btn {
  padding: 0 5px;
}

.toast {
  position: absolute;
  left: 50%;
  bottom: 52px;
  transform: translateX(-50%);
  z-index: 18;
  max-width: calc(100% - 24px);
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  background: rgb(var(--panel-raise));
  border: 1px solid rgb(var(--line) / var(--line-alpha));
  box-shadow: var(--shadow-drag);
  font-size: var(--fs-caption);
  line-height: 1.4;
  color: rgb(var(--text));
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: calc(100% - 20px);
}
.toast-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toast-action {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-caption);
  font-weight: 700;
  color: rgb(var(--accent-ink));
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  transition: background var(--dur-hover) var(--ease);
}
.toast-action:hover {
  background: rgb(var(--accent) / calc(var(--accent-soft-alpha) * 2));
}
/* 하단 바에서는 마지막 항목 옆, 세로 가운데 (left는 placeToast가 줍니다) */
.panel[data-axis="horizontal"] .toast {
  top: 50%;
  bottom: auto;
  transform: translateY(-50%);
}
.panel[data-axis="horizontal"] .toast.fade-enter-from,
.panel[data-axis="horizontal"] .toast.fade-leave-to {
  transform: translateY(calc(-50% + 2px));
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--dur-overlay) var(--ease),
    transform var(--dur-overlay) var(--ease);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
  transform: translateY(2px);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur-overlay) var(--ease),
    transform var(--dur-overlay) var(--ease);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(2px);
}
.toast.fade-enter-from,
.toast.fade-leave-to {
  transform: translate(-50%, 2px);
}
</style>
