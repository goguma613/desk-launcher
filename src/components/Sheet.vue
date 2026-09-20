<script setup>
import { UI_ICONS } from "../icons";

defineProps({
  title: { type: String, default: "" },
});
const emit = defineEmits(["close"]);
</script>

<template>
  <div class="sheet">
    <header class="sheet-head" data-tauri-drag-region>
      <h2>{{ title }}</h2>
      <button class="icon-btn" title="닫기" @click="emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" v-html="UI_ICONS.close" />
      </button>
    </header>

    <div class="sheet-body">
      <slot />
    </div>

    <footer v-if="$slots.footer" class="sheet-foot">
      <slot name="footer" />
    </footer>
  </div>
</template>

<style scoped>
.sheet {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: rgb(var(--panel));
  overflow: hidden;
}

.sheet-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  height: 41px;
  padding: 0 var(--space-2) 0 var(--space-4);
  border-bottom: 1px solid rgb(var(--line) / var(--divider-alpha));
}

.sheet-head h2 {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 700;
  letter-spacing: -0.01em;
}

.sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--panel-pad);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.sheet-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  min-height: 45px;
  padding: var(--space-2) var(--panel-pad);
  border-top: 1px solid rgb(var(--line) / var(--divider-alpha));
  flex-wrap: wrap;
}
</style>
