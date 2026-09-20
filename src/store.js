import { reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";

export const SCHEMA_VERSION = 1;

let counter = 0;
export function uid(prefix = "i") {
  counter += 1;
  return prefix + Date.now().toString(36) + counter.toString(36);
}

/* ---------------------------------------------------------------------------
   기본값
   --------------------------------------------------------------------------- */

export function defaultSettings() {
  return {
    preset: "right", // right | bottom | center
    mode: "desktop", // desktop(맨 아래) | overlay(항상 위)
    theme: "dark", // dark | light
    shortcut: "Alt+Space",
    autostart: false,
    showNames: true,
    // 시안 기준 다크 .96 / 라이트 .97. 설정에서 조절합니다.
    opacity: 0.96,
    // 프리셋 기본 위치에서 사용자가 끌어 옮긴 만큼의 보정값
    offsets: {
      right: { x: 0, y: 0 },
      bottom: { x: 0, y: 0 },
      center: { x: 0, y: 0 },
    },
  };
}

function defaultTabs() {
  return [
    { id: uid("t"), name: "게임", items: [] },
    { id: uid("t"), name: "유틸", items: [] },
    { id: uid("t"), name: "브라우저", items: [] },
  ];
}

function defaultState() {
  const tabs = defaultTabs();
  return {
    version: SCHEMA_VERSION,
    settings: defaultSettings(),
    tabs,
    activeTabId: tabs[0].id,
  };
}

export const state = reactive(defaultState());

/* ---------------------------------------------------------------------------
   항목 모델
   ---------------------------------------------------------------------------
   {
     id:   string
     name: string          표시 이름 (사용자가 수정 가능)
     path: string          실행 대상. 파일/폴더 경로 또는 http(s) URL
     kind: 'app'|'file'|'folder'|'url'
     ext:  string          소문자 확장자, 점 없음
     icon: { type: 'auto'|'builtin'|'image', value: string }
   }
   icon.type
     auto    - 확장자로 추론, 못 찾으면 이름 첫 글자
     builtin - value = BUILTIN_ICONS 키
     image   - value = data URL (사용자가 고른 이미지)
   웹링크는 파비콘을 자동으로 시도하고 실패하면 link 아이콘으로 떨어집니다.
   --------------------------------------------------------------------------- */

export function makeItem(info) {
  const isUrl = /^https?:\/\//.test(info.path);
  let kind = "file";
  if (isUrl) kind = "url";
  else if (info.isDir) kind = "folder";
  else if (["exe", "lnk", "bat", "cmd", "msi", "com"].includes(info.ext)) kind = "app";

  return {
    id: uid("i"),
    name: info.name || info.path,
    path: info.path,
    kind,
    ext: info.ext || "",
    icon: { type: "auto", value: "" },
  };
}

/* ---------------------------------------------------------------------------
   탭 / 항목 조작
   --------------------------------------------------------------------------- */

export function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0];
}

export function addItems(infos, tabId = state.activeTabId) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return 0;

  let added = 0;
  for (const info of infos) {
    // 같은 탭 안의 중복은 건너뜁니다.
    if (tab.items.some((it) => it.path === info.path)) continue;
    tab.items.push(makeItem(info));
    added += 1;
  }
  return added;
}

/** 지운 항목과 위치를 돌려줍니다. 되돌리기에 씁니다. */
export function removeItem(tabId, itemId) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  const index = tab.items.findIndex((it) => it.id === itemId);
  if (index < 0) return null;
  const [item] = tab.items.splice(index, 1);
  return { tabId, index, item };
}

/** removeItem이 돌려준 것을 원래 자리에 다시 끼웁니다. */
export function restoreItem(undo) {
  if (!undo) return false;
  const tab = state.tabs.find((t) => t.id === undo.tabId);
  if (!tab) return false;
  if (tab.items.some((it) => it.id === undo.item.id)) return false;
  tab.items.splice(Math.min(undo.index, tab.items.length), 0, undo.item);
  return true;
}

