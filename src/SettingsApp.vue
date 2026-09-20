<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import ShortcutInput from "./components/ShortcutInput.vue";
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
  MAX_TABS,
} from "./store";
import { refreshAll } from "./extractedIcons";
import { getVersion } from "@tauri-apps/api/app";
import { findUpdate } from "./updater";

const ready = ref(false);
/** 'main' | 'tabs' */
const view = ref("main");
const confirmTabId = ref("");
const busy = ref("");
const version = ref("");

/* 업데이트 — GitHub Releases */
const update = ref(null); // { version, notes, install }
/** "" | "checking" | "none" | "found" | "installing" | 에러 문구 */
const updateState = ref("");

async function checkForUpdate() {
  updateState.value = "checking";
  update.value = null;
  try {
    const found = await findUpdate();
    update.value = found;
    updateState.value = found ? "found" : "none";
  } catch (e) {
    updateState.value = `확인하지 못했습니다: ${e}`;
  }
}

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

const lightTheme = computed({
  get: () => state.settings.theme === "light",
  set: (on) => (state.settings.theme = on ? "light" : "dark"),
});

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

function close() {
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

  unlisteners.push(
    await listen("launcher://state-saved", async () => {
      await rehydrate();
      applyTheme();
      applyOpacity();
    })
  );

  // 창은 닫히지 않고 숨겨졌다가 다시 뜹니다. 열 때마다 첫 화면으로.
  unlisteners.push(
    await listen("launcher://settings-shown", async () => {
      view.value = "main";
      confirmTabId.value = "";
      await rehydrate();
      applyTheme();
      applyOpacity();
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
      <!-- 배치 -->
      <section>
        <span class="field-label">배치</span>
        <div class="cards">
          <button
            v-for="p in PRESETS"
            :key="p.key"
            class="card"
            :class="{ on: state.settings.preset === p.key }"
            @click="state.settings.preset = p.key"
          >
            <span class="shape" :data-shape="p.key" aria-hidden="true"><i></i></span>
            <span class="card-title">{{ p.label }}</span>
            <span class="card-hint">{{ p.hint }}</span>
          </button>
        </div>
      </section>

      <!-- 표시 모드 -->
      <section>
        <span class="field-label">표시 모드</span>
        <div class="stack">
          <button
            v-for="m in MODES"
            :key="m.key"
            class="option"
            :class="{ on: state.settings.mode === m.key }"
            @click="state.settings.mode = m.key"
          >
            <span class="dot" />
            <span>
              <strong>{{ m.label }}</strong>
              <em>{{ m.hint }}</em>
            </span>
          </button>
        </div>
      </section>

      <!-- 전역 단축키 -->
      <section>
        <span class="field-label">전역 단축키</span>
        <ShortcutInput v-model="state.settings.shortcut" />
        <p class="note">
          오버레이 모드에서는 창을 켜고 끕니다. 바탕화면 고정 모드에서는 맨 아래
          깔린 창을 잠깐 앞으로 불러내고, 다른 곳을 클릭하면 제자리로 돌아갑니다.
        </p>
      </section>

      <!-- 일반 -->
      <section>
        <span class="field-label">일반</span>

        <label class="switch">
          <input v-model="state.settings.autostart" type="checkbox" />
          <span>Windows 시작할 때 자동 실행</span>
        </label>

        <label class="switch">
          <input v-model="state.settings.showNames" type="checkbox" />
          <span>항목 이름 표시</span>
        </label>

        <label class="switch">
          <input v-model="lightTheme" type="checkbox" />
          <span>라이트 테마</span>
        </label>

        <div class="control">
          <label for="opacity">배경 불투명도</label>
          <input
            id="opacity"
            v-model.number="state.settings.opacity"
            type="range"
            min="0.5"
            max="1"
            step="0.02"
          />
          <output>{{ Math.round(state.settings.opacity * 100) }}%</output>
        </div>
      </section>

      <!-- 업데이트 -->
      <section>
        <span class="field-label">업데이트</span>
        <div class="update-row">
          <span class="update-now">현재 v{{ version || "…" }}</span>
          <button
            class="btn"
            :disabled="updateState === 'checking' || updateState === 'installing'"
            @click="checkForUpdate"
          >
            {{ updateState === "checking" ? "확인 중…" : "업데이트 확인" }}
          </button>
          <button
            v-if="update"
            class="btn primary"
            :disabled="updateState === 'installing'"
            @click="installUpdate"
          >
            v{{ update.version }} 설치
          </button>
        </div>
        <p v-if="updateState === 'none'" class="note">최신 버전입니다.</p>
        <p v-else-if="updateState === 'installing'" class="note">
          내려받는 중입니다. 끝나면 설치 프로그램이 뜨고 런처가 잠시 꺼집니다.
        </p>
        <p v-else-if="update" class="note">
          <strong>v{{ update.version }}</strong> 이 있습니다.
          <template v-if="update.notes">{{ update.notes }}</template>
        </p>
        <p
          v-else-if="updateState && updateState !== 'checking'"
          class="err"
        >
          {{ updateState }}
        </p>
      </section>

      <!-- 탭 -->
      <section>
        <span class="field-label">탭</span>
        <div class="chips">
          <span v-for="t in state.tabs" :key="t.id" class="chip">
            {{ t.name }}
            <em>{{ t.items.length }}</em>
          </span>
        </div>
        <button class="btn" @click="view = 'tabs'">탭 편집</button>
      </section>
    </div>

    <!-- ===================== 탭 편집 ===================== -->
    <div v-else class="content">
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

    <!-- ===================== 창 푸터 ===================== -->
    <footer class="winfoot">
      <button class="linkish" @click="openConfigDir">설정 파일 폴더</button>
      <button class="linkish" @click="refreshIcons">아이콘 새로 고침</button>
      <span class="busy">{{ busy }}</span>
      <span v-if="!busy && version" class="version">v{{ version }}</span>
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

/* ---- 배치 카드 -------------------------------------------------------- */

.cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
}

.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-3);
  border-radius: var(--radius-tile);
  background: rgb(var(--tile) / var(--surface-alpha));
  border: 1px solid transparent;
  text-align: center;
  transition: background var(--dur-hover) var(--ease),
    border-color var(--dur-hover) var(--ease);
}
.card:hover {
  background: rgb(var(--tile) / var(--surface-alpha-hover));
}
.card.on {
  border-color: rgb(var(--accent-ink));
  background: rgb(var(--accent) / var(--accent-soft-alpha));
}

.shape {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: 6px;
  border: 1px solid rgb(var(--line) / 0.22);
  background: rgb(var(--tile) / 0.05);
}
.shape i {
  position: absolute;
  display: block;
  border-radius: 2px;
  background: rgb(var(--text-dim));
}
.card.on .shape i {
  background: rgb(var(--accent));
}
/* 우측 세로 패널은 가장자리에 밀착합니다 */
.shape[data-shape="right"] i {
  top: 10%;
  bottom: 10%;
  right: 0;
  width: 26%;
  border-radius: 2px 0 0 2px;
}
.shape[data-shape="bottom"] i {
  left: 0;
  right: 0;
  bottom: 6%;
  height: 22%;
}
.shape[data-shape="center"] i {
  left: 22%;
  right: 22%;
  top: 20%;
  bottom: 20%;
}

.card-title {
  font-size: var(--fs-caption);
  font-weight: 700;
  line-height: 1.3;
}
.card-hint {
  font-size: 10.5px;
  line-height: 1.45;
  color: rgb(var(--text-faint));
}

/* ---- 모드 ------------------------------------------------------------- */

.stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-tile);
  background: rgb(var(--tile) / var(--surface-alpha));
  border: 1px solid transparent;
  text-align: left;
  transition: background var(--dur-hover) var(--ease),
    border-color var(--dur-hover) var(--ease);
}
.option:hover {
  background: rgb(var(--tile) / var(--surface-alpha-hover));
}
.option.on {
  border-color: rgb(var(--accent-ink));
  background: rgb(var(--accent) / var(--accent-soft-alpha));
}
.option .dot {
  flex: 0 0 auto;
  width: 13px;
  height: 13px;
  margin-top: 2px;
  border-radius: var(--radius-pill);
  border: 1.5px solid rgb(var(--text-faint));
}
.option.on .dot {
  border-color: rgb(var(--accent-ink));
  box-shadow: inset 0 0 0 3px rgb(var(--accent));
}
.option strong {
  display: block;
  font-size: 12px;
  font-weight: 700;
}
.option em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: var(--fs-caption);
  line-height: 1.45;
  color: rgb(var(--text-faint));
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

.control {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
}
.control label {
  flex: 0 0 90px;
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
}
.control input[type="range"] {
  flex: 1 1 auto;
  min-width: 0;
  accent-color: rgb(var(--accent-ink));
}
.control output {
  flex: 0 0 44px;
  text-align: right;
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-dim));
}

/* ---- 탭 칩 ------------------------------------------------------------ */

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: var(--radius-pill);
  background: rgb(var(--tile) / var(--surface-alpha));
  font-size: var(--fs-caption);
  color: rgb(var(--text-item));
}
.chip em {
  font-style: normal;
  font-size: 10px;
  color: rgb(var(--text-faint));
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

.update-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.update-now {
  flex: 0 0 auto;
  margin-right: var(--space-2);
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-dim));
}
.update-row .btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.version {
  flex: 1 1 auto;
  text-align: right;
  padding-right: var(--space-3);
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
  color: rgb(var(--text-faint));
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

.note {
  margin: var(--space-3) 0 0;
  font-size: var(--fs-caption);
  line-height: 1.6;
  color: rgb(var(--text-faint));
}
.note.top {
  margin: 0 0 var(--space-3);
}
.note strong {
  color: rgb(var(--text-dim));
  font-weight: 700;
}
</style>
