<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";

import ShortcutInput from "./components/ShortcutInput.vue";
import ItemEditor from "./components/ItemEditor.vue";
import Sheet from "./components/Sheet.vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { UI_ICONS } from "./icons";
import { PRESETS, MODES } from "./layout";
import {
  state,
  hydrate,
  rehydrate,
  flushSave,
  holdSync,
  releaseSync,
  addTab,
  removeTab,
  moveTab,
  addItems,
  removeItem,
  MAX_TABS,
} from "./store";
import { prefetch, refreshAll } from "./extractedIcons";
import { getVersion } from "@tauri-apps/api/app";
import { findUpdate } from "./updater";

const ready = ref(false);
/** 'main' | 'tabs' | 'item'(항목 편집) | 'link'(웹 링크 추가) */
const view = ref("main");
const confirmTabId = ref("");
const busy = ref("");
const version = ref("");

/* 업데이트 — GitHub Releases */
const update = ref(null); // { version, notes, install }
/** "" | "checking" | "none" | "found" | "installing" | 에러 문구 */
const updateState = ref("");

/** 결과를 런처 창에도 알려 톱니 표시점을 맞춥니다. */
function shareUpdateState(v) {
  emit("launcher://update-state", v || "");
}

async function checkForUpdate() {
  updateState.value = "checking";
  update.value = null;
  try {
    const found = await findUpdate();
    update.value = found;
    updateState.value = found ? "found" : "none";
    shareUpdateState(found ? found.version : "");
  } catch (e) {
    updateState.value = `확인하지 못했습니다: ${e}`;
  }
}

const updateFailed = computed(
  () => !!updateState.value && !["checking", "none", "found", "installing"].includes(updateState.value)
);
const updateTitle = computed(() =>
  updateFailed.value ? updateState.value : "눌러서 업데이트 확인"
);

async function installUpdate() {
  if (!update.value) return;
  updateState.value = "installing";
  try {
    await flushSave();
    await update.value.install();
  } catch (e) {
    updateState.value = `설치하지 못했습니다: ${e}`;
  }
}

const presetHint = computed(
  () => PRESETS.find((p) => p.key === state.settings.preset)?.hint || ""
);
const modeHint = computed(
  () => MODES.find((m) => m.key === state.settings.mode)?.hint || ""
);
/** 단축키가 하는 일은 모드마다 달라서 지금 모드의 설명만 보여 줍니다. */
const shortcutHint = computed(() =>
  state.settings.mode === "overlay"
    ? "패널을 켜고 끕니다."
    : "맨 아래 깔린 패널을 앞으로 불러냅니다. 한 번 더 누르거나 다른 곳을 클릭하면 제자리로 돌아갑니다."
);
const itemCount = computed(() =>
  state.tabs.reduce((n, t) => n + t.items.length, 0)
);

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
}
function applyOpacity() {
  document.documentElement.style.setProperty(
    "--panel-alpha",
    String(state.settings.opacity)
  );
}

/* ---------------------------------------------------------------------------
   탭 편집 — 드래그 핸들로 순서 변경
   --------------------------------------------------------------------------- */

const rowsEl = ref(null);
const drag = reactive({ active: false, from: -1, to: -1 });

function rowEls() {
  return rowsEl.value ? Array.from(rowsEl.value.querySelectorAll(".tab-row")) : [];
}

function onHandleDown(e, index) {
  if (e.button !== 0) return;
  drag.from = index;
  drag.to = index;
  drag.active = true;
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* 캡처 실패해도 동작에는 지장 없음 */
  }
  window.addEventListener("pointermove", onHandleMove);
  window.addEventListener("pointerup", onHandleUp, { once: true });
  window.addEventListener("pointercancel", onHandleUp, { once: true });
}

function onHandleMove(e) {
  if (!drag.active) return;
  let best = drag.to;
  let bestDist = Infinity;
  rowEls().forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const d = Math.abs(e.clientY - (r.top + r.height / 2));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  drag.to = best;
}

