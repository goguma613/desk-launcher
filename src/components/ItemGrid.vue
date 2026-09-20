<script setup>
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import AppIcon from "./AppIcon.vue";
import { UI_ICONS } from "../icons";

const props = defineProps({
  items: { type: Array, required: true },
  /** 0이면 한 줄 가로 스크롤 (하단 가로 바) */
  columns: { type: Number, default: 3 },
  cellW: { type: Number, default: 90 },
  cellH: { type: Number, default: 81 },
  iconBox: { type: Number, default: 40 },
  nameMax: { type: Number, default: 78 },
  editing: { type: Boolean, default: false },
  showNames: { type: Boolean, default: true },
  missing: { type: Object, default: () => new Set() },
});

const emit = defineEmits(["open", "edit", "remove", "move", "over-tab", "drop-on-tab"]);

const rowMode = computed(() => props.columns === 0);
const gridEl = ref(null);

const gridStyle = computed(() => ({
  "--cell-w": props.cellW + "px",
  "--cell-h": props.cellH + "px",
  "--name-max": props.nameMax + "px",
  "--cols": props.columns,
}));

/* ---------------------------------------------------------------------------
   순서 변경
   ---------------------------------------------------------------------------
   Tauri가 웹뷰 레벨에서 HTML5 드래그를 가로채기 때문에 draggable 대신
   포인터 이벤트로 직접 구현했습니다.
   --------------------------------------------------------------------------- */

const drag = reactive({
  active: false,
  from: -1,
  to: -1,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
});

let pendingIndex = -1;
/** 드래그 중 커서가 올라가 있는 탭. 없으면 빈 문자열 */
let overTab = "";
let startX = 0;
let startY = 0;
let suppressClick = false;

function tileEls() {
  return gridEl.value ? Array.from(gridEl.value.querySelectorAll(".tile")) : [];
}

function nearestIndex(x, y) {
  const tiles = tileEls();
  let best = drag.to;
  let bestDist = Infinity;
  tiles.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

function onPointerDown(e, index) {
  if (!props.editing || e.button !== 0) return;
  hideTip();
  pendingIndex = index;
  startX = e.clientX;
  startY = e.clientY;
  // 커서가 창 밖으로 나가도 pointerup을 놓치지 않도록 캡처합니다.
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    /* 캡처를 못 해도 동작에는 지장 없음 */
  }
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
  window.addEventListener("pointercancel", onPointerUp, { once: true });
}

function onPointerMove(e) {
  if (pendingIndex < 0) return;

  if (!drag.active) {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
    const el = tileEls()[pendingIndex];
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag.w = r.width;
    drag.h = r.height;
    drag.from = pendingIndex;
    drag.to = pendingIndex;
    drag.active = true;
  }

  drag.x = e.clientX;
  drag.y = e.clientY;

  // 탭 위로 끌어올리면 순서 변경이 아니라 탭 이동입니다.
  // 미리보기 카드는 pointer-events: none 이라 판정을 가리지 않습니다.
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const tabEl = under && under.closest ? under.closest("[data-tab-id]") : null;
  const next = tabEl ? tabEl.getAttribute("data-tab-id") : "";
  if (next !== overTab) {
    overTab = next;
    emit("over-tab", overTab);
  }

  drag.to = overTab ? -1 : nearestIndex(e.clientX, e.clientY);
}

function onPointerUp() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);

  if (drag.active) {
    if (overTab) {
      emit("drop-on-tab", overTab, props.items[drag.from]);
    } else if (drag.to >= 0 && drag.to !== drag.from) {
      emit("move", drag.from, drag.to);
    }
    // 드래그 직후 발생하는 click을 한 번 무시합니다.
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  }

  drag.active = false;
  drag.from = -1;
  drag.to = -1;
  pendingIndex = -1;
  if (overTab) {
    overTab = "";
    emit("over-tab", "");
  }
}

function onTileClick(item) {
  if (suppressClick) return;
  if (props.editing) emit("edit", item);
  else emit("open", item);
}

const draggedItem = computed(() =>
  drag.active && drag.from >= 0 ? props.items[drag.from] : null
);

