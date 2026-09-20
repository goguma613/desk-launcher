//! Windows 실제 아이콘 추출.
//!
//! 탐색기가 쓰는 `IShellItemImageFactory::GetImage`를 그대로 씁니다. exe·폴더·
//! .lnk·스토어 앱이 모두 같은 경로로 처리되고, 최대 256px까지 뽑을 수 있습니다.
//!
//! 핸드오프 문서에서 짚은 함정 네 가지를 여기서 처리합니다.
//!   - 알파: GetDIBits로 받은 premultiplied BGRA를 straight RGBA로 되돌립니다.
//!   - 캐시: 추출한 PNG를 appdata에 저장해 다음 실행부터는 바로 씁니다.
//!   - .lnk: 대상을 풀지 않고 .lnk 경로를 그대로 넘깁니다.
//!   - 캐시 무효화: 대상 파일의 mtime을 캐시 파일 이름에 넣어, 프로그램이
//!     업데이트되면 자동으로 다시 뽑습니다.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 추출 결과의 메모리 캐시. 키는 "<경로>|<크기>", 값은 data URL(실패면 None).
pub struct IconCache(pub Mutex<HashMap<String, Option<String>>>);

impl IconCache {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// 대상 파일의 수정 시각(초). 읽지 못하면 0.
fn mtime_of(path: &str) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_file(dir: &Path, path: &str, size: u32) -> (PathBuf, String) {
    let stem = format!("{:016x}-{}", fnv1a(path), size);
    let name = format!("{}-{}.png", stem, mtime_of(path));
    (dir.join(&name), stem)
}

/// 같은 대상의 옛 mtime 캐시 파일을 지웁니다.
fn prune_stale(dir: &Path, stem: &str, keep: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p == keep {
            continue;
        }
        let matches = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with(stem))
            .unwrap_or(false);
        if matches {
            let _ = fs::remove_file(&p);
        }
    }
}

pub fn to_data_url(png_bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png_bytes)
    )
}

/// 등록된 항목에 더 이상 쓰이지 않는 캐시 파일을 지웁니다.
///
/// 항목을 넣었다 뺐다 하면 PNG가 계속 쌓이기만 했습니다. 파일 이름이
/// `<해시>-<크기>-<mtime>.png` 라서, 앞의 `<해시>-<크기>`만 맞춰 보면 됩니다.
pub fn prune_orphans(dir: &Path, keep_paths: &[String], size: u32) {
    use std::collections::HashSet;

    let keep: HashSet<String> = keep_paths
        .iter()
        .filter(|p| !p.starts_with("http://") && !p.starts_with("https://"))
        .map(|p| format!("{:016x}-{}", fnv1a(p), size))
        .collect();

    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(base) = name.strip_suffix(".png") else {
            continue;
        };
        // "<해시>-<크기>-<mtime>" 에서 마지막 mtime을 떼어냅니다.
        let Some((stem, _mtime)) = base.rsplit_once('-') else {
            continue;
        };
        if !keep.contains(stem) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// 사용자가 고른 이미지를 아이콘용 PNG로 만들어 저장하고 파일 이름을 돌려줍니다.
///
/// 예전에는 원본을 base64로 state.json 안에 넣었습니다. 2MB짜리 몇 개면
/// 설정 파일이 10MB로 불어나고, 창을 움직일 때마다 그 전체를 다시 썼습니다.
pub fn store_user_icon(user_dir: &Path, src: &str) -> Result<String, String> {
    fs::create_dir_all(user_dir).map_err(|e| e.to_string())?;

    // 셸 썸네일로 뽑으면 jpg·webp도 되고 크기도 알아서 줄어듭니다.
    // 실패하면 원본을 그대로 씁니다(이미 PNG인 경우 등).
    let bytes = match extract_png(src, 256) {
        Ok(b) => b,
        Err(_) => {
            let raw = fs::read(src).map_err(|e| e.to_string())?;
            if raw.len() > MAX_USER_ICON_BYTES {
                return Err("이미지가 너무 큽니다. 2MB 이하 파일을 골라 주세요".into());
            }
            raw
        }
    };

    let name = format!("u{:016x}.png", fnv1a(&format!("{}|{}", src, mtime_of(src))));
    fs::write(user_dir.join(&name), &bytes).map_err(|e| e.to_string())?;
    Ok(name)
}

const MAX_USER_ICON_BYTES: usize = 2 * 1024 * 1024;

/// 경로 하나의 아이콘을 data URL로. 캐시를 먼저 보고 없으면 추출합니다.
pub fn icon_data_url(cache_dir: &Path, path: &str, size: u32) -> Option<String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        return None; // 웹링크는 파비콘 담당
    }

    let (file, stem) = cache_file(cache_dir, path, size);
    if let Ok(bytes) = fs::read(&file) {
        return Some(to_data_url(&bytes));
    }

    let bytes = extract_png(path, size).ok()?;
    if fs::create_dir_all(cache_dir).is_ok() && fs::write(&file, &bytes).is_ok() {
        prune_stale(cache_dir, &stem, &file);
    }
    Some(to_data_url(&bytes))
}