function onHandleUp() {
  window.removeEventListener("pointermove", onHandleMove);
  window.removeEventListener("pointerup", onHandleUp);
  window.removeEventListener("pointercancel", onHandleUp);
  if (drag.active && drag.to !== drag.from && drag.to >= 0) {
    moveTab(drag.from, drag.to);
  }
  drag.active = false;
  drag.from = -1;
  drag.to = -1;
}

/* ---------------------------------------------------------------------------
   동작
   --------------------------------------------------------------------------- */

function onAddTab() {
  if (state.tabs.length >= MAX_TABS) return;
  addTab("새 탭");
}

function onRemoveTab(id) {
  removeTab(id);
  confirmTabId.value = "";
}

async function openConfigDir() {
  try {
    await invoke("open_config_dir");
  } catch (e) {
    console.error(e);
  }
}

async function refreshIcons() {
  busy.value = "아이콘을 다시 뽑는 중…";
  try {
    await refreshAll();
    busy.value = "아이콘을 새로 뽑았습니다";
  } catch (e) {
    busy.value = `실패: ${e}`;
  }
  setTimeout(() => (busy.value = ""), 2200);
}

/** 끌어 옮긴 위치를 지우고 배치 기본 자리로 돌립니다. 런처 창이 처리합니다. */
function resetPosition() {
  emitTo("main", "launcher://reset-position").catch((e) => console.error(e));
}

/* ---------------------------------------------------------------------------
   모니터
   --------------------------------------------------------------------------- */

const monitors = ref([]);

async function loadMonitors() {
  try {
    monitors.value = await invoke("list_monitors");
  } catch {
    monitors.value = [];
  }
}

/**
 * 실제 모니터만 보여 줍니다. 「주 모니터」 선택지를 따로 두면 주 모니터와 같은
 * 화면을 가리키는 버튼이 둘이 됩니다.
 *
 * 주 모니터를 고르면 이름 대신 ""을 저장해 주 모니터가 바뀔 때 따라갑니다.
 * 저장된 모니터가 지금 연결돼 있지 않으면 런처는 주 모니터에 뜨므로 그쪽을 켭니다.
 */
function monitorOn(m) {
  const want = state.settings.monitor;
  if (want === m.name) return true;
  return m.primary && !monitors.value.some((x) => x.name === want);
}
function pickMonitor(m) {
  state.settings.monitor = m.primary ? "" : m.name;
}

/** \\.\DISPLAY2 → 「모니터 2」 */
function monitorLabel(m, i) {
  const n = (m.name.match(/(\d+)\s*$/) || [])[1] || String(i + 1);
  return `모니터 ${n}`;
}

/* ---------------------------------------------------------------------------
   항목 편집 · 웹 링크 추가 — 런처가 요청해서 열 때
   ---------------------------------------------------------------------------
   런처 안에 시트로 띄우면 하단 가로 바가 시트를 담느라 위로 크게 늘어났습니다.
   설정 창은 별도 창이라 여기서 열면 런처 크기가 그대로입니다.
   요청으로 열었으면 끝낼 때 창도 닫아 런처로 바로 돌아가게 합니다.
   --------------------------------------------------------------------------- */

const editId = ref("");
const editMissing = ref(false);
const editOwner = computed(
  () => state.tabs.find((t) => t.items.some((it) => it.id === editId.value)) || null
);
const editItem = computed(
  () => editOwner.value?.items.find((it) => it.id === editId.value) || null
);

const linkTabId = ref("");
const linkUrl = ref("");
const linkName = ref("");
const linkError = ref("");

let openedByRequest = false;

