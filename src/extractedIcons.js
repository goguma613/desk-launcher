import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";

/**
 * Windows에서 뽑아온 실제 아이콘 캐시.
 *
 * 40~44px 박스에 넣지만 96px로 뽑습니다. QHD에서 64px 소스를 40px 박스에
 * 넣으면 흐릿합니다. 추출 결과는 Rust 쪽에서 appdata에 저장하므로 두 번째
 * 실행부터는 바로 나옵니다.
 */
const ICON_SIZE = 96;

/** 경로 → data URL | null(추출 실패). 키가 없으면 「아직 모름」입니다. */
const cache = reactive(new Map());
const inflight = new Set();

function isUrl(path) {
  return /^https?:\/\//i.test(path);
}

/** data URL, 추출 실패면 null, 아직 시도 전이면 undefined */
export function extracted(path) {
  return cache.get(path);
}

export function isResolved(path) {
  return cache.has(path);
}

/**
 * 여러 경로를 한 번에 채웁니다. 이미 알고 있거나 요청 중인 것은 건너뜁니다.
 * 창을 띄울 때 한 번 부르고, 항목을 새로 추가했을 때 또 부릅니다.
 */
export async function prefetch(paths) {
  const want = [...new Set(paths)].filter(
    (p) => p && !isUrl(p) && !cache.has(p) && !inflight.has(p)
  );
  if (!want.length) return;

  want.forEach((p) => inflight.add(p));
  try {
    const results = await invoke("icons_for", { paths: want, size: ICON_SIZE });
    want.forEach((p, i) => cache.set(p, results[i] ?? null));
  } catch (e) {
    console.error("아이콘을 뽑지 못했습니다", e);
    want.forEach((p) => cache.set(p, null));
  } finally {
    want.forEach((p) => inflight.delete(p));
  }
}

/** 이 창의 메모리 캐시만 비웁니다. 디스크 캐시는 Rust가 관리합니다. */
export function clearLocal() {
  cache.clear();
}

/**
 * 캐시를 비웁니다. 프로그램을 업데이트했는데 아이콘이 그대로일 때 씁니다.
 *
 * 메모리 캐시는 창마다 따로 있어서, 여기서 비워도 런처 창에는 반영되지
 * 않습니다. Rust가 `launcher://icons-cleared`를 쏘고 런처가 그걸 받아
 * 자기 캐시를 비운 뒤 다시 뽑습니다.
 */
export async function refreshAll() {
  await invoke("clear_icon_cache");
  cache.clear();
}

/** 등록된 항목에 쓰이지 않는 캐시 파일을 치웁니다. 시작할 때 한 번. */
export function pruneOrphans(paths) {
  invoke("prune_icon_cache", {
    paths: paths.filter((p) => p && !isUrl(p)),
    size: ICON_SIZE,
  }).catch((e) => console.error("캐시 정리 실패", e));
}

/* ---------------------------------------------------------------------------
   사용자가 고른 아이콘 이미지
   ---------------------------------------------------------------------------
   state.json에는 파일 이름만 들어갑니다. 예전에는 base64 원본을 통째로
   넣어서, 2MB짜리 몇 개만 지정해도 설정 파일이 10MB로 불어나고 창을 한 번
   움직일 때마다 그 전체를 다시 썼습니다.
   --------------------------------------------------------------------------- */

const userCache = reactive(new Map());
const userInflight = new Set();

/** data URL, 읽기 실패면 null, 아직 읽는 중이면 undefined */
export function userIcon(name) {
  if (!name) return null;
  // 예전 형식(data URL을 그대로 저장)도 계속 지원합니다.
  if (name.startsWith("data:")) return name;
  if (userCache.has(name)) return userCache.get(name);

  if (!userInflight.has(name)) {
    userInflight.add(name);
    invoke("user_icon_data_url", { name })
      .then((url) => userCache.set(name, url))
      .catch(() => userCache.set(name, null))
      .finally(() => userInflight.delete(name));
  }
  return undefined;
}
