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
  const update = await check();
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body || "",
    // 설치하면 NSIS 설치 파일이 실행되면서 앱이 종료됩니다.
    install: () => update.downloadAndInstall(),
  };
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
