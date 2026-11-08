<script setup>
import { nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  tabs: { type: Array, required: true },
  activeId: { type: String, default: "" },
  /** 항목을 끌어다 올린 탭. 그 탭만 강조합니다. */
  dropTarget: { type: String, default: "" },
  /** 이름을 고치는 중인 탭 */
  renamingId: { type: String, default: "" },
});
const emit = defineEmits([
  "select",
  "menu",
  "rename-start",
  "rename-commit",
  "rename-cancel",
]);

/* 탭 이름은 설정 창까지 가지 않고 그 자리에서 고칩니다.
   더블클릭하거나, 우클릭 메뉴 · 새 탭 만들기에서 시작됩니다. */
const renameValue = ref("");
const renameInput = ref(null);
let renameDone = false;

watch(
  () => props.renamingId,
  async (id) => {
    if (!id) return;
    const tab = props.tabs.find((t) => t.id === id);
    renameValue.value = tab ? tab.name : "";
    renameDone = false;
    await nextTick();
    const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value;
    el?.focus();
    el?.select();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  },
  { immediate: true }
);

function commitRename(id) {
  if (renameDone) return;
  renameDone = true;
  emit("rename-commit", id, renameValue.value);
  nextTick(measure);
}

function cancelRename() {
  if (renameDone) return;
  renameDone = true;
  emit("rename-cancel");
  nextTick(measure);
}

const strip = ref(null);
/** 활성 탭 밑줄. 탭을 바꾸면 160ms에 걸쳐 옆으로 미끄러집니다. */
const bar = ref({ left: 0, width: 0, ready: false });

function measure() {
  const el = strip.value;
  if (!el) return;
  const active = el.querySelector(".tab.on");
  if (!active) {
    bar.value = { ...bar.value, width: 0 };
    return;
  }
  bar.value = {
    left: active.offsetLeft,
    width: active.offsetWidth,
    ready: true,
  };
}

/* 휠을 굴리면 옆 탭으로 넘어갑니다. 하단 바처럼 탭이 작은 곳에서 정확히
   누르지 않아도 되게 합니다. 넘친 탭은 활성 탭을 따라 저절로 스크롤됩니다.

   터치패드는 한 번 쓸 때 작은 값이 여러 번 들어오므로 모아서 한 칸으로 치고,
   한 칸 넘긴 직후 잠깐은 무시합니다. 안 그러면 한 번에 끝까지 넘어갑니다. */
const WHEEL_STEP = 40;
const WHEEL_REST = 160;
let wheelSum = 0;
let wheelRestUntil = 0;

function onWheel(e) {
  if (props.renamingId || props.tabs.length < 2) return;
  e.preventDefault();
  const now = Date.now();
  if (now < wheelRestUntil) return;
  wheelSum += e.deltaY || e.deltaX;
  if (Math.abs(wheelSum) < WHEEL_STEP) return;
  const step = wheelSum > 0 ? 1 : -1;
  wheelSum = 0;
  wheelRestUntil = now + WHEEL_REST;
  const i = props.tabs.findIndex((t) => t.id === props.activeId);
  const next = Math.min(props.tabs.length - 1, Math.max(0, i + step));
  if (next !== i) select(props.tabs[next].id);
}

function select(id) {
  emit("select", id);
  nextTick(measure);
}

/** 활성 탭이 화면 밖이면 스크롤해서 보여줍니다 */
function revealActive() {
  const el = strip.value;
  const active = el?.querySelector(".tab.on");
  active?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

onMounted(() => {
  measure();
  // 웹폰트가 늦게 뜨면 탭 폭이 달라져 밑줄이 어긋납니다.
  document.fonts?.ready.then(() => nextTick(measure));
});

watch(
  () => [props.activeId, props.tabs.map((t) => t.name).join("\u0000")],
  () => nextTick(() => {
    measure();
    revealActive();
  })
);
</script>

<template>
  <div ref="strip" class="tabs" @wheel="onWheel">
    <template v-for="tab in tabs" :key="tab.id">
      <span
        v-if="tab.id === renamingId"
        class="tab on editing"
        :data-tab-id="tab.id"
      >
        <input
          ref="renameInput"
          v-model="renameValue"
          class="tab-input"
          type="text"
          maxlength="20"
          spellcheck="false"
          :size="Math.max(3, Math.min(renameValue.length + 1, 12))"
          @keydown.enter.stop.prevent="commitRename(tab.id)"
          @keydown.escape.stop.prevent="cancelRename"
          @keydown.stop
          @blur="commitRename(tab.id)"
        />
      </span>
      <button
        v-else
        class="tab"
        :class="{ on: tab.id === activeId, drop: tab.id === dropTarget }"
        :data-tab-id="tab.id"
        title="더블클릭: 이름 바꾸기 · 우클릭: 메뉴 · 휠: 옆 탭으로"
        @click="select(tab.id)"
        @dblclick="emit('rename-start', tab.id)"
        @contextmenu.prevent="emit('menu', tab, $event)"
      >
        {{ tab.name }}
      </button>
    </template>

    <span
      class="underline"
      :class="{ ready: bar.ready }"
      :style="{ left: bar.left + 'px', width: bar.width + 'px' }"
    />
  </div>
</template>

<style scoped>
.tabs {
  position: relative;
  display: flex;
  align-items: stretch;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar {
  display: none;
}

/* 스크롤바를 숨겼으니 양 끝을 흐려서 더 있다는 것만 알립니다 */
.tabs {
  mask-image: linear-gradient(
    90deg,
    transparent 0,
    #000 10px,
    #000 calc(100% - 10px),
    transparent 100%
  );
}

.tab {
  position: relative;
  flex: 0 0 auto;
  padding: 9px 13px 10px;
  font-size: var(--fs-tab);
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: rgb(var(--text-dim));
  /* 시안: 이름이 6자를 넘으면 탭 바에서 말줄임.
     88px = 13px 한글 6자 + 좌우 패딩 26px */
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur-hover) var(--ease);
}

.tab:hover {
  color: rgb(var(--text-item));
}

/* 호버는 흰색 16% 밑줄 */
.tab:hover::after {
  content: "";
  position: absolute;
  bottom: 0;
  height: 2px;
  border-radius: var(--radius-pill);
  background: rgb(var(--line) / 0.16);
  left: 0;
  right: 0;
}
.tab.on:hover::after {
  display: none;
}

.tab.on {
  color: rgb(var(--text));
  font-weight: 700;
}

/* 그 자리에서 이름 고치기 */
.tab.editing {
  max-width: none;
  display: flex;
  align-items: center;
  padding: 0 6px;
}
.tab-input {
  height: 24px;
  padding: 0 6px;
  border-radius: var(--radius-control);
  border: 1px solid rgb(var(--accent) / 0.7);
  background: rgb(var(--panel-raise));
  outline: none;
  font-size: var(--fs-tab);
  font-weight: 700;
  color: rgb(var(--text));
}

/* 항목을 끌어다 올렸을 때 */
.tab.drop {
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  color: rgb(var(--accent-ink));
  border-radius: var(--radius-control);
}

/* 활성 밑줄 하나를 옮겨 다닙니다 */
.underline {
  position: absolute;
  bottom: 0;
  height: 2px;
  border-radius: var(--radius-pill);
  background: rgb(var(--accent));
  pointer-events: none;
}
.underline.ready {
  transition: left var(--dur-tab) var(--ease), width var(--dur-tab) var(--ease);
}
</style>