async function applyRequest(req) {
  confirmTabId.value = "";
  openedByRequest = false;

  if (req && req.view === "item" && req.id) {
    editId.value = req.id;
    if (!editItem.value) {
      view.value = "main";
      return;
    }
    view.value = "item";
    openedByRequest = true;
    // 고치는 동안 런처가 저장해도 덮어쓰지 않도록 (store.holdSync 참고)
    holdSync();
    editMissing.value = false;
    const item = editItem.value;
    prefetch([item.path]);
    if (item.kind !== "url") {
      try {
        const [info] = await invoke("inspect_paths", { paths: [item.path] });
        editMissing.value = !info.exists;
      } catch {
        /* 확인 못 하면 표시하지 않습니다 */
      }
    }
    return;
  }

  if (req && req.view === "link") {
    linkTabId.value = state.tabs.some((t) => t.id === req.tabId)
      ? req.tabId
      : state.activeTabId;
    linkUrl.value = "";
    linkName.value = "";
    linkError.value = "";
    view.value = "link";
    openedByRequest = true;
    await nextTick();
    document.getElementById("link-url")?.focus();
    return;
  }

  view.value = "main";
}

async function finishRequest() {
  const closeAfter = openedByRequest;
  const wasEditing = view.value === "item";
  openedByRequest = false;
  await flushSave();
  if (wasEditing) await releaseSync();
  editId.value = "";
  view.value = "main";
  if (closeAfter) invoke("close_settings");
}

function onEditRemove() {
  const owner = editOwner.value;
  if (owner) removeItem(owner.id, editId.value);
  finishRequest();
}

function onEditMove(tabId) {
  const from = editOwner.value;
  const to = state.tabs.find((t) => t.id === tabId);
  const item = editItem.value;
  if (!from || !to || !item || from.id === to.id) return;
  if (to.items.some((it) => it.path === item.path)) return;
  from.items.splice(from.items.indexOf(item), 1);
  to.items.push(item);
  finishRequest();
}

/** 경로가 사라진 항목의 대상만 바꿉니다. 이름 · 아이콘은 그대로 둡니다. */
async function onEditRelocate() {
  const item = editItem.value;
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
    editMissing.value = !info.exists;
    prefetch([info.path]);
  } catch (e) {
    console.error("경로 바꾸기 실패", e);
  }
}

async function addLinkFromSettings() {
  linkError.value = "";
  let url = linkUrl.value.trim();
  if (!url) {
    linkError.value = "주소를 입력하세요";
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    linkError.value = "주소 형식이 올바르지 않습니다";
    return;
  }
  const added = addItems(
    [{ path: url, name: linkName.value.trim() || host, isDir: false, ext: "" }],
    linkTabId.value
  );
  if (!added) {
    linkError.value = "이 탭에 이미 있는 링크입니다";
    return;
  }
  await finishRequest();
}

async function close() {
  if (view.value === "item") await releaseSync();
  openedByRequest = false;
  editId.value = "";
  flushSave().finally(() => invoke("close_settings"));
}

const confirmQuit = ref(false);

function quitLauncher() {
  // 디바운스 중인 변경을 먼저 내보내고 끕니다.
  flushSave().finally(() => invoke("quit_app"));
}

/* ---------------------------------------------------------------------------
   생명주기
   --------------------------------------------------------------------------- */

const unlisteners = [];

/* 입력칸을 만지는 동안 다른 창이 저장하면, 반영하는 순간 타이핑하던 값이
   되돌아갑니다. 포커스가 빠질 때까지 미룹니다. */
function isField(el) {
  return el && el.matches && el.matches("input, select, textarea");
}
function onFocusIn(e) {
  if (isField(e.target)) holdSync();
}
function onFocusOut(e) {
  if (isField(e.target)) releaseSync();
}

