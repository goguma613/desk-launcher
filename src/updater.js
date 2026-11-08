import { check } from "@tauri-apps/plugin-updater";

/**
 * GitHub Releases에서 새 버전을 확인합니다.
 *
 * 배포 쪽은 `docs/release.md` 참고. 요약하면 릴리스에 설치 파일과
 * `latest.json`을 올리면 됩니다. 서명이 맞지 않으면 여기서 거부합니다.
 *
 * @returns {Promise<{version: string, notes: string, install: () => Promise<void>} | null>}
 *          최신이면 null
 */
export async function findUpdate() {
  // 확인 주소는 두 곳입니다(tauri.conf.json plugins.updater.endpoints).
  // 릴리스 주소가 실패하면 플러그인이 저장소의 updater/latest.json 으로 넘어갑니다.
  // 둘 다 실패해도 GitHub가 잠깐 504를 내는 경우가 많아 한 번 더 시도합니다.
  const update = await retry(() => check());
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body || "",
    // 설치하면 NSIS 설치 파일이 실행되면서 앱이 종료됩니다.
    // 설치 파일은 릴리스에서만 받으므로, 내려받기가 끊기면 몇 번 다시 시도합니다.
    install: () => retry(() => update.downloadAndInstall(), 3),
  };
}

/**
 * GitHub 릴리스 다운로드는 가끔 몇 초씩 504를 냅니다(2026-11-08 v0.3.3 배포 때
 * 다섯 번 중 세 번 실패). 잠깐 쉬었다 다시 하면 대개 됩니다.
 */
async function retry(fn, attempts = 2, delayMs = 1500) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

/**
 * 조용히 확인합니다. 네트워크가 없거나 GitHub가 응답하지 않으면
 * 아무 일도 없었던 것처럼 넘어갑니다.
 */
export async function findUpdateQuietly() {
  try {
    return await findUpdate();
  } catch (e) {
    console.error("업데이트 확인 실패", e);
    return null;
  }
}