/** 삽입선을 대상 셀의 어느 쪽에 그릴지 */
function dropSide(i) {
  if (!drag.active || drag.to !== i || drag.from === i) return "";
  return drag.to > drag.from ? "drop-after" : "drop-before";
}

/* ---------------------------------------------------------------------------
   전체 이름 툴팁 — 0.6초 호버 뒤, 이름이 잘렸을 때만
   --------------------------------------------------------------------------- */

const tip = reactive({ show: false, below: false, text: "", x: 0, y: 0 });
let tipTimer = null;

function onTileEnter(e, item) {
  hideTip();
  const el = e.currentTarget;
  tipTimer = setTimeout(() => {
    const nameEl = el.querySelector(".name");
    const truncated = nameEl && nameEl.scrollWidth > nameEl.clientWidth + 1;
    // 이름을 숨긴 상태에서는 항상 띄웁니다. 그때는 아이콘만 보이니까요.
    if (!truncated && props.showNames) return;

    const r = el.getBoundingClientRect();
    tip.text = item.name;

    // 하단 가로 바는 셀 위쪽 여유가 10px 남짓이라 위에 띄우면 창 밖으로
    // 나가 아예 안 보입니다. 자리가 없으면 아래로 뒤집습니다.
    const above = r.top > 44;
    tip.below = !above;
    tip.y = Math.round(above ? r.top - 8 : r.bottom + 8);

    // 좌우 끝 항목에서 툴팁이 창을 넘지 않도록 묶습니다.
    const half = 130;
    tip.x = Math.round(
      Math.min(
        Math.max(r.left + r.width / 2, half + 6),
        window.innerWidth - half - 6
      )
    );
    tip.show = true;
  }, 600);
}

function hideTip() {
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = null;
  tip.show = false;
}

onBeforeUnmount(() => {
  hideTip();
  window.removeEventListener("pointermove", onPointerMove);
});
</script>

<template>
  <div
    ref="gridEl"
    class="grid"
    :class="{ row: rowMode, editing, dragging: drag.active }"
    :style="gridStyle"
  >
    <button
      v-for="(item, i) in items"
      :key="item.id"
      class="tile"
      :class="[
        dropSide(i),
        {
          lifted: drag.active && drag.from === i,
          gone: missing.has(item.id),
        },
      ]"
      @pointerdown="onPointerDown($event, i)"
      @pointerenter="onTileEnter($event, item)"
      @pointerleave="hideTip"
      @click="onTileClick(item)"
      @contextmenu.prevent="emit('edit', item)"
    >
      <AppIcon :item="item" :box="iconBox" />
      <span v-if="showNames" class="name">{{ item.name }}</span>

      <!-- 타일 자체가 button이라 버튼을 겹칠 수 없습니다.
           역할과 탭 순서만 주어 키보드로도 닿게 합니다. -->
      <span
        v-if="editing"
        class="remove"
        role="button"
        tabindex="0"
        title="삭제"
        @pointerdown.stop
        @click.stop="emit('remove', item)"
        @keydown.enter.stop.prevent="emit('remove', item)"
        @keydown.space.stop.prevent="emit('remove', item)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.6" stroke-linecap="round" v-html="UI_ICONS.close" />
      </span>
    </button>

    <!-- 드래그 중 커서를 따라다니는 카드 -->
    <Teleport to="body">
      <div
        v-if="draggedItem"
        class="ghost"
        :style="{
          left: drag.x + 'px',
          top: drag.y + 'px',
          width: drag.w + 'px',
          height: drag.h + 'px',
          '--name-max': nameMax + 'px',
        }"
      >
        <AppIcon :item="draggedItem" :box="iconBox" />
        <span v-if="showNames" class="name">{{ draggedItem.name }}</span>
      </div>

      <div
        v-if="tip.show"
        class="name-tip"
        :style="{
          left: tip.x + 'px',
          top: tip.y + 'px',
          transform: tip.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
        }"
      >
        {{ tip.text }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.grid {
  /* 탭을 바꿀 때 항목 위치는 그대로 두고 페이드만 합니다 */
  animation: grid-in var(--dur-overlay) var(--ease);
  display: grid;
  grid-template-columns: repeat(var(--cols), var(--cell-w));
  grid-auto-rows: var(--cell-h);
  justify-content: center;
  gap: var(--tile-gap);
  align-content: start;
}

.grid.row {
  display: flex;
  flex-wrap: nowrap;
  justify-content: flex-start;
  align-items: center;
}
.grid.row .tile {
  flex: 0 0 var(--cell-w);
}

/* ---- 셀 -------------------------------------------------------------- */

.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: var(--cell-w);
  height: var(--cell-h);
  padding: 0 var(--space-1);
  min-width: 0;
  border-radius: var(--radius-tile);
  /* 기본은 배경 없음 */
  background: transparent;
  transition: background var(--dur-leave) var(--ease);
}