onMounted(async () => {
  // 창이 투명해서, 여기서 막히면 화면이 통째로 안 보입니다. 무슨 일이 있어도
  // ready는 켭니다.
  try {
    await hydrate();
    applyTheme();
    applyOpacity();
  } catch (e) {
    console.error("설정 창 초기화 실패", e);
  } finally {
    ready.value = true;
  }

  // 두 PC의 버전이 어긋났는지 한눈에 보이도록
  getVersion()
    .then((v) => (version.value = v))
    .catch(() => {});

  checkForUpdate();
  loadMonitors();

  unlisteners.push(
    await listen("launcher://state-saved", async () => {
      await rehydrate();
      applyTheme();
      applyOpacity();
    })
  );

  // 창은 닫히지 않고 숨겨졌다가 다시 뜹니다. 열 때마다 첫 화면으로.
  unlisteners.push(
    await listen("launcher://settings-shown", async (e) => {
      await rehydrate();
      applyTheme();
      applyOpacity();
      // 런처가 특정 화면(항목 편집 · 링크 추가)을 요청했으면 그 화면으로
      await applyRequest(e.payload);
      loadMonitors();
      // 열면 이미 결과가 나와 있게. 「확인」을 누를 필요가 없습니다.
      checkForUpdate();
    })
  );

  unlisteners.push(
    await listen("launcher://before-quit", () => flushSave())
  );

  window.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", flushSave);
  window.addEventListener("focusin", onFocusIn);
  window.addEventListener("focusout", onFocusOut);
});

function onKeydown(e) {
  if (e.key !== "Escape") return;
  if (view.value === "tabs") view.value = "main";
  else if (view.value === "item" || view.value === "link") finishRequest();
  else close();
}

onBeforeUnmount(() => {
  unlisteners.forEach((un) => {
    try {
      un();
    } catch {
      /* 이미 해제됨 */
    }
  });
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("beforeunload", flushSave);
  window.removeEventListener("focusin", onFocusIn);
  window.removeEventListener("focusout", onFocusOut);
});

watch(() => state.settings.theme, applyTheme);
watch(() => state.settings.opacity, applyOpacity);
</script>