export function moveItem(tabId, from, to) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (from === to || from < 0 || from >= tab.items.length) return;
  const clamped = Math.max(0, Math.min(to, tab.items.length - 1));
  const [moved] = tab.items.splice(from, 1);
  tab.items.splice(clamped, 0, moved);
}

/** 탭 최대 개수. 시안이 3~8개를 전제로 설계됐습니다. */
export const MAX_TABS = 8;

export function addTab(name = "새 탭") {
  // UI 두 곳에서 각각 막는 것만으로는 부족합니다. 두 창에서 동시에 추가하거나
  // 설정 파일을 직접 고치면 넘어갑니다.
  if (state.tabs.length >= MAX_TABS) return null;
  const tab = { id: uid("t"), name, items: [] };
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  return tab;
}

export function removeTab(tabId) {
  if (state.tabs.length <= 1) return false;
  const i = state.tabs.findIndex((t) => t.id === tabId);
  if (i < 0) return false;
  state.tabs.splice(i, 1);
  if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs[Math.min(i, state.tabs.length - 1)].id;
  }
  return true;
}

export function moveTab(from, to) {
  if (to < 0 || to >= state.tabs.length || from === to) return;
  const [moved] = state.tabs.splice(from, 1);
  state.tabs.splice(to, 0, moved);
}

/* ---------------------------------------------------------------------------
   영속화
   --------------------------------------------------------------------------- */

function mergeSettings(saved) {
  const base = defaultSettings();
  if (!saved || typeof saved !== "object") return base;
  return {
    ...base,
    ...saved,
    offsets: {
      right: { ...base.offsets.right, ...(saved.offsets?.right || {}) },
      bottom: { ...base.offsets.bottom, ...(saved.offsets?.bottom || {}) },
      center: { ...base.offsets.center, ...(saved.offsets?.center || {}) },
    },
  };
}

function normalizeTabs(saved) {
  if (!Array.isArray(saved) || saved.length === 0) return defaultTabs();
  return saved.map((tab) => ({
    id: tab.id || uid("t"),
    name: typeof tab.name === "string" && tab.name.trim() ? tab.name : "탭",
    items: Array.isArray(tab.items)
      ? tab.items
          .filter((it) => it && typeof it.path === "string")
          .map((it) => ({
            id: it.id || uid("i"),
            name: it.name || it.path,
            path: it.path,
            kind: it.kind || "file",
            ext: it.ext || "",
            icon:
              it.icon && typeof it.icon === "object"
                ? { type: it.icon.type || "auto", value: it.icon.value || "" }
                : { type: "auto", value: "" },
          }))
      : [],
  }));
}

let hydrated = false;
let saveTimer = null;
let lastSaved = "";

/** 설정을 읽지 못해 기본값으로 시작한 경우, 원본을 옮겨둔 경로 */
export const loadFailure = ref("");

function snapshot() {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    settings: state.settings,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  });
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const data = snapshot();
    if (data === lastSaved) return;
    try {
      await invoke("save_state", { data });
      lastSaved = data;
    } catch (e) {
      console.error("저장 실패", e);
    }
  }, 350);
}

/** 창을 닫기 직전 등, 지금 당장 저장해야 할 때 */
export async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const data = snapshot();
  if (data === lastSaved) return;
  try {
    await invoke("save_state", { data });
    lastSaved = data;
  } catch (e) {
    console.error("저장 실패", e);
  }
}

/**
 * 읽어온 내용을 **id 기준으로 기존 객체에 병합**합니다.
 *
 * 통째로 갈아끼우면 안 됩니다. 편집 시트가 붙들고 있는 항목 객체나 입력칸의
 * v-model 바인딩이 끊겨서, 화면에는 입력되는 것처럼 보이는데 실제로는 버려진
 * 객체에 쓰이게 됩니다.
 */
