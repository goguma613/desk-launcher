import { state } from "./store";

/* ===========================================================================
   프리셋 치수 — docs/design-handoff.md "화면 구성과 치수"
   ---------------------------------------------------------------------------
   여기 값과 ItemGrid.vue의 .tile / .name 값은 한 세트입니다. 한쪽만 바꾸면
   창 높이가 어긋나 마지막 행이 잘립니다.

   세 프리셋 모두 내부 구조는 탭 바 → 항목 격자 → 푸터 순이고,
   달라지는 것은 방향과 컬럼 수뿐입니다.
     right  · center — 세로로 쌓임 (탭 바 위, 푸터 아래)
     bottom          — 가로로 늘어섬 (탭 바 왼쪽, 푸터 오른쪽)
   =========================================================================== */

export const PRESETS = [
  {
    key: "right",
    label: "우측 세로 패널",
    hint: "화면 오른쪽에 세로로. 상시 띄워두는 용도",
  },
  {
    key: "bottom",
    label: "하단 가로 바",
    hint: "작업표시줄 위쪽에 가로로",
  },
  {
    key: "center",
    label: "중앙 박스",
    hint: "화면 가운데. 단축키로 불러낼 때",
  },
];

export const MODES = [
  {
    key: "desktop",
    label: "바탕화면 고정",
    hint: "항상 맨 아래. 다른 창을 띄우면 뒤로 숨습니다",
  },
  {
    key: "overlay",
    label: "오버레이",
    hint: "항상 맨 위. 단축키로 켜고 끕니다",
  },
];

/**
 * 그림자 자리.
 *
 * 창 크기를 패널에 딱 맞추면 바깥으로 번지는 그림자가 웹뷰 경계에서 잘려
 * 아예 보이지 않습니다. 그래서 창을 그만큼 크게 잡고 패널을 안쪽으로 물립니다.
 *
 * 여백은 투명하지만 클릭은 창이 먹습니다. 그래서 꼭 필요한 쪽에만 둡니다.
 *   right  — 오른쪽은 화면 가장자리에 밀착하므로 0
 *   bottom — 폭 100%라 좌우는 0. 작업표시줄 위 8px 간격을 그림자 자리로 씁니다
 *   center — 불러내는 창이라 사방에 둬도 무방
 */
const PAD = {
  right: { top: 24, right: 0, bottom: 24, left: 26 },
  bottom: { top: 0, right: 0, bottom: 8, left: 0 },
  center: { top: 30, right: 28, bottom: 30, left: 28 },
};

export function shadowPad(preset = state.settings.preset) {
  return PAD[preset] || PAD.right;
}

/** 셀 안의 아이콘 박스 크기. 세로 패널·가로 바 40px, 중앙 박스 44px. */
const SPEC = {
  right: {
    axis: "vertical",
    width: 300,
    cols: 3,
    cellW: 90,
    cellH: 81,
    iconBox: 40,
    header: 41, // 탭 바
    footer: 45,
    padY: 12, // 격자 상하
    nameMax: 78, // 이름 최대 폭
  },
  bottom: {
    axis: "horizontal",
    height: 96,
    cols: 0, // 한 줄, 가로 스크롤
    cellW: 84,
    cellH: 76,
    iconBox: 40,
    padY: 9,
    nameMax: 76,
  },
  center: {
    axis: "vertical",
    width: 720,
    maxHeight: 520,
    cols: 6,
    cellW: 105,
    cellH: 96,
    iconBox: 44,
    header: 41,
    footer: 45,
    padY: 12,
    nameMax: 92,
  },
};

const GAP = 4; // --tile-gap
const BORDER = 2; // 패널 위아래 테두리 1px씩
// 빈 탭일 때 항목 영역 높이. 점선 박스 안에 아이콘 22 + 안내 2줄 + 버튼 24가
// 들어가고 박스 패딩 10과 격자 패딩 12가 위아래로 붙습니다.
const EMPTY_BODY = 134;
const NAMELESS_DROP = 21; // 「항목 이름 표시」를 끄면 셀 높이가 81 → 60

/** 이름 표시를 끄면 셀이 낮아집니다. 시안 기준 81px → 60px. */
export function cellHeight(preset = state.settings.preset) {
  const spec = SPEC[preset] || SPEC.right;
  return state.settings.showNames ? spec.cellH : spec.cellH - NAMELESS_DROP;
}

export function spec(preset = state.settings.preset) {
  return SPEC[preset] || SPEC.right;
}

export function gridColumns() {
  return spec().cols;
}

export function iconBox() {
  return spec().iconBox;
}

/**
 * 창 높이를 정할 기준 항목 수.
 *
 * 빈 탭은 시안대로 최소 높이로 줄어듭니다. 항목이 있는 탭끼리는 **가장 많은
 * 탭을 기준**으로 크기를 고정합니다. 탭마다 제 항목 수로 계산하면 6개 탭에서
 * 30개 탭으로 넘어갈 때 세로 중앙 정렬 탓에 창이 위아래로 크게 튑니다.
 */
function sizingCount() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0];
  if (!tab || tab.items.length === 0) return 0;
  return state.tabs.reduce((max, t) => Math.max(max, t.items.length), 0);
}

/**
 * 현재 설정 + 작업 영역으로 창 크기를 계산합니다. 단위는 CSS 픽셀.
 *
 * 폭은 고정, 높이만 항목 수에 따라 늘어납니다. 해상도가 바뀐다고 셀이나
 * 글자를 키우지 않고 들어가는 줄 수만 달라집니다.
 * 최대 높이는 작업 영역(작업표시줄 제외) 세로의 82%입니다.
 */
export function windowSize(area) {
  const s = state.settings;
  const sp = spec(s.preset);
  const pad = shadowPad(s.preset);
  const padX = pad.left + pad.right;
  const padY = pad.top + pad.bottom;

  const count = sizingCount();
  const cell = cellHeight(s.preset);
  // 최대 높이는 시안대로 작업 영역의 82%. 그림자 자리는 그 밖입니다.
  const maxH = area.height * 0.82;

  if (s.preset === "bottom") {
    // 폭 100%, 높이 고정 한 줄
    return { width: area.width, height: sp.height + padY };
  }

  const rows = count > 0 ? Math.ceil(count / sp.cols) : 0;
  const body =
    rows > 0 ? sp.padY * 2 + rows * cell + (rows - 1) * GAP : EMPTY_BODY;
  const panel = sp.header + body + sp.footer + BORDER;

  const cap =
    s.preset === "center" ? Math.min(sp.maxHeight, maxH) : maxH;

  return {
    width: sp.width + padX,
    height: clamp(panel, 200, cap) + padY,
  };
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