<template>
  <div class="win" :class="{ ready }">
    <header class="titlebar" data-tauri-drag-region>
      <button
        v-if="view === 'tabs'"
        class="icon-btn"
        title="뒤로"
        @click="view = 'main'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
             v-html="UI_ICONS.back" />
      </button>
      <h1>{{ view === "tabs" ? "탭 편집" : "런처 설정" }}</h1>
      <button class="icon-btn" title="닫기" @click="close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" v-html="UI_ICONS.close" />
      </button>
    </header>

    <!-- ===================== 설정 본문 ===================== -->
    <div v-if="view === 'main'" class="content">
      <!-- 화면 — 배치 · 바 폭 · 모니터 · 표시 모드를 「이름 | 선택지」 한 줄씩 -->
      <section>
        <span class="field-label">화면</span>

        <div class="seg-row">
          <span class="seg-label">배치</span>
          <div class="seg">
            <button
              v-for="p in PRESETS"
              :key="p.key"
              :class="{ on: state.settings.preset === p.key }"
              @click="state.settings.preset = p.key"
            >
              <span class="shape" :data-shape="p.key" aria-hidden="true"><i></i></span>
              {{ p.label }}
            </button>
          </div>
        </div>
        <p class="seg-hint">{{ presetHint }}</p>

        <div v-if="state.settings.preset === 'bottom'" class="seg-row">
          <span class="seg-label">바 폭</span>
          <div class="seg">
            <button
              :class="{ on: !state.settings.barFit }"
              @click="state.settings.barFit = false"
            >
              화면 전체
            </button>
            <button
              :class="{ on: state.settings.barFit }"
              title="항목 수에 맞춘 폭으로 가운데에 놓습니다"
              @click="state.settings.barFit = true"
            >
              항목에 맞춤
            </button>
          </div>
        </div>

        <div v-if="monitors.length > 1" class="seg-row">
          <span class="seg-label">모니터</span>
          <div class="seg">
            <button
              v-for="(m, i) in monitors"
              :key="m.name"
              :class="{ on: monitorOn(m) }"
              :title="m.primary ? '주 모니터 — 주 모니터가 바뀌면 따라갑니다' : ''"
              @click="pickMonitor(m)"
            >
              {{ monitorLabel(m, i) }}<template v-if="m.primary"> · 주</template>
              <em>{{ m.width }}×{{ m.height }}</em>
            </button>
          </div>
        </div>

        <div class="seg-row">
          <span class="seg-label">표시 모드</span>
          <div class="seg">
            <button
              v-for="m in MODES"
              :key="m.key"
              :class="{ on: state.settings.mode === m.key }"
              @click="state.settings.mode = m.key"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <p class="seg-hint">{{ modeHint }}</p>

        <div class="seg-row">
          <span class="seg-label">위치</span>
          <button
            class="btn small"
            title="패널은 빈 곳을 끌어 옮길 수 있습니다. 옆 모니터로 끌면 그 모니터에 자리를 잡습니다."
            @click="resetPosition"
          >
            기본 자리로
          </button>
        </div>
      </section>

      <!-- 전역 단축키 -->
      <section>
        <span class="field-label">전역 단축키</span>
        <ShortcutInput v-model="state.settings.shortcut" />
        <p class="note">{{ shortcutHint }}</p>
      </section>

      <!-- 일반 -->
      <section>
        <span class="field-label">일반</span>

        <div class="seg-row">
          <span class="seg-label">테마</span>
          <div class="seg">
            <button
              :class="{ on: state.settings.theme !== 'light' }"
              @click="state.settings.theme = 'dark'"
            >
              다크
            </button>
            <button
              :class="{ on: state.settings.theme === 'light' }"
              @click="state.settings.theme = 'light'"
            >
              라이트
            </button>
          </div>
        </div>

        <div class="seg-row">
          <label class="seg-label" for="opacity">불투명도</label>
          <input
            id="opacity"
            v-model.number="state.settings.opacity"
            class="range"
            type="range"
            min="0.5"
            max="1"
            step="0.02"
          />
          <output>{{ Math.round(state.settings.opacity * 100) }}%</output>
        </div>

        <div class="seg-row">
          <span class="seg-label">탭</span>
          <span class="tab-sum">탭 {{ state.tabs.length }}개 · 항목 {{ itemCount }}개</span>
          <button class="btn small" @click="view = 'tabs'">탭 편집</button>
        </div>

        <div class="switches">
          <label class="switch">
            <input v-model="state.settings.autostart" type="checkbox" />
            <span>Windows 시작할 때 자동 실행</span>
          </label>
          <label class="switch">
            <input v-model="state.settings.showNames" type="checkbox" />
            <span>항목 이름 표시</span>
          </label>
        </div>
      </section>
    </div>

    <!-- ===================== 탭 편집 ===================== -->
    <div v-else-if="view === 'tabs'" class="content">
      <p class="note top">
        탭은 최대 {{ MAX_TABS }}개입니다. 이름은 한글 2~6자를 권합니다. 길면 탭
        바에서 말줄임됩니다. <strong>탭을 지우면 그 안의 항목도 함께 사라집니다.</strong>
      </p>

      <div ref="rowsEl" class="tab-rows">
        <div
          v-for="(tab, i) in state.tabs"
          :key="tab.id"
          class="tab-row"
          :class="{
            lifted: drag.active && drag.from === i,
            target: drag.active && drag.to === i && drag.from !== i,
          }"
        >
          <span
            class="handle"
            title="끌어서 순서 변경"
            @pointerdown="onHandleDown($event, i)"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"
                 v-html="UI_ICONS.grip" />
          </span>

          <input
            v-model="tab.name"
            class="text-input"
            type="text"
            maxlength="12"
            spellcheck="false"
          />

          <span class="count">{{ tab.items.length }}개</span>

          <button
            class="icon-btn danger"
            :title="state.tabs.length <= 1 ? '마지막 탭은 지울 수 없습니다' : '삭제'"
            :disabled="state.tabs.length <= 1"
            @click="confirmTabId = confirmTabId === tab.id ? '' : tab.id"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
                 v-html="UI_ICONS.trash" />
          </button>

          <div v-if="confirmTabId === tab.id" class="confirm">
            <span>
              <strong>{{ tab.name }}</strong> 탭과 항목
              {{ tab.items.length }}개를 지울까요?
            </span>
            <button class="btn" @click="confirmTabId = ''">취소</button>
            <button class="btn danger" @click="onRemoveTab(tab.id)">삭제</button>
          </div>
        </div>
      </div>

      <button
        class="add-tab"
        :disabled="state.tabs.length >= MAX_TABS"
        @click="onAddTab"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" v-html="UI_ICONS.plus" />
        탭 추가 ({{ state.tabs.length }}/{{ MAX_TABS }})
      </button>
    </div>

    <!-- ===================== 항목 편집 (런처 요청) ===================== -->
    <ItemEditor
      v-if="view === 'item' && editItem && editOwner"
      :item="editItem"
      :tabs="state.tabs"
      :current-tab-id="editOwner.id"
      :missing="editMissing"
      @close="finishRequest"
      @remove="onEditRemove"
      @move-to-tab="onEditMove"
      @relocate="onEditRelocate"
    />

    <!-- ===================== 웹 링크 추가 (런처 요청) ===================== -->
    <Sheet v-else-if="view === 'link'" title="웹 링크 추가" @close="finishRequest">
      <section>
        <label class="field-label" for="link-url">주소</label>
        <input
          id="link-url"
          v-model="linkUrl"
          class="text-input"
          type="text"
          placeholder="example.com"
          spellcheck="false"
          @keydown.enter="addLinkFromSettings"
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
          @keydown.enter="addLinkFromSettings"
        />
      </section>
      <section v-if="state.tabs.length > 1">
        <label class="field-label" for="link-tab">넣을 탭</label>
        <select id="link-tab" v-model="linkTabId" class="text-input">
          <option v-for="t in state.tabs" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
      </section>
      <p v-if="linkError" class="err">{{ linkError }}</p>
      <template #footer>
        <button class="btn" @click="finishRequest">취소</button>
        <button class="btn primary" @click="addLinkFromSettings">추가</button>
      </template>
    </Sheet>

    <!-- ===================== 창 푸터 ===================== -->
    <footer class="winfoot">
      <button class="linkish" @click="openConfigDir">설정 파일 폴더</button>
      <button class="linkish" @click="refreshIcons">아이콘 새로 고침</button>
      <span class="busy">{{ busy }}</span>
      <!-- 업데이트는 여기 한 곳에서. 버전을 누르면 다시 확인하고,
           새 버전이 있으면 그 자리가 설치 버튼이 됩니다. -->
      <span v-if="!busy && version" class="version">
        <button
          v-if="update && updateState === 'found'"
          class="update-chip"
          :title="`지금 v${version} → 새 버전 v${update.version}${update.notes ? '\n' + update.notes : ''}`"
          @click="installUpdate"
        >
          <i class="chip-dot" aria-hidden="true" />
          v{{ update.version }} 설치
        </button>
        <template v-else-if="updateState === 'installing'">설치 중…</template>
        <button
          v-else
          class="linkish quiet"
          :disabled="updateState === 'checking'"
          :title="updateTitle"
          @click="checkForUpdate"
        >
          v{{ version }}<template v-if="updateState === 'checking'"> · 확인 중…</template
          ><template v-else-if="updateState === 'none'"> · 최신</template
          ><template v-else-if="updateFailed"> · 확인 실패</template>
        </button>
      </span>
      <template v-if="confirmQuit">
        <span class="confirm-quit">정말 끌까요?</span>
        <button class="btn" @click="confirmQuit = false">취소</button>
        <button class="btn danger" @click="quitLauncher">종료</button>
      </template>
      <button v-else class="btn danger" @click="confirmQuit = true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.7" stroke-linecap="round" v-html="UI_ICONS.power" />
        런처 종료
      </button>
    </footer>
  </div>
