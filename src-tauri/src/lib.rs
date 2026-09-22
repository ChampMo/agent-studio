//! Desktop shell.
//!
//! In development this window is a second client of the same backend the browser
//! talks to: `scripts/dev.mjs` mints the session token and writes the handshake
//! file, and this reads it and injects the same `window.__AGENT_STUDIO__` global
//! that the Vite plugin injects (PROJECT_BRIEF.md §4.2). One code path in the
//! frontend covers both.
//!
//! In a packaged build this process takes over dev.mjs's job entirely: it mints
//! the token, picks a port and spawns the PyInstaller sidecar with the token on
//! stdin. The injection is the same either way — only where the values come
//! from differs, which is why the frontend has never had to know.
//!
//! What this shell must never do is touch a provider key. Keys live in the OS
//! keychain and are read by Python alone (§9.2). Reading one here to hand it
//! along would put it in this process's memory and in any crash dump it
//! produces, which is the whole reason the rule exists.

use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;

use rand::RngCore;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

#[derive(Deserialize)]
struct DevHandshake {
    port: u16,
    token: String,
}

/// The running backend, so it can be shut down with the window that needs it.
#[derive(Default)]
struct Backend(Mutex<Option<CommandChild>>);

/// The handshake script the main window was built with, kept so a window
/// opened later gets the identical one. A second window that reached the
/// backend any other way would be a second code path for the token.
#[derive(Default)]
struct Injection(Mutex<Option<String>>);

/// A session token: 32 hex characters from the OS entropy source.
///
/// This is the entire security boundary in front of a server holding the user's
/// provider keys (§9.1), so it comes from `OsRng` rather than from anything
/// seeded by the clock or the process id.
fn mint_token() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// An unused loopback port, chosen the way the dev launcher chooses one.
///
/// Asked of the OS and released immediately, which leaves a moment in which
/// something else could take it. The alternative — parsing the port out of the
/// backend's ready line — means the window cannot be built until the backend
/// has started, and a slow first launch would then show nothing at all. The
/// frontend already has a state for a backend that is not up yet; it has none
/// for a window with no port.
fn free_port() -> Option<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    Some(port)
}

/// Start the bundled backend and hand it the token on stdin.
///
/// Not argv, which is world-readable in the process list, and not an
/// environment variable, which children inherit and crash dumps capture. The
/// port travels in the environment precisely because it is not a secret.
fn start_sidecar(app: &AppHandle) -> Result<DevHandshake, String> {
    let port = free_port().ok_or("no free loopback port")?;
    let token = mint_token();

    let (_rx, mut child) = app
        .shell()
        .sidecar("agentd")
        .map_err(|e| format!("sidecar not bundled: {e}"))?
        .env("AGENT_STUDIO_PORT", port.to_string())
        .spawn()
        .map_err(|e| format!("could not start the backend: {e}"))?;

    child
        .write(format!("{token}\n").as_bytes())
        .map_err(|e| format!("could not hand the backend its token: {e}"))?;

    app.state::<Backend>().0.lock().unwrap().replace(child);
    Ok(DevHandshake { port, token })
}

