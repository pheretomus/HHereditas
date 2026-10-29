//! HHereditas desktop shell.
//!
//! The application itself is the web frontend; this crate only provides the window, native
//! dialogs and file access (plugins), and delivers files the operating system asks us to open
//! (command-line arguments, file associations, macOS "Open With", a second launch).

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Files the OS asked us to open, buffered until the frontend has registered its listener.
#[derive(Default)]
struct OpenFileRequests {
    pending: Vec<String>,
    frontend_ready: bool,
}

struct OpenFiles(Mutex<OpenFileRequests>);

/// Event the frontend listens to; the payload is a list of absolute file paths.
const OPEN_FILES_EVENT: &str = "open-files";

/// Called once by the frontend after it subscribed to `open-files`: returns the files that
/// arrived before it was ready (and from then on files are delivered as events).
#[tauri::command]
fn take_pending_open_files(state: tauri::State<'_, OpenFiles>) -> Vec<String> {
    let mut requests = state.0.lock().unwrap_or_else(|e| e.into_inner());
    requests.frontend_ready = true;
    std::mem::take(&mut requests.pending)
}

/// Deliver files to the frontend now, or buffer them until it is ready.
fn request_open(app: &AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    let state = app.state::<OpenFiles>();
    let mut requests = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if requests.frontend_ready {
        drop(requests);
        let _ = app.emit(OPEN_FILES_EVENT, files);
    } else {
        requests.pending.extend(files);
    }
}

/// Existing files among command-line arguments (the first argument is the program itself).
fn file_arguments<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).is_file())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // A second launch (e.g. double-clicking a sequence file while the app runs) focuses the
        // existing window and opens the files there instead of starting another instance.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                request_open(app, file_arguments(argv));
            }))
            .plugin(tauri_plugin_window_state::Builder::default().build())
            // Self-update: the frontend checks the release feed at startup (see src/app/updater.ts),
            // downloads a signed installer and relaunches through the process plugin.
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    let app = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenFiles(Mutex::new(OpenFileRequests {
            pending: file_arguments(std::env::args()),
            frontend_ready: false,
        })))
        .invoke_handler(tauri::generate_handler![take_pending_open_files])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // macOS delivers "Open With" / double-clicked documents as an event, not as arguments.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let files = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            request_open(_app, files);
        }
    });
}
