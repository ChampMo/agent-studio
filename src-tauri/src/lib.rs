//! Desktop shell.
//!
//! In development this window is a second client of the same backend the browser
//! talks to: `scripts/dev.mjs` mints the session token and writes the handshake
//! file, and this reads it and injects the same `window.__AGENT_STUDIO__` global
//! that the Vite plugin injects (PROJECT_BRIEF.md §4.2). One code path in the
//! frontend covers both.
//!
//! At M7 this process takes over dev.mjs's job entirely: minting the token and
//! spawning the PyInstaller sidecar with it on stdin. The injection below does
//! not change when that happens — only where the values come from.
//!
//! What this shell must never do is touch a provider key. Keys live in the OS
//! keychain and are read by Python alone (§9.2). Reading one here to hand it
//! along would put it in this process's memory and in any crash dump it
//! produces, which is the whole reason the rule exists.

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Deserialize)]
struct DevHandshake {
    port: u16,
    token: String,
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

            match dev_handshake() {
                Some(handshake) => {
                    window = window.initialization_script(injection_script(&handshake));
                }
                None => {
                    eprintln!(
                        "agent-studio: no dev handshake found. Start the backend with \
                         `npm run dev`; until then the window shows its waiting state."
                    );
                }
            }

            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Agent Studio shell");
}
