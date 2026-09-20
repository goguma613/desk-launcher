<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";

import TabBar from "./components/TabBar.vue";
import ItemGrid from "./components/ItemGrid.vue";
import EmptyState from "./components/EmptyState.vue";
import ItemEditor from "./components/ItemEditor.vue";
import Sheet from "./components/Sheet.vue";

import { UI_ICONS } from "./icons";
import { cellHeight, clamp, shadowPad, spec, windowSize } from "./layout";
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
const editingItem = ref(null);

const linkUrl = ref("");
const linkName = ref("");

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

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const t of state.tabs) {
    for (const it of t.items) {
      if (
        it.name.toLowerCase().includes(q) ||
        it.path.toLowerCase().includes(q)
      ) {
        out.push(it);
      }
    }
  }
  return out;
});

/** 격자에 실제로 그릴 목록 */
const shown = computed(() => (searching.value ? matches.value : items.value));

async function openSearch() {
  if (searching.value) return;
  searching.value = true;
  editing.value = false;
  await nextTick();
  searchInput.value?.focus();
}

function closeSearch() {
  searching.value = false;
  query.value = "";
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

function endDrop() {
  if (dropWatchdog) {
    clearTimeout(dropWatchdog);
    dropWatchdog = null;
  }
  dropActive.value = false;
  dropGuardUntil = Date.now() + 600;
}

let toastTimer = null;
const EMPTY_TOAST = { text: "", label: "", run: null };

/**
 * 알림. 두 번째 인자를 주면 「되돌리기」 같은 버튼이 함께 뜹니다.
 * 버튼이 있으면 읽고 누를 시간이 필요하므로 더 오래 남깁니다.
 */
function flash(text, action = null) {
  toast.value = { text, label: action?.label || "", run: action?.run || null };
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
    area.value = await invoke("work_area");
    const s = state.settings;
    const size = windowSize(
      area.value,
      searching.value ? matches.value.length : undefined
    );

    // 항목 편집 시트가 열려 있으면 최소한의 세로를 확보합니다.
    const height = overlay.value
      ? clamp(Math.max(size.height, 440), 200, area.value.height * 0.82)
      : size.height;

    const off = s.offsets[s.preset] || { x: 0, y: 0 };
    const placed = await invoke("place_window", {
      preset: s.preset,
      width: size.width,
      height,
      offX: off.x,
      offY: off.y,
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

let relayoutTimer = null;

/** 디스플레이 변경 이벤트는 몰려서 들어옵니다. 마지막 것 하나만 처리합니다. */
function scheduleRelayout() {
  if (relayoutTimer) clearTimeout(relayoutTimer);
  if (updateTimer) clearInterval(updateTimer);
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
    if (state.settings.autostart && !current) await enableAutostart();
    else if (!state.settings.autostart && current) await disableAutostart();
  } catch (e) {
    console.error("자동 실행 설정 실패", e);
  }
}

/* ---------------------------------------------------------------------------
   항목 조작
   --------------------------------------------------------------------------- */

function openItem(item) {
  invoke("launch", { path: item.path }).catch((e) => {
    flash(`실행하지 못했습니다: ${e}`);
  });
}

function onRemove(item) {
  const undo = removeItem(state.activeTabId, item.id);
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

/** 타일을 탭 위로 끌어다 놓아 옮깁니다. */
function onDropOnTab(tabId, item) {
  if (!item || tabId === state.activeTabId) return;
  const to = state.tabs.find((t) => t.id === tabId);
  if (!to) return;
  const from = state.tabs.find((t) =>
    t.items.some((it) => it.id === item.id)
  );
  if (!from) return;
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

async function registerPaths(paths) {
  if (!paths.length) return;
  try {
    const infos = await invoke("inspect_paths", { paths });
    const added = addItems(infos);
    const skipped = infos.length - added;
    if (added && skipped) flash(`${added}개 추가, ${skipped}개는 이미 있음`);
    else if (added) flash(`${added}개 추가했습니다`);
    else flash("이미 등록된 항목입니다");
    prefetch(infos.map((i) => i.path));
    checkPaths();
  } catch (e) {
    flash(`등록하지 못했습니다: ${e}`);
  }
}

/** 경로가 사라진 항목의 대상만 바꿉니다. 이름·아이콘은 그대로 둡니다. */
async function relocateItem() {
  const item = editingItem.value;
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

function openOverlay(kind, item = null) {
  editingItem.value = item;
  overlay.value = kind;
  // 편집하는 동안에는 설정 창이 저장해도 즉시 반영하지 않습니다.
  // 반영하면 지금 고치고 있는 값이 저장된 옛 값으로 되돌아갑니다.
  holdSync();
}

function openEditor(item) {
  // 검색 결과에서 열었다면 그 항목이 사는 탭으로 먼저 옮깁니다.
  // 안 그러면 삭제·이동이 엉뚱한 탭에 적용됩니다.
  const owner = state.tabs.find((t) =>
    t.items.some((it) => it.id === item.id)
  );
  if (owner && owner.id !== state.activeTabId) state.activeTabId = owner.id;
  if (searching.value) closeSearch();
  openOverlay("item", item);
}

async function closeOverlay() {
  const wasOpen = overlay.value !== null;
  overlay.value = null;
  editingItem.value = null;
  linkUrl.value = "";
  linkName.value = "";
  await flushSave();
  if (wasOpen) await releaseSync();
}

function removeEditingItem() {
  if (!editingItem.value) return;
  removeItem(state.activeTabId, editingItem.value.id);
  closeOverlay();
}

function moveItemToTab(targetTabId) {
  const item = editingItem.value;
  if (!item || targetTabId === state.activeTabId) return;
  const from = state.tabs.find((t) => t.id === state.activeTabId);
  const to = state.tabs.find((t) => t.id === targetTabId);
  if (!from || !to) return;
  const i = from.items.findIndex((it) => it.id === item.id);
  if (i < 0) return;
  const [moved] = from.items.splice(i, 1);
  to.items.push(moved);
  closeOverlay();
  flash(`${to.name} 탭으로 옮겼습니다`);
}

async function addLink() {
  let url = linkUrl.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    flash("주소 형식이 올바르지 않습니다");
    return;
  }

  const added = addItems([
    { path: url, name: linkName.value.trim() || host, isDir: false, ext: "" },
  ]);
  await closeOverlay();
  flash(added ? "링크를 추가했습니다" : "이미 있는 링크입니다");
}

function onAddTab() {
  if (state.tabs.length >= MAX_TABS) {
    flash(`탭은 최대 ${MAX_TABS}개까지입니다`);
    return;
  }
  addTab("새 탭");
}

/* ---------------------------------------------------------------------------
   경로 유효성 검사
   --------------------------------------------------------------------------- */

async function checkPaths() {
  const all = state.tabs
    .flatMap((t) => t.items)
    .filter((it) => it.kind !== "url");
  if (!all.length) {
    missing.value = new Set();
    return;
  }
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
    emptyTab: items.value.length === 0,
    itemCount: state.tabs.reduce((n, t) => n + t.items.length, 0),
    overlayOpen: overlay.value !== null,
    searching: searching.value,
    matchCount: searching.value ? matches.value.length : -1,
    paths: state.tabs
      .flatMap((t) => t.items.map((it) => it.path))
      .join(" "),
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

  if (e.key !== "Escape") return;
  if (overlay.value) closeOverlay();
  else if (searching.value) closeSearch();
  else if (editing.value) editing.value = false;
  else if (state.settings.mode === "overlay") invoke("hide_window");
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
        dropActive.value = true;
        armDropWatchdog();
        return;
      }

      if (p.type === "leave") {
        endDrop();
        return;
      }
      if (p.type !== "drop") return;

      endDrop();
      if (overlay.value) return;
      await registerPaths(p.paths);
    })
  );

  // 사용자가 창을 끌어 옮긴 만큼을 프리셋 보정값으로 기억합니다.
  unlisteners.push(
    await getCurrentWindow().onMoved(({ payload }) => {
      if (placing || overlay.value) return;
      const scale = area.value.scale || 1;
      const nx = Math.round(payload.x / scale - basePos.value.x);
      const ny = Math.round(payload.y / scale - basePos.value.y);
      const cur = state.settings.offsets[state.settings.preset];
      if (!cur || cur.x !== nx || cur.y !== ny) {
        state.settings.offsets[state.settings.preset] = { x: nx, y: ny };
      }
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

  window.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", flushSave);
});

onBeforeUnmount(() => {
  if (dropWatchdog) clearTimeout(dropWatchdog);
  if (toastTimer) clearTimeout(toastTimer);
  if (relayoutTimer) clearTimeout(relayoutTimer);
  unlisteners.forEach((un) => {
    try {
      un();
    } catch {
      /* 이미 해제됨 */
    }
  });
  window.removeEventListener("keydown", onKeydown);
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
    :class="{ ready, editing, 'drop-on': dropActive }"
  >
    <!-- 탭 바 -->
    <header class="tabbar" :inert="overlay !== null" data-tauri-drag-region>
      <!-- 검색 중에는 탭 바 자리를 입력칸이 씁니다 -->
      <template v-if="searching">
        <input
          ref="searchInput"
          v-model="query"
          class="search-input"
          type="text"
          placeholder="이름으로 찾기"
          spellcheck="false"
          @keydown.escape="closeSearch"
        />
        <button class="head-btn" title="검색 끝내기" @click="closeSearch">
          닫기
        </button>
      </template>

      <template v-else>
      <TabBar
        :tabs="state.tabs"
        :active-id="state.activeTabId"
        :drop-target="dragOverTab"
        @select="state.activeTabId = $event"
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
    <main class="body" :inert="overlay !== null">
      <ItemGrid
        v-if="shown.length"
        :key="searching ? 'search' : state.activeTabId"
        :items="shown"
        :columns="preset.cols"
        :cell-w="preset.cellW"
        :cell-h="cellHeight()"
        :icon-box="preset.iconBox"
        :name-max="preset.nameMax"
        :editing="editing && !searching"
        :show-names="state.settings.showNames"
        :missing="missing"
        @open="openItem"
        @edit="openEditor"
        @remove="onRemove"
        @move="onMove"
        @over-tab="dragOverTab = $event"
        @drop-on-tab="onDropOnTab"
      />
      <div v-else-if="searching" class="no-match">
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
      <span class="status" data-tauri-drag-region>
        <template v-if="searching">
          {{ matches.length }}개 찾음
        </template>
        <template v-else-if="editing">끌어서 순서 변경 · 눌러서 이름 수정</template>
        <template v-else-if="items.length">
          {{ items.length }}개 · 끌어다 놓아 추가
        </template>
        <template v-else>끌어다 놓아 추가</template>
      </span>

      <button
        v-if="editing"
        class="icon-btn"
        title="웹 링크 추가"
        @click="openOverlay('link')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" v-html="UI_ICONS.plus" />
      </button>
      <button
        class="foot-btn"
        :class="{ on: editing }"
        :title="editing ? '편집 끝내기' : '편집 — 삭제 · 순서 변경 · 이름 수정'"
        @click="editing = !editing"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
             v-html="UI_ICONS.pencil" />
        <span class="foot-label">편집</span>
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
      <div v-if="dropActive" class="drop">
        <div class="drop-inner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
               v-html="UI_ICONS.drop" />
          <span><strong>{{ tab?.name }}</strong> 탭에 추가</span>
        </div>
      </div>
    </Transition>

    <!-- 알림 -->
    <Transition name="fade">
      <div v-if="toast.text" class="toast">
        <span class="toast-text">{{ toast.text }}</span>
        <button v-if="toast.label" class="toast-action" @click="runToastAction">
          {{ toast.label }}
        </button>
      </div>
    </Transition>

    <!-- 항목 편집 -->
    <Transition name="sheet">
    <ItemEditor
      v-if="overlay === 'item' && editingItem"
      :item="editingItem"
      :tabs="state.tabs"
      :current-tab-id="state.activeTabId"
      :missing="missing.has(editingItem.id)"
      @close="closeOverlay"
      @remove="removeEditingItem"
      @move-to-tab="moveItemToTab"
      @relocate="relocateItem"
    />

    <Sheet v-else-if="overlay === 'link'" title="웹 링크 추가" @close="closeOverlay">
      <section>
        <label class="field-label" for="link-url">주소</label>
        <input
          id="link-url"
          v-model="linkUrl"
          class="text-input"
          type="text"
          placeholder="example.com"
          spellcheck="false"
          @keydown.enter="addLink"
        />
      </section>
      <section>
        <label class="field-label" for="link-name">이름</label>
        <input
          id="link-name"
          v-model="linkName"
          class="text-input"
          type="text"
          maxlength="60"
          placeholder="비워두면 주소에서 가져옵니다"
          @keydown.enter="addLink"
        />
      </section>
      <template #footer>
        <button class="btn" @click="closeOverlay">취소</button>
        <button class="btn primary" @click="addLink">추가</button>
      </template>
    </Sheet>
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
.foot-btn.on {
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  color: rgb(var(--accent-ink));
  font-weight: 700;
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
.panel[data-axis="horizontal"] .toast {
  bottom: 10px;
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