function applyLoaded(parsed) {
  Object.assign(state.settings, mergeSettings(parsed.settings));

  const incoming = normalizeTabs(parsed.tabs).slice(0, MAX_TABS);
  const tabById = new Map(state.tabs.map((t) => [t.id, t]));

  state.tabs = incoming.map((inc) => {
    const tab = tabById.get(inc.id);
    if (!tab) return inc;

    tab.name = inc.name;

    const itemById = new Map(tab.items.map((it) => [it.id, it]));
    tab.items = inc.items.map((incItem) => {
      const item = itemById.get(incItem.id);
      if (!item) return incItem;
      item.name = incItem.name;
      item.path = incItem.path;
      item.kind = incItem.kind;
      item.ext = incItem.ext;
      if (
        item.icon.type !== incItem.icon.type ||
        item.icon.value !== incItem.icon.value
      ) {
        item.icon = incItem.icon;
      }
      return item;
    });
    return tab;
  });

  if (parsed.activeTabId && state.tabs.some((t) => t.id === parsed.activeTabId)) {
    state.activeTabId = parsed.activeTabId;
  } else if (!state.tabs.some((t) => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0].id;
  }
}

export async function hydrate() {
  try {
    const raw = await invoke("load_state");
    if (raw) {
      const parsed = JSON.parse(raw);
      // 미래 버전 파일을 낮은 버전으로 해석해 덮어쓰지 않습니다.
      if (typeof parsed.version === "number" && parsed.version > SCHEMA_VERSION) {
        throw new Error(
          `더 새로운 버전의 설정입니다 (v${parsed.version}). 앱을 업데이트하세요.`
        );
      }
      applyLoaded(parsed);
    }
  } catch (e) {
    console.error("설정을 불러오지 못했습니다. 기본값으로 시작합니다.", e);
    // 원본을 덮어쓰기 전에 옆으로 치워 둡니다. 안 그러면 창을 한 번 움직이는
    // 것만으로 손상된 원본이 기본값으로 덮어써져 영구 유실됩니다.
    try {
      const moved = await invoke("quarantine_state");
      if (moved) loadFailure.value = moved;
    } catch (err) {
      console.error("원본을 보존하지 못했습니다", err);
    }
  }

  if (!state.tabs.some((t) => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0].id;
  }

  lastSaved = snapshot();
  hydrated = true;

  watch(state, () => {
    if (hydrated) scheduleSave();
  }, { deep: true });
}

/* ---------------------------------------------------------------------------
   창 간 동기화 보류
   ---------------------------------------------------------------------------
   입력칸에 포커스가 있거나 편집 시트가 열려 있는 동안에는 다른 창이 저장해도
   즉시 반영하지 않습니다. 반영하면 타이핑하던 값이 되돌아갑니다.
   --------------------------------------------------------------------------- */

let syncHolds = 0;
let syncPending = false;

export function holdSync() {
  syncHolds += 1;
}

export async function releaseSync() {
  syncHolds = Math.max(0, syncHolds - 1);
  if (syncHolds === 0 && syncPending) {
    syncPending = false;
    await rehydrate();
  }
}

/**
 * 다른 창이 저장한 내용을 받아 적용합니다.
 *
 * 아직 내보내지 못한 로컬 변경이 있으면 그쪽이 더 최신이므로, 먼저 저장하고
 * 들어온 내용은 버립니다. 내 저장이 상대 창에 다시 전달되어 결국 수렴합니다.
 */
export async function rehydrate() {
  if (syncHolds > 0) {
    syncPending = true;
    return;
  }
  if (saveTimer) {
    await flushSave();
    return;
  }

  try {
    const raw = await invoke("load_state");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.version === "number" && parsed.version > SCHEMA_VERSION) {
      return;
    }

    hydrated = false;
    applyLoaded(parsed);
    lastSaved = snapshot();
  } catch (e) {
    console.error("설정을 다시 읽지 못했습니다", e);
  } finally {
    hydrated = true;
  }
}
