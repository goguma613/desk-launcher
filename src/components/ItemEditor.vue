<script setup>
import { onMounted, ref } from "vue";
import Sheet from "./Sheet.vue";
import AppIcon from "./AppIcon.vue";
import IconPicker from "./IconPicker.vue";

const props = defineProps({
  item: { type: Object, required: true },
  tabs: { type: Array, required: true },
  currentTabId: { type: String, required: true },
  /** 대상 경로를 찾을 수 없는 항목인지 */
  missing: { type: Boolean, default: false },
});
const emit = defineEmits(["close", "remove", "move-to-tab", "relocate"]);

const confirming = ref(false);
const nameInput = ref(null);
const targetTab = ref(props.currentTabId);

// 열자마자 이름을 고칠 수 있게 합니다. 시트를 연 이유가 대개 그것입니다.
onMounted(() => {
  nameInput.value?.focus();
  nameInput.value?.select();
});

function setIcon(icon) {
  props.item.icon = icon;
}
</script>

<template>
  <Sheet title="항목 편집" @close="emit('close')">
    <div class="preview">
      <AppIcon :item="item" :box="40" />
      <!-- 경로는 앞을 잘라야 쓸모가 있습니다. 뒤쪽이 정보라서요. -->
      <p class="path" :title="item.path" dir="rtl">{{ item.path }}</p>
    </div>

    <div v-if="missing" class="gone-note">
      <span>이 경로를 찾을 수 없습니다. 프로그램을 옮겼거나 지웠을 수 있습니다.</span>
      <button class="btn" @click="emit('relocate')">새 위치 찾기…</button>
    </div>

    <section>
      <label class="field-label" for="item-name">이름</label>
      <input
        id="item-name"
        ref="nameInput"
        v-model="item.name"
        class="text-input"
        type="text"
        maxlength="60"
        spellcheck="false"
      />
    </section>

    <section v-if="item.kind === 'url'">
      <label class="field-label" for="item-url">주소</label>
      <input
        id="item-url"
        v-model="item.path"
        class="text-input"
        type="text"
        spellcheck="false"
      />
    </section>

    <section>
      <span class="field-label">아이콘</span>
      <IconPicker :icon="item.icon" @update="setIcon" />
    </section>

    <section v-if="tabs.length > 1">
      <label class="field-label" for="item-tab">탭 옮기기</label>
      <div class="move-row">
        <!-- 고르는 즉시 옮기면 목록을 훑다가 실수합니다. 버튼을 눌러야 적용됩니다. -->
        <select id="item-tab" v-model="targetTab" class="text-input">
          <option v-for="t in tabs" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
        <button
          class="btn"
          :disabled="targetTab === currentTabId"
          @click="emit('move-to-tab', targetTab)"
        >
          옮기기
        </button>
      </div>
      <p class="hint">타일을 탭 위로 끌어다 놓아도 됩니다.</p>
    </section>

    <template #footer>
      <template v-if="confirming">
        <span class="confirm-text">정말 지울까요?</span>
        <button class="btn" @click="confirming = false">취소</button>
        <button class="btn danger" @click="emit('remove')">삭제</button>
      </template>
      <template v-else>
        <button class="btn danger" @click="confirming = true">삭제</button>
        <button class="btn primary" @click="emit('close')">완료</button>
      </template>
    </template>
  </Sheet>
</template>

<style scoped>
.preview {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
  border-radius: var(--radius-tile);
  background: rgb(var(--tile) / var(--surface-alpha));
}

/* dir="rtl" + ellipsis 로 앞 말줄임을 만듭니다 */
.path {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-caption);
  line-height: 1.45;
  color: rgb(var(--text-faint));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

section {
  display: block;
}

.gone-note {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-tile);
  background: rgb(var(--danger) / 0.12);
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: rgb(var(--text-item));
}

.confirm-text {
  margin-right: auto;
  font-size: var(--fs-caption);
  color: rgb(var(--text-dim));
}

.move-row {
  display: flex;
  gap: var(--space-2);
}
.move-row .text-input {
  flex: 1 1 0;
  width: auto;
  min-width: 0;
}
.move-row .btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.hint {
  margin: var(--space-2) 0 0;
  font-size: var(--fs-caption);
  color: rgb(var(--text-faint));
}

select.text-input {
  appearance: none;
  cursor: pointer;
}
</style>
