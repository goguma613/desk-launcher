mod icon;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use icon::IconCache;

// ---------------------------------------------------------------------------
// 앱 전역 상태
// ---------------------------------------------------------------------------

/// 현재 등록된 전역 단축키. 설정에서 바꿀 때 이전 것을 해제하기 위해 들고 있는다.
struct Shortcut(Mutex<Option<String>>);

/// 창이 "바탕화면 고정"(맨 아래 레이어)인지 여부.
/// 창이 포커스를 받으면 Windows가 자동으로 앞으로 끌어올리기 때문에,
/// 이 값이 true면 포커스 직후 다시 맨 아래로 내려보낸다.
struct Layer(Mutex<bool>);

/// 바탕화면 고정 모드에서 단축키로 잠깐 앞으로 불러낸 상태.
/// 이 동안에는 포커스를 받아도 다시 내리지 않고, 포커스를 잃을 때 내린다.
struct Surfaced(Mutex<bool>);

/// state.json 쓰기 직렬화용.
/// 런처 창과 설정 창이 동시에 저장하면 임시 파일을 서로 덮어써 파일이 깨진다.
struct SaveLock(Mutex<()>);

// ---------------------------------------------------------------------------
// Win32 헬퍼
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn hwnd_of(window: &Window) -> Result<windows::Win32::Foundation::HWND, String> {
    use windows::Win32::Foundation::HWND;
    let raw = window.hwnd().map_err(|e| e.to_string())?;
    Ok(HWND(raw.0 as _))
}

/// 창이 놓인 모니터의 작업 영역(작업표시줄을 뺀 영역)을 물리 픽셀로 돌려준다.
#[cfg(windows)]
fn work_area_physical(hwnd: windows::Win32::Foundation::HWND) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let r = info.rcWork;
            Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
        } else {
            None
        }
    }
}

fn apply_layer(window: &Window, bottom: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
            SWP_NOSIZE,
        };

        let hwnd = hwnd_of(window)?;
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;

        unsafe {
            if bottom {
                // TOPMOST 상태에서 바로 HWND_BOTTOM으로 보내면 무시되므로 먼저 해제한다.
                SetWindowPos(hwnd, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags)
                    .map_err(|e| e.to_string())?;
                SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, flags)
                    .map_err(|e| e.to_string())?;
            } else {
                SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, flags)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window.set_always_on_top(!bottom);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 디스플레이 변경 감시
// ---------------------------------------------------------------------------

/// 모니터를 바꾸거나 해상도·배율·작업표시줄이 달라지면 창 크기와 위치를
/// 다시 잡아야 한다. Tauri가 이 메시지들을 올려주지 않아서 런처 창을
/// 서브클래싱해 직접 받는다.
#[cfg(windows)]
mod display_watch {
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

    const WM_SETTINGCHANGE: u32 = 0x001A;
    const WM_DISPLAYCHANGE: u32 = 0x007E;
    const WM_DPICHANGED: u32 = 0x02E0;
    const SPI_SETWORKAREA: u32 = 0x002F;

    unsafe extern "system" fn watch_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        let interesting = msg == WM_DISPLAYCHANGE
            || msg == WM_DPICHANGED
            || (msg == WM_SETTINGCHANGE && wparam.0 as u32 == SPI_SETWORKAREA);

        if interesting && data != 0 {
            let app = &*(data as *const AppHandle);
            let _ = app.emit("launcher://display-changed", ());
        }

        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn attach(app: &AppHandle) {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let Ok(raw) = win.hwnd() else {
            return;
        };
        // 서브클래스가 사는 동안 AppHandle도 살아 있어야 한다.
        // 앱 수명과 같으므로 그대로 흘려보낸다.
        let handle = Box::into_raw(Box::new(app.clone())) as usize;
        unsafe {
            let _ = SetWindowSubclass(HWND(raw.0 as _), Some(watch_proc), 1, handle);
        }
    }
}

// ---------------------------------------------------------------------------
// 창 위치 / 크기
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct WorkArea {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

fn work_area_logical(window: &Window) -> Result<WorkArea, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        let hwnd = hwnd_of(window)?;
        if let Some((x, y, w, h)) = work_area_physical(hwnd) {
            return Ok(WorkArea {
                x: x as f64 / scale,
                y: y as f64 / scale,
                width: w as f64 / scale,
                height: h as f64 / scale,
                scale,
            });
        }
    }

    // Win32 정보를 못 읽었을 때는 모니터 전체 크기로 대체한다.
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "모니터 정보를 읽지 못했습니다".to_string())?;
    let size = monitor.size();
    let pos = monitor.position();
    Ok(WorkArea {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        scale,
    })
}

