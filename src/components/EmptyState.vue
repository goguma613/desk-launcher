<script setup>
import { UI_ICONS } from "../icons";

defineProps({
  tabName: { type: String, default: "" },
  /** 하단 가로 바처럼 높이가 낮을 때 */
  compact: { type: Boolean, default: false },
});
const emit = defineEmits(["browse"]);
</script>

<template>
  <div class="empty" :class="{ compact }">
    <div class="dropbox">
      <svg
        class="mark"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        v-html="UI_ICONS.drop"
      />
      <p class="line">
        <strong>{{ tabName }}</strong> 탭이 비어 있습니다
      </p>
      <p class="sub">파일 · 폴더 · 프로그램을 끌어다 놓으세요</p>
      <button class="browse" @click="emit('browse')">직접 찾아보기</button>
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.dropbox {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  width: 100%;
  height: 100%;
  padding: var(--space-3);
  border: 1.5px dashed rgb(var(--accent) / calc(var(--drop-line-alpha) * 0.55));
  border-radius: var(--radius-tile);
  text-align: center;
  color: rgb(var(--text-faint));
}

.mark {
  width: 22px;
  height: 22px;
  opacity: 0.8;
  margin-bottom: 2px;
}

.line {
  margin: 0;
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
}
.line strong {
  color: rgb(var(--text-item));
  font-weight: 700;
}

.sub {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: 1.5;
}

.browse {
  margin-top: var(--space-2);
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-caption);
  font-weight: 500;
  color: rgb(var(--accent-ink));
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  transition: background var(--dur-hover) var(--ease);
}
.browse:hover {
  background: rgb(var(--accent) / calc(var(--accent-soft-alpha) * 1.8));
}

/* 하단 가로 바 — 한 줄에 눕힙니다 */
.empty.compact .dropbox {
  flex-direction: row;
  gap: var(--space-3);
}
.empty.compact .mark {
  margin-bottom: 0;
}
.empty.compact .line {
  display: none;
}
.empty.compact .browse {
  margin-top: 0;
}
</style>