/// The dev launcher writes this next to the database. Absent in a packaged
/// build, where the values will come from the sidecar we spawned ourselves.
fn dev_handshake() -> Option<DevHandshake> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent()?.to_path_buf();
    let raw = fs::read_to_string(repo_root.join(".data").join("dev-handshake.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn injection_script(handshake: &DevHandshake) -> String {
    // Serialised through serde rather than formatted by hand: a token is opaque
    // text, and hand-built JSON is how quoting bugs become injection bugs.
    let payload = serde_json::json!({
        "apiBase": format!("http://127.0.0.1:{}", handshake.port),
        "wsBase": format!("ws://127.0.0.1:{}", handshake.port),
        "token": handshake.token,
    });
    format!("window.__AGENT_STUDIO__ = {};", payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> DevHandshake {
        DevHandshake { port: 54321, token: "abc123".into() }
    }

    #[test]
    fn injects_the_same_global_the_vite_plugin_does() {
        let script = injection_script(&sample());
        assert!(script.starts_with("window.__AGENT_STUDIO__ = "));

        let json = script
            .trim_start_matches("window.__AGENT_STUDIO__ = ")
            .trim_end_matches(';');
        let parsed: serde_json::Value = serde_json::from_str(json).expect("valid JSON");

        assert_eq!(parsed["apiBase"], "http://127.0.0.1:54321");
        assert_eq!(parsed["wsBase"], "ws://127.0.0.1:54321");
        assert_eq!(parsed["token"], "abc123");
    }

    #[test]
    fn a_minted_token_is_long_hex_and_never_repeats() {
        // The token is the only thing standing in front of a server that holds
        // the user's provider keys, so "it looked random" is not good enough to
        // leave unasserted.
        let a = mint_token();
        let b = mint_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "not hex: {a}");
        assert_ne!(a, b);
    }

    #[test]
    fn a_free_port_is_a_real_one() {
        let port = free_port().expect("the OS always has a spare loopback port");
        assert!(port > 1024, "handed a privileged port: {port}");
    }

    #[test]
    fn a_token_containing_quotes_cannot_break_out_of_the_literal() {
        // Tokens are hex today, but hand-built JSON is how a quoting bug turns
        // into script injection later. serde escapes; string formatting would not.
        let hostile = DevHandshake {
            port: 1,
            token: r#"a"; alert(1); //"#.into(),
        };
        let script = injection_script(&hostile);
        let json = script
            .trim_start_matches("window.__AGENT_STUDIO__ = ")
            .trim_end_matches(';');
        let parsed: serde_json::Value = serde_json::from_str(json).expect("valid JSON");
        assert_eq!(parsed["token"], r#"a"; alert(1); //"#);
        // The quote that would have closed the literal early is escaped, so the
        // payload stays inside the string instead of becoming code.
        assert!(script.contains(r#"a\""#), "the quote was not escaped");
        assert!(!script.contains(r#""a"; alert"#), "the literal was broken out of");
    }

    // ---- reveal_folder ----------------------------------------------------
    //
    // What is testable here is the refusing. Whether Explorer actually opened
    // is the file manager's business and needs a desktop to see, so these cover
    // the three checks that run before anything is spawned — and those are the
    // ones that decide what this command is allowed to be pointed at.

    #[test]
    fn a_path_that_is_not_there_is_refused_before_anything_opens() {
        let missing = std::env::temp_dir().join("agent-studio-no-such-folder-xyz");
        let err = reveal_folder(missing.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("not there"), "unhelpful: {err}");
    }

    #[test]
    fn a_file_is_refused_because_this_reveals_folders() {
        // "Open the file at this path" is a different offer with a different
        // risk, and this command does not make it.
        let file = std::env::temp_dir().join("agent-studio-reveal-test.txt");
        fs::write(&file, b"x").expect("could not write the fixture");
        let err = reveal_folder(file.to_string_lossy().to_string()).unwrap_err();
        let _ = fs::remove_file(&file);
        assert!(err.contains("not a folder"), "unhelpful: {err}");
    }

    #[test]
    fn an_empty_path_is_refused_rather_than_meaning_the_current_directory() {
        assert!(reveal_folder(String::new()).is_err());
    }
}

/// Open a folder in the OS file manager.
///
/// The one thing the page can ask this process to do, and it is written as a
/// command rather than by granting the webview a shell permission, because
/// those are not the same offer: a shell permission would let the page run
/// anything, and this lets it show a directory.
///
/// Three checks before anything opens, in this order:
///
/// * the path must exist, so a stale workspace fails here rather than in a file
///   manager the user then has to read an error out of;
/// * it must be a **directory** — this reveals a folder, it does not open
///   documents, and "open the file at this path" is a different offer with a
///   different risk;
/// * it is canonicalised, so `..` is resolved before it reaches the shell, the
///   same rule the backend's workspace resolver keeps (§16.2).
///
/// The command is fixed per platform and the path is a single argument, never
/// interpolated into a command line — there is no string for a crafted path to
/// break out of.
#[tauri::command]
fn reveal_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("{path} is not there any more"));
    }
    if !target.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let resolved = target
        .canonicalize()
        .map_err(|err| format!("could not resolve {path}: {err}"))?;

    // Windows hands back a \\?\ prefixed path from canonicalize, which
    // explorer.exe refuses. Strip it rather than skipping canonicalisation.
    #[cfg(target_os = "windows")]
    let resolved = {
        let text = resolved.to_string_lossy().to_string();
        PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
    };

    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(&resolved)
        .spawn()
        .map(|_| ())
        // explorer.exe returns a non-zero exit code even on success, so the
        // child is not waited on: whether it opened is the file manager's
        // business, and spawning is the part that can actually fail here.
        .map_err(|err| format!("could not open the file manager: {err}"))
}

/// The label of the window that shows one mission's room.
///
/// A mission id is an opaque id and goes straight into the label, which is
/// what `capabilities/default.json` allows (`scene-*`); anything that is not
/// one is refused before it becomes a window label.
fn scene_label(mission_id: &str) -> Result<String, String> {
    if mission_id.is_empty()
        || !mission_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("not a mission id".into());
    }
    Ok(format!("scene-{mission_id}"))
}

/// The room for one mission in a window of its own (`lib/popout.ts`).
///
/// Built the same way as the main window — the handshake injected before any
/// page script — plus one more global naming the mission, which `App` reads
/// to render the room alone.
///
/// `async`, and the build itself on the main thread. A synchronous command
/// runs *inside* the calling webview's message handler, and on Windows a
/// WebView2 cannot be created from inside another's callback: the new window
/// came up black and would not close. Off that thread and back onto the main
/// one properly, it is an ordinary window.
#[tauri::command]
async fn open_scene_window(app: AppHandle, mission_id: String) -> Result<(), String> {
    let label = scene_label(&mission_id)?;
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let script = app.state::<Injection>().0.lock().unwrap().clone();
    let (done, wait) = std::sync::mpsc::channel::<Result<(), String>>();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let mut window = WebviewWindowBuilder::new(&handle, &label, WebviewUrl::default())
            .title("Agent Studio — room")
            .inner_size(960.0, 640.0)
            .min_inner_size(480.0, 320.0);
        if let Some(script) = script {
            window = window.initialization_script(script);
        }
        window = window.initialization_script(format!(
            "window.__AGENT_STUDIO_SCENE__ = {};",
            serde_json::json!(mission_id)
        ));
        let _ = done.send(window.build().map(|_| ()).map_err(|err| err.to_string()));
    })
    .map_err(|err| err.to_string())?;
    wait.recv().map_err(|err| err.to_string())?
}

