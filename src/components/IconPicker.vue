<script setup>
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BUILTIN_ICONS } from "../icons";

defineProps({
  icon: { type: Object, required: true },
});
const emit = defineEmits(["update"]);

const error = ref("");

async function pickImage() {
  error.value = "";
  try {
    const path = await open({
      multiple: false,
      directory: false,
      title: "아이콘으로 쓸 이미지 고르기",
      filters: [
        {
          name: "이미지",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"],
        },
      ],
    });
    if (!path) return;
    const name = await invoke("store_user_icon", { path });
    emit("update", { type: "image", value: name });
  } catch (e) {
    error.value = String(e);
  }
}
</script>

<template>
  <div class="picker">
    <div class="row">
      <button
        class="chip"
        :class="{ on: icon.type === 'auto' }"
        @click="emit('update', { type: 'auto', value: '' })"
      >
        자동
      </button>
      <button
        class="chip"
        :class="{ on: icon.type === 'image' }"
        @click="pickImage"
      >
        이미지…
      </button>
    </div>

    <div class="set">
      <button
        v-for="(def, key) in BUILTIN_ICONS"
        :key="key"
        class="slot"
        :class="{ on: icon.type === 'builtin' && icon.value === key }"
        :title="def.label"
        @click="emit('update', { type: 'builtin', value: key })"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          v-html="def.body"
        />
      </button>
    </div>

    <p class="note">
      <template v-if="icon.type === 'auto'">
        Windows에서 실제 아이콘을 뽑아 씁니다. 못 뽑으면 종류별 기본 아이콘으로
        대체됩니다.
      </template>
      <template v-else-if="icon.type === 'image'">
        고른 이미지는 아이콘 폴더에 복사되고, 설정 파일에는 이름만 들어갑니다.
      </template>
    </p>
    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.row {
  display: flex;
  gap: var(--space-1);
}

.chip {
  padding: 5px 11px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
  background: rgb(var(--tile) / var(--surface-alpha));
  transition: background var(--dur-hover) var(--ease),
    color var(--dur-hover) var(--ease);
}
.chip:hover {
  background: rgb(var(--tile) / var(--surface-alpha-hover));
  color: rgb(var(--text));
}
.chip.on {
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  color: rgb(var(--accent-ink));
  font-weight: 700;
}

/* 폴백 8종 — 4열 두 줄 */
.set {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-1);
}

.slot {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  border-radius: var(--radius-fallback);
  color: rgb(var(--icon-fallback));
  background: rgb(var(--tile) / var(--surface-alpha));
  transition: background var(--dur-hover) var(--ease),
    color var(--dur-hover) var(--ease);
}
.slot svg {
  width: 20px;
  height: 20px;
}
.slot:hover {
  background: rgb(var(--tile) / var(--surface-alpha-hover));
  color: rgb(var(--text));
}
.slot.on {
  background: rgb(var(--accent) / var(--accent-soft-alpha));
  color: rgb(var(--accent-ink));
}

.note,
.err {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: 1.55;
  color: rgb(var(--text-faint));
}
.err {
  color: rgb(var(--danger));
}
</style>
