# 새 버전 내보내기

앱이 GitHub Releases를 보고 스스로 업데이트합니다. 새 버전을 내보낼 때
아래 네 단계를 그대로 따르면 됩니다.

## 0. 준비 — 처음 한 번만

서명 키가 있어야 합니다. 이미 만들어 두었습니다.

```
C:\Users\<사용자>\.tauri\desk-launcher.key       비밀 키 — 절대 공개 금지
C:\Users\<사용자>\.tauri\desk-launcher.key.pub   공개 키 — tauri.conf.json 에 박혀 있음
```

**비밀 키를 잃어버리면 이미 설치된 런처에 업데이트를 내보낼 수 없습니다.**
새 키로 서명하면 서명이 맞지 않아 앱이 거부하고, 쓰던 PC마다 손으로 다시
설치해야 합니다.

빌드는 이 PC에서만 합니다. 그래도 **키 파일은 따로 백업해 두세요** —
옮기기 위해서가 아니라 이 PC가 고장 났을 때를 위해서입니다. 텍스트 파일
하나이니 USB나 클라우드에 복사해 두면 됩니다. 저장소에는 절대 올리지 마세요
(`.gitignore` 에 `*.key` 가 들어 있습니다).

## 1. 버전 올리기

`src-tauri/tauri.conf.json` 의 `version` 을 올립니다. 이 값 하나가 기준입니다.

```json
"version": "0.2.0"
```

## 2. 서명해서 빌드

비밀 키 경로를 환경 변수로 걸고 빌드합니다. 이걸 빼먹으면 `.sig` 파일이
안 나오고 업데이트가 동작하지 않습니다.

```bash
TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/desk-launcher.key" npm run tauri build
```

PowerShell이라면:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\desk-launcher.key"
npm run tauri build
```

## 3. latest.json 만들기

```bash
node scripts/release.mjs "바뀐 내용 한 줄"
```

`src-tauri/target/release/bundle/nsis/latest.json` 이 생기고, 마지막에
릴리스를 올리는 명령이 출력됩니다.

## 4. 릴리스 올리기

3단계가 출력한 `gh release create ...` 를 그대로 실행합니다. 올려야 할
파일은 두 개입니다.

| 파일 | 역할 |
| --- | --- |
| `DeskLauncher_<버전>_x64-setup.exe` | 설치 파일 |
| `latest.json` | 앱이 보고 판단하는 목록 |

태그는 `v0.2.0` 형식이어야 합니다. `latest.json` 안의 다운로드 URL이 그
태그를 가리키기 때문입니다.

---

## 사용자 쪽에서 일어나는 일

- 런처를 켜면 조용히 확인하고, 새 버전이 있으면 알림만 띄웁니다
- 설정 창 「업데이트」 섹션에서 직접 확인하고 설치할 수 있습니다
- 설치를 누르면 내려받아 설치 프로그램을 실행하고 런처가 잠시 꺼집니다
- 서명이 맞지 않으면 앱이 거부합니다. 공개 키가 짝이 맞아야 합니다

## 막힐 때

**「최신 버전입니다」만 나온다** — `latest.json` 의 `version` 이 현재 설치된
버전보다 높은지 확인하세요. 같거나 낮으면 업데이트로 치지 않습니다.

**서명 오류가 난다** — 빌드할 때 `TAURI_SIGNING_PRIVATE_KEY_PATH` 를 안 걸었거나,
`tauri.conf.json` 의 `pubkey` 가 다른 키의 것입니다.

**릴리스는 올렸는데 못 찾는다** — `latest.json` 이 **latest 릴리스**에 붙어
있어야 합니다. 초안(draft)이나 사전 배포(pre-release)로 올리면 안 보입니다.