#[tauri::command]
fn work_area(window: Window) -> Result<WorkArea, String> {
    work_area_logical(&window)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Placement {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// 오프셋을 뺀 프리셋 기본 위치. 사용자가 창을 끌어 옮겼을 때
    /// 프런트엔드가 여기서 오프셋을 역산한다.
    base_x: f64,
    base_y: f64,
}

/// 프리셋에 맞춰 창 크기와 위치를 잡는다. 단위는 모두 논리(CSS) 픽셀.
///
/// 앵커 규칙은 시안을 그대로 따른다.
///   right  — 우측 가장자리에 밀착, 세로 중앙 정렬
///   bottom — 폭 100%, 작업표시줄 위 8px
///   center — 화면 정중앙
#[tauri::command]
fn place_window(
    window: Window,
    preset: String,
    width: f64,
    height: f64,
    off_x: f64,
    off_y: f64,
) -> Result<Placement, String> {
    // 작업표시줄 위 8px 간격은 프런트엔드가 그림자 자리(pad.bottom)로 잡아
    // 창 높이에 이미 포함되어 있다. 여기서 또 띄우면 16px이 된다.
    const BOTTOM_GAP: f64 = 0.0;

    let area = work_area_logical(&window)?;
    let w = width.min(area.width).max(160.0);
    let h = height.min(area.height).max(80.0);

    let (base_x, base_y) = match preset.as_str() {
        "right" => (
            area.x + area.width - w,
            area.y + (area.height - h) / 2.0,
        ),
        "bottom" => (
            area.x + (area.width - w) / 2.0,
            area.y + area.height - h - BOTTOM_GAP,
        ),
        // "center" 및 알 수 없는 값
        _ => (
            area.x + (area.width - w) / 2.0,
            area.y + (area.height - h) / 2.0,
        ),
    };

    let x = (base_x + off_x).clamp(area.x, area.x + area.width - w);
    let y = (base_y + off_y).clamp(area.y, area.y + area.height - h);

    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    Ok(Placement {
        x,
        y,
        width: w,
        height: h,
        base_x,
        base_y,
    })
}

fn is_pinned(window: &Window) -> bool {
    window
        .try_state::<Layer>()
        .and_then(|s| s.0.lock().ok().map(|v| *v))
        .unwrap_or(false)
}

fn is_surfaced(window: &Window) -> bool {
    window
        .try_state::<Surfaced>()
        .and_then(|s| s.0.lock().ok().map(|v| *v))
        .unwrap_or(false)
}

#[tauri::command]
fn set_layer(window: Window, bottom: bool) -> Result<(), String> {
    if let Some(state) = window.try_state::<Layer>() {
        if let Ok(mut flag) = state.0.lock() {
            *flag = bottom;
        }
    }
    // 모드를 바꾸면 "잠깐 불러낸 상태"는 무효가 된다.
    if let Some(flag) = window.try_state::<Surfaced>() {
        if let Ok(mut v) = flag.0.lock() {
            *v = false;
        }
    }
    apply_layer(&window, bottom)
}

// ---------------------------------------------------------------------------
// 실행 / 경로 검사
// ---------------------------------------------------------------------------

fn is_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

#[tauri::command(async)]
fn launch(app: AppHandle, path: String) -> Result<(), String> {
    if is_url(&path) {
        app.opener()
            .open_url(&path, None::<&str>)
            .map_err(|e| e.to_string())
    } else {
        app.opener()
            .open_path(&path, None::<&str>)
            .map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathInfo {
    path: String,
    exists: bool,
    is_dir: bool,
    /// 확장자를 뺀 표시용 이름
    name: String,
    /// 소문자 확장자 (점 없음). 폴더나 확장자가 없으면 빈 문자열
    ext: String,
}

fn inspect_one(raw: &str) -> PathInfo {
    if is_url(raw) {
        let host = raw
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or(raw)
            .to_string();
        return PathInfo {
            path: raw.to_string(),
            exists: true,
            is_dir: false,
            name: host,
            ext: String::new(),
        };
    }

    let p = Path::new(raw);
    let meta = fs::metadata(p).ok();
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);

    let ext = if is_dir {
        String::new()
    } else {
        p.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase()
    };

    let name = if is_dir || ext.is_empty() {
        p.file_name().and_then(|n| n.to_str()).unwrap_or(raw)
    } else {
        p.file_stem().and_then(|n| n.to_str()).unwrap_or(raw)
    }
    .to_string();

    PathInfo {
        path: raw.to_string(),
        exists: meta.is_some(),
        is_dir,
        name,
        ext,
    }
}

#[tauri::command(async)]
fn inspect_paths(paths: Vec<String>) -> Vec<PathInfo> {
    paths.iter().map(|p| inspect_one(p)).collect()
}

// ---------------------------------------------------------------------------
// 사용자 지정 아이콘 이미지
// ---------------------------------------------------------------------------

const MAX_ICON_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command(async)]
fn read_image_data_url(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return Err("png, jpg, gif, webp, svg, bmp, ico만 쓸 수 있습니다".into()),
    };

    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_ICON_BYTES {
        return Err("이미지가 너무 큽니다. 2MB 이하 파일을 골라 주세요".into());
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

// ---------------------------------------------------------------------------
// Windows 실제 아이콘 추출
// ---------------------------------------------------------------------------

fn icon_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?.join("icons");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 여러 경로의 실제 아이콘을 한 번에 가져온다. 뽑지 못한 자리는 null.
///
/// COM 호출이 블로킹이라 전용 스레드에서 돌린다. 30개를 처음 뽑을 때만
/// 잠깐 걸리고, 그 뒤로는 디스크 캐시에서 바로 나온다.
#[tauri::command]
async fn icons_for(
    app: AppHandle,
    paths: Vec<String>,
    size: u32,
) -> Result<Vec<Option<String>>, String> {
    let dir = icon_cache_dir(&app)?;
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<IconCache>();
        let mut out = Vec::with_capacity(paths.len());

        for path in &paths {
            let key = format!("{}|{}", path, size);

            let hit = state
                .0
                .lock()
                .ok()
                .and_then(|map| map.get(&key).cloned());
            if let Some(cached) = hit {
                out.push(cached);
                continue;
            }

            let result = icon::icon_data_url(&dir, path, size);
            if let Ok(mut map) = state.0.lock() {
                map.insert(key, result.clone());
            }
            out.push(result);
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// 아이콘 캐시를 비운다. 아이콘이 바뀌었는데 갱신이 안 될 때 쓰는 탈출구.
///
/// 캐시는 창마다 메모리에도 따로 있으므로, 비웠다고 알려야 런처가 다시 뽑는다.
#[tauri::command(async)]
fn clear_icon_cache(app: AppHandle) -> Result<(), String> {
    if let Ok(mut map) = app.state::<IconCache>().0.lock() {
        map.clear();
    }
    let dir = icon_cache_dir(&app)?;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let _ = app.emit("launcher://icons-cleared", ());
    Ok(())
}

/// 지금 등록된 항목에 쓰이지 않는 캐시 PNG를 치운다. 시작할 때 한 번 부른다.
#[tauri::command(async)]
fn prune_icon_cache(app: AppHandle, paths: Vec<String>, size: u32) -> Result<(), String> {
    let dir = icon_cache_dir(&app)?;
    icon::prune_orphans(&dir, &paths, size);
    Ok(())
}

// ---------------------------------------------------------------------------
// 사용자가 고른 아이콘 이미지
// ---------------------------------------------------------------------------

fn user_icon_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = icon_cache_dir(app)?.join("user");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 고른 이미지를 아이콘 폴더에 저장하고 **파일 이름만** 돌려준다.
/// state.json에는 이 이름만 들어가므로 설정 파일이 무거워지지 않는다.
#[tauri::command(async)]
fn store_user_icon(app: AppHandle, path: String) -> Result<String, String> {
    let dir = user_icon_dir(&app)?;
    icon::store_user_icon(&dir, &path)
}

#[tauri::command(async)]
fn user_icon_data_url(app: AppHandle, name: String) -> Result<String, String> {
    // 경로 조작 방지 — 파일 이름만 받는다.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("잘못된 아이콘 이름입니다".into());
    }
    let file = user_icon_dir(&app)?.join(&name);
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    Ok(icon::to_data_url(&bytes))
}

// ---------------------------------------------------------------------------
// 영속화
// ---------------------------------------------------------------------------

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("state.json"))
}

#[tauri::command(async)]
fn load_state(app: AppHandle) -> Result<String, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn save_state(app: AppHandle, window: Window, data: String) -> Result<(), String> {
    let path = state_path(&app)?;

    {
        // 두 창이 동시에 저장하면 한쪽이 쓰는 중인 임시 파일을 다른 쪽이
        // 교체해 잘린 JSON이 남는다. 쓰기 구간 전체를 직렬화한다.
        let lock = app.state::<SaveLock>();
        let _guard = lock
            .0
            .lock()
            .map_err(|_| "저장 잠금에 실패했습니다".to_string())?;

        // 직전 판을 한 세대 남긴다. 되돌릴 구석이 하나는 있어야 한다.
        if path.exists() {
            let _ = fs::copy(&path, path.with_file_name("state.bak.json"));
        }

        // 저장 도중 전원이 끊겨도 기존 파일이 깨지지 않도록 임시 파일에 쓰고 교체한다.
        // 임시 파일 이름에 창 라벨을 넣어 두 창이 같은 파일을 쓰지 않게 한다.
        let tmp = path.with_file_name(format!("state.{}.tmp", window.label()));
        fs::write(&tmp, data).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }

    // 설정 창에서 바꾼 값이 런처에 바로 보이도록 알린다.
    // 방금 저장한 창 자신에게는 보내지 않는다. 다시 읽어들이면 편집 중인
    // 입력칸의 바인딩이 끊겨 커서가 튄다.
    let me = window.label().to_string();
    let _ = app.emit_filter("launcher://state-saved", (), |target| {
        matches!(target, tauri::EventTarget::WebviewWindow { label } if label != &me)
    });
    Ok(())
}

/// 읽을 수 없는 state.json을 옆으로 치워 둔다.
///
/// 그대로 두면 기본값으로 시작한 뒤 첫 저장에서 원본이 덮어써져 영구 유실된다.
/// 옮긴 경로를 돌려주므로 사용자에게 알릴 수 있다.
#[tauri::command(async)]
fn quarantine_state(app: AppHandle) -> Result<String, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("state.corrupt-{stamp}.json"));
    fs::rename(&path, &backup).map_err(|e| e.to_string())?;
    Ok(backup.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn open_config_dir(app: AppHandle) -> Result<(), String> {
    let dir = config_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 창 표시 / 단축키 / 종료
// ---------------------------------------------------------------------------

/// 단축키·트레이 좌클릭으로 런처를 부를 때의 동작.
///
/// 두 모드가 다르게 움직여야 한다.
///   오버레이      — 보이면 숨기고, 숨겨져 있으면 띄운다 (토글)
///   바탕화면 고정 — 창은 늘 "보이는" 상태라 토글하면 첫 동작이 숨기기가 되어
///                   쓸 수가 없다. 대신 잠깐 맨 위로 끌어올리고, 포커스를
///                   잃으면 다시 맨 아래로 내려보낸다.
fn summon_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    let pinned = app
        .try_state::<Layer>()
        .and_then(|s| s.0.lock().ok().map(|v| *v))
        .unwrap_or(false);

    if pinned {
        let _ = win.unminimize();
        let _ = win.show();
        if let Some(flag) = app.try_state::<Surfaced>() {
            if let Ok(mut v) = flag.0.lock() {
                *v = true;
            }
        }
        let base = win.as_ref().window();
        let _ = apply_layer(&base, false);
        let _ = win.set_focus();
        let _ = app.emit("launcher://shown", ());
        return;
    }

    // 최소화된 창도 IsWindowVisible은 true를 돌려준다. 같이 확인해야
    // Win+D 뒤에 단축키가 거꾸로 도는 일이 없다.
    let hidden = !win.is_visible().unwrap_or(false) || win.is_minimized().unwrap_or(false);
    if hidden {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit("launcher://shown", ());
    } else {
        let _ = win.hide();
    }
}

#[tauri::command]
fn show_window(window: Window) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_window(window: Window) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// 설정은 런처 패널과 별개의 창이다. 설정을 바꾸는 동안 런처가 그대로
/// 보여야 프리셋·모드 변경이 바로 눈에 들어온다.
#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    show_settings(&app)
}