</template>

<style scoped>
.win {
  /* 항목 편집 · 링크 추가 시트가 이 창 안에 꽉 차도록 */
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 설정 창은 런처 패널과 달리 항상 불투명합니다. 불투명도 설정을 낮춰둔
     상태에서 설정 창까지 비치면 읽기 어렵습니다. */
  background: rgb(var(--panel));
  border: 1px solid rgb(var(--line) / var(--line-alpha));
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
  opacity: 0;
  transition: opacity var(--dur-overlay) var(--ease);
}
.win.ready {
  opacity: 1;
}

.titlebar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 44px;
  padding: 0 var(--space-3) 0 var(--space-5);
  border-bottom: 1px solid rgb(var(--line) / var(--divider-alpha));
}
.titlebar h1 {
  flex: 1 1 auto;
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 700;
  letter-spacing: -0.01em;
}

.content {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

section {
  display: block;
}

/* ---- 배치 모양 아이콘 (선택 버튼 안) -------------------------------- */

.shape {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  width: 18px;
  height: 13px;
  border-radius: 3px;
  border: 1px solid rgb(var(--line) / 0.3);
}
.shape i {
  position: absolute;
  display: block;
  border-radius: 1px;
  background: rgb(var(--text-faint));
}
.seg button.on .shape {
  border-color: rgb(var(--accent-ink) / 0.6);
}
.seg button.on .shape i {
  background: rgb(var(--accent));
}
.shape[data-shape="right"] i {
  top: 1px;
  bottom: 1px;
  right: 1px;
  width: 5px;
}
.shape[data-shape="bottom"] i {
  left: 1px;
  right: 1px;
  bottom: 1px;
  height: 3px;
}
.shape[data-shape="center"] i {
  left: 4px;
  right: 4px;
  top: 3px;
  bottom: 3px;
}

/* ---- 일반 ------------------------------------------------------------- */

.switch {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  font-size: 12px;
  color: rgb(var(--text-item));
  cursor: pointer;
}
.switch input {
  width: 15px;
  height: 15px;
  accent-color: rgb(var(--accent-ink));
  cursor: pointer;
}

.switches {
  display: flex;
  flex-wrap: wrap;
  column-gap: var(--space-6);
  margin-top: var(--space-2);
}

.range {
  flex: 1 1 auto;
  min-width: 0;
  accent-color: rgb(var(--accent-ink));
}
.seg-row output {
  flex: 0 0 38px;
  text-align: right;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-dim));
}
.tab-sum {
  flex: 1 1 auto;
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
}
.btn.small {
  padding: 5px 11px;
  font-size: var(--fs-caption);
}

