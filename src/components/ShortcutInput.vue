<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue"]);

const capturing = ref(false);
const hint = ref("");

/** 키캡으로 쪼개서 보여줍니다. Alt+Space → [Alt] [Space] */
const caps = computed(() =>
  props.modelValue ? props.modelValue.split("+").filter(Boolean) : []
);

/* e.code를 Tauri 전역 단축키가 알아듣는 이름으로 바꿉니다.
   (global-hotkey가 대문자로 바꿔 파싱하므로 대소문자는 무관합니다) */
const CODE_MAP = {
  Space: "Space",
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

function normalize(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_MAP[code] || null;
}

function start() {
  capturing.value = true;
  hint.value = "누를 조합을 입력하세요";
}

function stop() {
  capturing.value = false;
  hint.value = "";
}

function onKeydown(e) {
  e.preventDefault();
  e.stopPropagation();

  if (e.code === "Escape") {
    stop();
    return;
  }

  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");

  const key = normalize(e.code);
  if (!key) {
    hint.value = "조합할 키를 함께 눌러 주세요";
    return;
  }
  if (mods.length === 0 && !/^F\d+$/.test(key)) {
    hint.value = "Ctrl · Alt · Shift 중 하나는 함께 눌러야 합니다";
    return;
  }

  emit("update:modelValue", [...mods, key].join("+"));
  stop();
}
</script>

<template>
  <div class="shortcut">
    <button
      class="caps"
      :class="{ live: capturing }"
      @click="capturing ? stop() : start()"
      @keydown="capturing && onKeydown($event)"
      @blur="stop"
    >
      <span v-if="capturing" class="waiting">입력 대기 중…</span>
      <template v-else-if="caps.length">
        <template v-for="(cap, i) in caps" :key="i">
          <kbd>{{ cap }}</kbd>
          <span v-if="i < caps.length - 1" class="plus">+</span>
        </template>
      </template>
      <span v-else class="none">없음</span>
    </button>

    <button class="change" @click="capturing ? stop() : start()">
      {{ capturing ? "취소" : "변경" }}
    </button>
    <button
      v-if="modelValue && !capturing"
      class="change"
      @click="emit('update:modelValue', '')"
    >
      끄기
    </button>
  </div>
  <p v-if="hint" class="hint">{{ hint }}</p>
</template>

<style scoped>
.shortcut {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.caps {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 34px;
  padding: 5px 10px;
  border-radius: var(--radius-control);
  background: rgb(var(--tile) / var(--surface-alpha));
  border: 1px solid rgb(var(--line) / var(--line-alpha));
  text-align: left;
  transition: border-color var(--dur-hover) var(--ease),
    background var(--dur-hover) var(--ease);
}
.caps.live {
  border-color: rgb(var(--accent-ink));
  background: rgb(var(--accent) / var(--accent-soft-alpha));
}

kbd {
  display: inline-grid;
  place-items: center;
  min-width: 26px;
  padding: 3px 7px;
  border-radius: 6px;
  background: rgb(var(--panel-raise));
  border: 1px solid rgb(var(--line) / var(--line-alpha));
  border-bottom-width: 2px;
  font-family: inherit;
  font-size: var(--fs-caption);
  font-weight: 500;
  line-height: 1.2;
  color: rgb(var(--text));
}

.plus {
  font-size: 10px;
  color: rgb(var(--text-faint));
}

.waiting {
  font-size: var(--fs-caption);
  color: rgb(var(--accent-ink));
}
.none {
  font-size: var(--fs-caption);
  color: rgb(var(--text-faint));
}

.change {
  flex: 0 0 auto;
  padding: 8px 12px;
  border-radius: var(--radius-control);
  font-size: var(--fs-caption);
  font-weight: 500;
  color: rgb(var(--text-dim));
  background: rgb(var(--tile) / var(--surface-alpha));
  transition: background var(--dur-hover) var(--ease),
    color var(--dur-hover) var(--ease);
}
.change:hover {
  background: rgb(var(--tile) / var(--surface-alpha-hover));
  color: rgb(var(--text));
}

.hint {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-caption);
  color: rgb(var(--text-faint));
}
</style>
