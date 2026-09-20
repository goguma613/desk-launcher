<script setup>
import { computed, ref, watch } from "vue";
import { BUILTIN_ICONS, guessIconKey } from "../icons";
import { extracted, isResolved, userIcon } from "../extractedIcons";

const props = defineProps({
  item: { type: Object, required: true },
  /** 아이콘 박스 크기. 세로 패널·가로 바 40, 중앙 박스 44 */
  box: { type: Number, default: 40 },
});

/* 파비콘은 두 단계로 시도합니다.
   0) 사이트가 직접 제공하는 /favicon.ico
   1) 구글 파비콘 서비스 (도메인 이름이 구글로 전달됩니다)
   2) 둘 다 실패하면 폴백 세트의 웹링크 아이콘 */
const faviconStage = ref(0);
watch(
  () => props.item.path,
  () => {
    faviconStage.value = 0;
  }
);

const host = computed(() => {
  if (props.item.kind !== "url") return "";
  try {
    return new URL(props.item.path).hostname;
  } catch {
    return "";
  }
});

const faviconSrc = computed(() => {
  if (!host.value) return "";
  if (faviconStage.value === 0) return `https://${host.value}/favicon.ico`;
  if (faviconStage.value === 1) {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
      host.value
    )}&sz=64`;
  }
  return "";
});

/** 사용자가 고른 이미지. state.json에는 파일 이름만 들어 있습니다. */
const custom = computed(() => {
  const icon = props.item.icon || { type: "auto" };
  if (icon.type !== "image" || !icon.value) return null;
  return userIcon(icon.value);
});

const realIcon = computed(() => {
  if (props.item.kind === "url") return null;
  return extracted(props.item.path) || null;
});

/* 적용 순서 — docs/design-handoff.md "아이콘 처리"
     1. 사용자가 직접 지정한 이미지
     2. 웹링크는 파비콘, 그 외에는 Windows에서 추출한 실제 아이콘
     3. 종류별 폴백 아이콘
     4. 이름 첫 글자                                                        */
const mode = computed(() => {
  const icon = props.item.icon || { type: "auto" };

  if (icon.type === "image" && icon.value) {
    // 파일을 읽는 동안에는 자리만 잡아 둡니다.
    return custom.value === undefined ? "pending" : custom.value ? "image" : "letter";
  }
  if (icon.type === "builtin" && BUILTIN_ICONS[icon.value]) return "builtin";

  if (host.value) return faviconSrc.value ? "favicon" : "builtin";
  if (realIcon.value) return "real";

  // 추출 결과를 아직 모르는 동안에는 빈 자리를 둡니다. 폴백을 먼저 그렸다가
  // 실제 아이콘으로 바뀌면 깜빡여 보입니다.
  if (!isResolved(props.item.path)) return "pending";

  return guessIconKey(props.item) ? "builtin" : "letter";
});

/** 실제 이미지(추출·파비콘·사용자 지정)는 박스 없이 그대로 얹습니다. */
const boxed = computed(() => mode.value === "builtin" || mode.value === "letter");

const builtinBody = computed(() => {
  const icon = props.item.icon || { type: "auto" };
  const key =
    icon.type === "builtin" && BUILTIN_ICONS[icon.value]
      ? icon.value
      : guessIconKey(props.item) || "star";
  return BUILTIN_ICONS[key].body;
});

const letter = computed(() => {
  const n = (props.item.name || props.item.path || "?").trim();
  return n ? n.charAt(0).toUpperCase() : "?";
});

/** 40px 박스에 22px, 44px 박스에 24px */
const glyph = computed(() => Math.round(props.box * 0.55));
</script>

<template>
  <span
    class="app-icon"
    :class="{ boxed }"
    :style="{ '--box': box + 'px', '--glyph': glyph + 'px' }"
  >
    <img v-if="mode === 'image'" class="shot" :src="custom" alt="" draggable="false" />

    <img
      v-else-if="mode === 'favicon'"
      :src="faviconSrc"
      alt=""
      draggable="false"
      @error="faviconStage += 1"
    />

    <img v-else-if="mode === 'real'" :src="realIcon" alt="" draggable="false" />

    <!-- 아직 모르는 동안 자리만. 폴백을 먼저 그렸다가 바뀌면 깜빡여 보입니다 -->
    <span v-else-if="mode === 'pending'" class="placeholder" />

    <svg
      v-else-if="mode === 'builtin'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      v-html="builtinBody"
    />

    <span v-else class="letter">{{ letter }}</span>
  </span>
</template>

<style scoped>
.app-icon {
  display: grid;
  place-items: center;
  width: var(--box);
  height: var(--box);
  flex: 0 0 auto;
  color: rgb(var(--icon-fallback));
  /* 누를 때 아이콘만 줄어듭니다. 이름은 고정.
     누름 80ms / 놓음 160ms — 누르는 쪽이 더 빨라야 반응이 붙습니다.
     (누를 때 값은 ItemGrid의 .tile:active 에서 덮습니다) */
  transition: transform var(--dur-leave) var(--ease);
}

/* 폴백만 배경 박스를 가집니다. 추출된 실제 아이콘은 이미 자기 배경과
   실루엣이 있어서 박스를 다시 씌우면 액자 안에 액자가 됩니다. */
.app-icon.boxed {
  background: rgb(var(--panel-raise));
  border-radius: var(--radius-fallback);
}

.app-icon img {
  /* 꽉 채우면 22px 폴백 글리프 옆에서 혼자 커 보입니다 */
  width: calc(100% - 4px);
  height: calc(100% - 4px);
  object-fit: contain;
  animation: icon-in var(--dur-hover) var(--ease);
}
/* 사용자가 고른 사진은 모서리를 깎아 줍니다. 추출 아이콘은 이미 제 실루엣이
   있어서 깎으면 모서리가 잘립니다. */
.app-icon img.shot {
  border-radius: var(--radius-icon);
}

.placeholder {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-fallback);
  background: rgb(var(--panel-raise) / 0.6);
}

.app-icon svg {
  width: var(--glyph);
  height: var(--glyph);
}

.letter {
  font-size: var(--fs-letter);
  font-weight: 700;
  line-height: 1;
  color: rgb(var(--icon-fallback));
}

@keyframes icon-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