/* ---- 탭 편집 ---------------------------------------------------------- */

.tab-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tab-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: var(--space-2);
  border-radius: var(--radius-tile);
  border: 1px solid transparent;
  transition: background var(--dur-hover) var(--ease),
    border-color var(--dur-hover) var(--ease);
}
.tab-row.lifted {
  opacity: 0.4;
  border-style: dashed;
  border-color: rgb(var(--accent) / 0.5);
}
.tab-row.target {
  border-color: rgb(var(--accent-ink));
  background: rgb(var(--accent) / var(--accent-soft-alpha));
}

.handle {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 22px;
  height: 26px;
  border-radius: 6px;
  color: rgb(var(--text-faint));
  cursor: grab;
}
.handle:active {
  cursor: grabbing;
}
.handle svg {
  width: 15px;
  height: 15px;
}

.tab-row .text-input {
  flex: 1 1 0;
  width: auto;
  min-width: 0;
}

.count {
  flex: 0 0 auto;
  min-width: 40px;
  text-align: right;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-faint));
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.icon-btn.danger:hover:not(:disabled) {
  color: rgb(var(--danger));
  background: rgb(var(--danger) / 0.14);
}

.confirm {
  flex: 1 0 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: rgb(var(--danger) / 0.12);
  font-size: var(--fs-caption);
  line-height: 1.4;
}
.confirm span {
  flex: 1 1 auto;
  color: rgb(var(--text-dim));
}
.confirm strong {
  color: rgb(var(--text));
}
.confirm .btn {
  flex: 0 0 auto;
  padding: 4px 9px;
  font-size: var(--fs-caption);
}

