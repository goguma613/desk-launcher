/**
 * 폴백 아이콘 8종 — docs/design-handoff.md "폴백 아이콘 8종"
 *
 * Windows 실제 아이콘 추출에 실패했을 때만 나오므로 종류를 줄였습니다.
 * 사양은 24 × 24 viewBox, 스트로크 1.6px, 라운드 캡·조인, 면 채움 없음,
 * 색은 currentColor(`--icon-fallback`)입니다.
 *
 * 박스 안 아이콘 크기는 40px 박스에 22px, 44px 박스에 24px입니다.
 */
export const BUILTIN_ICONS = {
  app: {
    label: "실행 파일",
    body: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17"/><path d="M10.5 12.4l4.2 2.3-4.2 2.3z"/>',
  },
  folder: {
    label: "폴더",
    body: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  },
  document: {
    label: "문서",
    body: '<path d="M6.5 3.5h6.5L18 8.5v12h-11.5z"/><path d="M13 3.5V9h5"/><path d="M9.5 13h5M9.5 16.5h5"/>',
  },
  image: {
    label: "이미지",
    body: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4.5 17.5l4-4 3.5 3.5 3-3 4.5 4.5"/>',
  },
  link: {
    label: "웹링크",
    body: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.4 3.5 5.3 3.5 8.5S14.3 18.1 12 20.5c-2.3-2.4-3.5-5.3-3.5-8.5S9.7 5.9 12 3.5z"/>',
  },
  game: {
    label: "게임",
    body: '<path d="M7.6 8.5h8.8a4.4 4.4 0 0 1 4.3 5.3l-.5 2.3a2.3 2.3 0 0 1-4 1.1l-1.4-1.5H9.2l-1.4 1.5a2.3 2.3 0 0 1-4-1.1l-.5-2.3a4.4 4.4 0 0 1 4.3-5.3z"/><path d="M7.3 11.2v2.3M6.1 12.4h2.3"/><circle cx="15.5" cy="11.7" r=".95"/><circle cx="17.4" cy="13.5" r=".95"/>',
  },
  tool: {
    label: "도구",
    body: '<path d="M16.2 3.8a4.8 4.8 0 0 0-5.6 6.2l-6.2 6.2a2 2 0 1 0 2.8 2.8l6.2-6.2a4.8 4.8 0 0 0 6.2-5.6l-2.9 2.9-2.4-.6-.6-2.4z"/>',
  },
  star: {
    label: "기타",
    body: '<path d="M12 3.8l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.75-5.2 2.75 1-5.8-4.2-4.1 5.8-.85z"/>',
  },
};

export const BUILTIN_KEYS = Object.keys(BUILTIN_ICONS);

/** UI 아이콘 (버튼용). 폴백 세트와 분리해 둡니다. */
export const UI_ICONS = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.6v2.8M12 18.6v2.8M21.4 12h-2.8M5.4 12H2.6M18.6 5.4l-2 2M7.4 16.6l-2 2M18.6 18.6l-2-2M7.4 7.4l-2-2"/>',
  pencil:
    '<path d="M4 20l.9-3.8L16 5.1a2 2 0 0 1 2.8 0l.1.1a2 2 0 0 1 0 2.8L7.8 19.1z"/><path d="M14.4 6.7l2.9 2.9"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash:
    '<path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"/><path d="M6.5 6.5l.9 12.2a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.2"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  power: '<path d="M12 3.5v8"/><path d="M7.4 6.6a7.5 7.5 0 1 0 9.2 0"/>',
  folderOpen:
    '<path d="M3.5 17.5V7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h6A1.5 1.5 0 0 1 18.5 9.5v1"/><path d="M3.5 17.5l2.4-6.1A1.5 1.5 0 0 1 7.3 10.5H21l-2.4 6.1a1.5 1.5 0 0 1-1.4 1H5a1.5 1.5 0 0 1-1.5-1.1z"/>',
  drop: '<path d="M12 15.5V4.5" /><path d="M8.2 8.3L12 4.5l3.8 3.8" /><path d="M4.5 14.5v3.2a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-3.2" />',
};

/**
 * 폴백 아이콘 추론. 확장자를 못 알아보면 null을 돌려주고,
 * 그때는 이름 첫 글자로 대체합니다.
 *
 * 폴백 세트가 8종뿐이라 음악·영상은 「기타」로, 압축·스크립트는 「도구」로 모읍니다. Windows 실제
 * 아이콘 추출이 먼저 돌기 때문에 여기까지 내려오는 경우는 드뭅니다.
 */
const EXT_MAP = {
  exe: "app",
  lnk: "app",
  bat: "app",
  cmd: "app",
  msi: "app",
  com: "app",
  appref: "app",

  url: "link",
  html: "link",
  htm: "link",

  txt: "document",
  md: "document",
  rtf: "document",
  pdf: "document",
  doc: "document",
  docx: "document",
  hwp: "document",
  hwpx: "document",
  xls: "document",
  xlsx: "document",
  csv: "document",
  ppt: "document",
  pptx: "document",

  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  psd: "image",

  ps1: "tool",
  sh: "tool",
  reg: "tool",
  ini: "tool",
  cfg: "tool",
  json: "tool",
  xml: "tool",
  zip: "tool",
  "7z": "tool",
  rar: "tool",
  tar: "tool",
  gz: "tool",
  iso: "tool",
};

export function guessIconKey(item) {
  if (item.kind === "url") return "link";
  if (item.kind === "folder") return "folder";
  return EXT_MAP[item.ext || ""] || null;
}