/// 설정 창은 tauri.conf.json에 선언해 두고 시작할 때 숨긴 채로 만듭니다.
///
/// 런타임에 `WebviewWindowBuilder`로 만들면 Windows에서 창틀만 생기고 WebView2가
/// 제대로 붙지 않아 빈 창이 떴습니다. 런처 창과 같은 경로(설정 파일 선언)로
/// 만들면 그 문제가 없고, 여는 속도도 빠릅니다.
fn show_settings(app: &AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("settings")
        .ok_or_else(|| "설정 창이 없습니다".to_string())?;

    let _ = win.unminimize();
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    // 다시 열 때는 항상 첫 화면부터
    let _ = app.emit_to("settings", "launcher://settings-shown", ());
    Ok(())
}

#[tauri::command]
fn close_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        // 닫지 않고 숨깁니다. 닫으면 창이 사라져 다시 만들어야 합니다.
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn register_shortcut(app: &AppHandle, accel: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(accel, move |_, _, event| {
            // 누를 때와 뗄 때 두 번 오므로 누를 때만 처리한다.
            if event.state() != ShortcutState::Pressed {
                return;
            }
            summon_window(&handle);
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_shortcut(app: AppHandle, accel: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let state = app.state::<Shortcut>();
    let mut current = state.0.lock().map_err(|_| "상태 잠금 실패".to_string())?;

    let accel = accel.trim().to_string();
    let next = if accel.is_empty() { None } else { Some(accel) };

    // 값이 그대로면 아무것도 하지 않는다. 예전에는 저장할 때마다 해제 후
    // 재등록을 해서, 그 찰나에 단축키가 먹지 않는 구간이 생겼다.
    if *current == next {
        return Ok(());
    }

    let Some(accel) = next else {
        if let Some(old) = current.take() {
            let _ = app.global_shortcut().unregister(old.as_str());
        }
        return Ok(());
    };

    // 새것을 먼저 등록하고 성공했을 때만 옛것을 푼다.
    // 반대 순서로 하면 등록이 실패했을 때 옛것까지 잃어 창을 부를 방법이 없어진다.
    if let Err(e) = register_shortcut(&app, &accel) {
        return Err(format!("'{accel}' 을(를) 등록하지 못했습니다: {e}"));
    }
    if let Some(old) = current.replace(accel) {
        let _ = app.global_shortcut().unregister(old.as_str());
    }
    Ok(())
}

/// 종료 직전에 각 창에 마지막 저장 기회를 준다.
///
/// 자동 저장이 350ms 디바운스라, 이름을 고치자마자 트레이 → 종료를 누르면
/// 그 변경이 디스크에 닿기 전에 프로세스가 죽는다.
fn request_quit(app: &AppHandle) {
    let _ = app.emit("launcher://before-quit", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        handle.exit(0);
    });
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    request_quit(&app);
}

// ---------------------------------------------------------------------------
// 트레이
// ---------------------------------------------------------------------------

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let toggle_i = MenuItem::with_id(app, "toggle", "열기 / 숨기기", true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", "설정", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle_i, &settings_i, &separator, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("바탕화면 런처")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => summon_window(app),
            "settings" => {
                let _ = show_settings(app);
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                summon_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // 중복 실행 차단은 다른 플러그인보다 먼저 등록해야 한다.
    // 두 벌이 뜨면 패널이 겹쳐 보이고, 둘이 같은 state.json에 각자 저장해서
    // 등록해 둔 항목이 서로 덮어써진다.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            summon_window(app);
        }));
    }

    builder
        .manage(Shortcut(Mutex::new(None)))
        .manage(Layer(Mutex::new(false)))
        .manage(Surfaced(Mutex::new(false)))
        .manage(SaveLock(Mutex::new(())))
        .manage(IconCache::new())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            launch,
            inspect_paths,
            read_image_data_url,
            icons_for,
            clear_icon_cache,
            prune_icon_cache,
            store_user_icon,
            user_icon_data_url,
            load_state,
            save_state,
            quarantine_state,
            open_config_dir,
            work_area,
            place_window,
            set_layer,
            set_shortcut,
            show_window,
            hide_window,
            open_settings,
            close_settings,
            quit_app,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_dialog::init())?;
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                ))?;
                // 자동 업데이트 — GitHub Releases의 latest.json 을 봅니다.
                // 엔드포인트와 공개 키는 tauri.conf.json 의 plugins.updater 에.
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            build_tray(app)?;

            #[cfg(windows)]
            display_watch::attach(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 두 창 모두 닫지 않고 숨긴다. 종료는 트레이 메뉴나 설정 창에서만.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // 바탕화면 고정 모드에서는 클릭으로 앞에 나온 창을 다시 맨 아래로 내린다.
            // 단, 단축키로 일부러 불러낸(surfaced) 동안에는 그대로 둔다.
            WindowEvent::Focused(true) => {
                if window.label() != "main" || !is_pinned(window) || is_surfaced(window) {
                    return;
                }
                let win = window.clone();
                std::thread::spawn(move || {
                    // 시스템이 z-order를 올린 뒤에 내려야 해서 한 박자 늦춘다.
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    let _ = apply_layer(&win, true);
                });
            }
            // 불러낸 창이 포커스를 잃으면 제자리(맨 아래)로 돌려보낸다.
            WindowEvent::Focused(false) => {
                if window.label() != "main" || !is_pinned(window) || !is_surfaced(window) {
                    return;
                }
                if let Some(flag) = window.try_state::<Surfaced>() {
                    if let Ok(mut v) = flag.0.lock() {
                        *v = false;
                    }
                }
                let _ = apply_layer(window, true);
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