.add-tab {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: 7px 12px;
  border-radius: var(--radius-control);
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
  background: rgb(var(--tile) / var(--surface-alpha));
  transition: background var(--dur-hover) var(--ease);
}
.add-tab svg {
  width: 13px;
  height: 13px;
}
.add-tab:hover:not(:disabled) {
  background: rgb(var(--tile) / var(--surface-alpha-hover));
  color: rgb(var(--text));
}
.add-tab:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ---- 창 푸터 ---------------------------------------------------------- */

.winfoot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  height: 52px;
  padding: 0 var(--space-6);
  border-top: 1px solid rgb(var(--line) / var(--divider-alpha));
}

.version {
  flex: 1 1 auto;
  text-align: right;
  padding-right: var(--space-3);
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-faint));
}

.linkish.quiet {
  font-size: inherit;
  color: inherit;
  text-decoration: none;
}
.linkish.quiet:hover:not(:disabled) {
  color: rgb(var(--text));
  text-decoration: underline;
}
.linkish.quiet:disabled {
  cursor: default;
}

.update-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius-pill);
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  color: rgb(var(--accent-ink));
  font-size: var(--fs-caption);
  font-weight: 700;
  transition: background var(--dur-hover) var(--ease);
}
.update-chip:hover {
  background: rgb(var(--accent) / calc(var(--accent-soft-alpha) * 2));
}
.chip-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: rgb(var(--accent));
}

.confirm-quit {
  flex: 0 0 auto;
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
}

.linkish {
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: rgb(var(--line) / 0.25);
  transition: color var(--dur-hover) var(--ease);
}
.linkish:hover {
  color: rgb(var(--text));
}

.busy {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-caption);
  color: rgb(var(--accent-ink));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.winfoot .btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
}
.winfoot .btn svg {
  width: 14px;
  height: 14px;
}

.seg-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 32px;
  margin-top: var(--space-2);
}
.field-label + .seg-row {
  margin-top: 0;
}
/* 선택한 것의 설명 한 줄. 선택지 열에 맞춰 들여 씁니다. */
.seg-hint {
  margin: 3px 0 0 calc(72px + var(--space-3));
  font-size: 10.5px;
  line-height: 1.45;
  color: rgb(var(--text-faint));
}
.seg-label {
  flex: 0 0 72px;
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
}
.seg {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: 3px;
  border-radius: var(--radius-control);
  background: rgb(var(--tile) / var(--surface-alpha));
}
.seg button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 26px;
  line-height: 1;
  padding: 0 10px;
  border-radius: calc(var(--radius-control) - 2px);
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
  transition: background var(--dur-hover) var(--ease), color var(--dur-hover) var(--ease);
}
.seg button:hover {
  color: rgb(var(--text));
}
.seg button.on {
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  color: rgb(var(--accent-ink));
  font-weight: 700;
}
.seg button em {
  font-style: normal;
  font-weight: 400;
  font-size: 10px;
  color: rgb(var(--text-faint));
}
select.text-input {
  appearance: none;
  cursor: pointer;
}

.note {
  margin: 0;
}

.note {
  margin: var(--space-3) 0 0;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: rgb(var(--text-faint));
}
.err {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: rgb(var(--danger));
}

.note.top {
  margin: 0 0 var(--space-3);
}
.note strong {
  color: rgb(var(--text-dim));
  font-weight: 700;
}
</style>
