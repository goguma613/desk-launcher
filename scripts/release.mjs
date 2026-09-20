/**
 * 릴리스 준비 — 빌드 산출물에서 `latest.json` 을 만듭니다.
 *
 *   npm run tauri build          (TAURI_SIGNING_PRIVATE_KEY_PATH 를 걸고)
 *   node scripts/release.mjs
 *   gh release create v0.1.0 ... (아래에 출력되는 명령 그대로)
 *
 * 자세한 순서는 docs/release.md 를 보세요.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));

const version = conf.version;
const product = conf.productName;
const endpoint = conf.plugins?.updater?.endpoints?.[0] ?? "";

// 엔드포인트에서 owner/repo 를 뽑아 다운로드 URL을 만듭니다.
const m = endpoint.match(/github\.com\/([^/]+)\/([^/]+)\//);
if (!m) {
  console.error("tauri.conf.json 의 plugins.updater.endpoints 를 먼저 채우세요.");
  process.exit(1);
}
const [, owner, repo] = m;

const nsisDir = join(root, "src-tauri/target/release/bundle/nsis");
const setup = `${product}_${version}_x64-setup.exe`;
const setupPath = join(nsisDir, setup);
const sigPath = `${setupPath}.sig`;

for (const [label, p] of [["설치 파일", setupPath], ["서명", sigPath]]) {
  if (!existsSync(p)) {
    console.error(`${label}을 찾지 못했습니다: ${p}`);
    console.error("서명 키를 걸고 `npm run tauri build` 를 먼저 돌리세요.");
    process.exit(1);
  }
}

const tag = `v${version}`;
const manifest = {
  version,
  notes: process.argv[2] || `${product} ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${setup}`,
    },
  },
};

const manifestPath = join(nsisDir, "latest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`latest.json 생성: ${manifestPath}`);
console.log("");
console.log("이제 이 명령으로 릴리스를 올리세요:");
console.log("");
console.log(
  [
    `gh release create ${tag}`,
    `  "${setupPath}"`,
    `  "${manifestPath}"`,
    `  --repo ${owner}/${repo}`,
    `  --title "${product} ${version}"`,
    `  --notes "${manifest.notes}"`,
  ].join(" \\\n")
);