/// Bring the room back: close its window. The main window's pane returns
/// on the `scene-window-closed` event this fires, the same one a click on
/// the window's own close button fires.
#[tauri::command]
async fn close_scene_window(app: AppHandle, mission_id: String) -> Result<(), String> {
    let label = scene_label(&mission_id)?;
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered for the Rust side only: no capability grants the webview
        // any shell permission, so the page cannot execute anything (§9.1).
        .plugin(tauri_plugin_shell::init())
        // The webview may open a folder picker; see capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            reveal_folder,
            open_scene_window,
            close_scene_window
        ])
        // A room window going away is the main window's cue to draw the
        // room itself again. Said by label, so the page knows which run.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mission_id) = window.label().strip_prefix("scene-") {
                    let _ = window
                        .app_handle()
                        .emit("scene-window-closed", mission_id.to_string());
                }
            }
        })
        .manage(Backend::default())
        .manage(Injection::default())
        .setup(|app| {
            // The window is built here rather than declared in tauri.conf.json
            // because the handshake has to be injected as an initialisation
            // script — it must run before any page script, so the app never
            // observes a window without the global. `eval` after load would be
            // a race the frontend would have to code around.
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Agent Studio")
                .inner_size(1280.0, 860.0)
                .min_inner_size(900.0, 600.0);

            // A debug build is a development one: `npm run dev` owns the
            // backend, and there is no bundled sidecar to spawn. A release
            // build always starts its own, and deliberately does not look for a
            // handshake file - the path to one is baked in at compile time, so
            // a packaged build on the developer's own machine would find a
            // stale one and attach to a backend nobody expected it to.
            let handshake = if cfg!(debug_assertions) {
                dev_handshake()
            } else {
                match start_sidecar(app.handle()) {
                    Ok(handshake) => Some(handshake),
                    Err(problem) => {
                        eprintln!("agent-studio: {problem}");
                        None
                    }
                }
            };

            match handshake {
                Some(handshake) => {
                    let script = injection_script(&handshake);
                    app.state::<Injection>().0.lock().unwrap().replace(script.clone());
                    window = window.initialization_script(script);
                }
                None => {
                    eprintln!("agent-studio: no backend to talk to. In development, start one with `npm run dev`; the window shows its waiting state until then.");
                }
            }

            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Agent Studio shell")
        .run(|app, event| {
            // The backend holds the user's keys in memory and a lock on the
            // database. Leaving it running after its only client has closed
            // would be an unattended server on loopback, and the next launch
            // would meet a port and a database that are already taken.
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<Backend>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
