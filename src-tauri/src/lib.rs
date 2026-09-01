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
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered for the Rust side only: no capability grants the webview
        // any shell permission, so the page cannot execute anything (§9.1).
        .plugin(tauri_plugin_shell::init())
        // The webview may open a folder picker; see capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend::default())
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
                    window = window.initialization_script(injection_script(&handshake));
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