.tile:hover {
  background: rgb(var(--tile) / var(--tile-alpha-hover));
  transition-duration: var(--dur-hover);
}

/* 누를 때는 배경만 바꾸고 크기는 그대로. 아이콘만 줄입니다.
   한글 11px를 같이 줄이면 글자가 떨려 보입니다. */
.tile:active {
  background: rgb(var(--tile) / var(--tile-alpha-active));
  transition-duration: var(--dur-press);
}
.tile:active :deep(.app-icon) {
  transform: scale(0.94);
  transition-duration: var(--dur-press);
}

.name {
  max-width: var(--name-max);
  font-size: var(--fs-name);
  line-height: 1.3;
  text-align: center;
  color: rgb(var(--text-item));
  /* 파일명은 끝 말줄임 한 줄 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--dur-hover) var(--ease);
}

.tile:hover .name {
  color: rgb(var(--text));
}

/* 경로가 사라진 항목 */
.tile.gone {
  opacity: 0.45;
}
.tile.gone::after {
  content: "";
  position: absolute;
  top: 8px;
  left: 8px;
  width: 5px;
  height: 5px;
  border-radius: var(--radius-pill);
  background: rgb(var(--danger));
}

/* ---- 편집 모드 -------------------------------------------------------- */

.grid.editing .tile {
  cursor: grab;
  outline: 1px dashed rgb(var(--line) / 0.22);
  outline-offset: -1px;
}
.grid.editing .tile:active {
  cursor: grabbing;
}

.remove {
  position: absolute;
  top: 2px;
  right: 2px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: rgb(var(--danger));
  color: rgb(var(--panel));
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.35);
}
/* 보이는 크기는 18px, 실제로 누를 수 있는 영역은 28px.
   40px 아이콘 바로 옆이라 오클릭 위험이 있습니다. */
.remove::before {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
}
.remove svg {
  width: 10px;
  height: 10px;
}
.remove:hover {
  filter: brightness(1.12);
}

/* ---- 드래그 ----------------------------------------------------------- */

/* 들어올린 자리에는 점선 자국만 남습니다 */
.tile.lifted {
  opacity: 0.25;
  outline: 1.5px dashed rgb(var(--accent) / 0.55);
  outline-offset: -1px;
  background: transparent;
}

/* 삽입 위치에 2px 액센트 세로선 */
.tile.drop-before::before,
.tile.drop-after::before {
  content: "";
  position: absolute;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: var(--radius-pill);
  background: rgb(var(--accent));
}
.tile.drop-before::before {
  left: calc(var(--tile-gap) / -2 - 1px);
}
.tile.drop-after::before {
  right: calc(var(--tile-gap) / -2 - 1px);
}

.ghost {
  position: fixed;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-1);
  border-radius: var(--radius-tile);
  background: rgb(var(--panel-raise) / 0.97);
  box-shadow: var(--shadow-drag);
  pointer-events: none;
  transform: translate(-50%, -50%) rotate(-2deg);
  animation: lift var(--dur-drag) var(--ease);
}
.ghost .name {
  max-width: var(--name-max, 78px);
  font-size: var(--fs-name);
  line-height: 1.3;
  text-align: center;
  color: rgb(var(--text));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@keyframes grid-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes lift {
  from {
    transform: translate(-50%, -50%) rotate(0deg);
    box-shadow: none;
  }
  to {
    transform: translate(-50%, -50%) rotate(-2deg);
    box-shadow: var(--shadow-drag);
  }
}
</style>