// ---------------------------------------------------------------------------
// 추출 본체
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub fn extract_png(path: &str, size: u32) -> Result<Vec<u8>, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
        SIIGBF_RESIZETOFIT,
    };

    if !Path::new(path).exists() {
        return Err("경로가 없습니다".into());
    }

    unsafe {
        // 같은 스레드에서 여러 번 불러도 안전합니다(이미 초기화면 S_FALSE).
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path), None)
                .map_err(|e| format!("셸 항목을 만들지 못했습니다: {e}"))?;

        let hbitmap = factory
            .GetImage(
                SIZE {
                    cx: size as i32,
                    cy: size as i32,
                },
                SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK,
            )
            .map_err(|e| format!("아이콘을 뽑지 못했습니다: {e}"))?;

        let decoded = bitmap_to_rgba(hbitmap);
        let _ = DeleteObject(HGDIOBJ(hbitmap.0));

        let (w, h, rgba) = decoded?;
        encode_png(w, h, &rgba)
    }
}

#[cfg(not(windows))]
pub fn extract_png(_path: &str, _size: u32) -> Result<Vec<u8>, String> {
    Err("Windows에서만 지원합니다".into())
}

#[cfg(windows)]
unsafe fn bitmap_to_rgba(
    hbitmap: windows::Win32::Graphics::Gdi::HBITMAP,
) -> Result<(u32, u32, Vec<u8>), String> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HGDIOBJ,
    };

    let mut info = BITMAP::default();
    let read = GetObjectW(
        HGDIOBJ(hbitmap.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut info as *mut _ as *mut c_void),
    );
    if read == 0 {
        return Err("비트맵 정보를 읽지 못했습니다".into());
    }

    let w = info.bmWidth.max(0) as u32;
    let h = info.bmHeight.max(0) as u32;
    if w == 0 || h == 0 {
        return Err("비트맵 크기가 0입니다".into());
    }

    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            // 음수 높이 = top-down. 양수로 두면 상하가 뒤집힙니다.
            biHeight: -(h as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            ..Default::default()
        },
        ..Default::default()
    };

    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let hdc = GetDC(None);
    let lines = GetDIBits(
        hdc,
        hbitmap,
        0,
        h,
        Some(buf.as_mut_ptr() as *mut c_void),
        &mut bi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);

    if lines == 0 {
        return Err("픽셀을 읽지 못했습니다".into());
    }

    // 알파 채널이 통째로 0인 소스가 있습니다. 그대로 쓰면 전부 투명해집니다.
    let has_alpha = buf.chunks_exact(4).any(|px| px[3] != 0);

    for px in buf.chunks_exact_mut(4) {
        let (b, g, r, a) = (px[0], px[1], px[2], px[3]);

        if !has_alpha {
            px[0] = r;
            px[1] = g;
            px[2] = b;
            px[3] = 255;
            continue;
        }
        if a == 0 {
            px[0] = 0;
            px[1] = 0;
            px[2] = 0;
            px[3] = 0;
            continue;
        }

        // premultiplied → straight. 이걸 빼먹으면 아이콘 가장자리에 검은 띠가 생깁니다.
        let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
        px[0] = un(r);
        px[1] = un(g);
        px[2] = un(b);
        px[3] = a;
    }

    Ok((w, h, buf))
}

fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(std::io::Cursor::new(&mut out), w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(rgba)
            .map_err(|e| e.to_string())?;
    }
    Ok(out)
}
