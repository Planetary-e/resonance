use std::io::{BufRead, BufReader};
use std::process::{Command, Child, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

static SERVER_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// Start the Node.js backend and wait until it prints the RESONANCE_READY line.
/// Returns the port the server is listening on.
fn start_and_wait(mut child: Child, timeout: Duration) -> Result<u16, String> {
    let stdout = child.stdout.take().ok_or("Failed to capture backend stdout")?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut ready = false;
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(text) => {
                    eprintln!("[backend] {text}");
                    if !ready {
                        if let Some(port) = text.strip_prefix("RESONANCE_READY:")
                            .and_then(|value| value.trim().parse::<u16>().ok()) {
                            let _ = sender.send(Ok(port));
                            ready = true;
                        }
                    }
                }
                Err(error) => {
                    if !ready { let _ = sender.send(Err(format!("Backend output failed: {error}"))); }
                    return;
                }
            }
        }
        if !ready { let _ = sender.send(Err("Backend exited before becoming ready".to_string())); }
    });

    match receiver.recv_timeout(timeout) {
        Ok(Ok(port)) => {
            *SERVER_PROCESS.lock().unwrap() = Some(child);
            Ok(port)
        }
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(error)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!("Backend did not become ready within {timeout:?}"))
        }
    }
}

/// Start the backend in dev mode using `npx tsx`.
fn start_backend_dev() -> Result<u16, String> {
    let app_dir = std::env::current_dir().expect("Failed to get cwd");
    let app_root = if app_dir.ends_with("src-tauri") {
        app_dir.parent().unwrap().to_path_buf()
    } else {
        app_dir
    };

    let child = Command::new("npx")
        .args(["tsx", "src/server/start.ts"])
        .current_dir(&app_root)
        .env("RESONANCE_PORT", "3000")
        .env("RESONANCE_RELAY", "ws://localhost:9091")
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed to start backend server");

    start_and_wait(child, Duration::from_secs(30))
}

fn stop_backend() {
    if let Some(mut child) = SERVER_PROCESS.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // In dev mode, start backend before Tauri
    #[cfg(debug_assertions)]
    let _port = start_backend_dev().expect("Failed to start development backend");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| {
            // In production, start backend using bundled sidecar + resources
            #[cfg(not(debug_assertions))]
            {
                use tauri::Manager;
                let resource_dir = _app.path().resource_dir()
                    .expect("Failed to resolve resource dir");
                let server_mjs = resource_dir.join("server").join("server.mjs");
                let node_modules = resource_dir.join("server").join("node_modules");

                let app_dir = std::env::current_exe()
                    .expect("Failed to get exe path")
                    .parent()
                    .expect("Failed to get exe dir")
                    .to_path_buf();
                let node_bin = find_sidecar(&app_dir, "node");

                let child = Command::new(&node_bin)
                    .arg(&server_mjs)
                    .env("RESONANCE_PORT", "3000")
                    .env("RESONANCE_RELAY", "ws://localhost:9091")
                    .env("RESONANCE_RELAY_NODE", &node_bin)
                    .env("RESONANCE_RELAY_ENTRY", resource_dir.join("server").join("relay.mjs"))
                    .env("RESONANCE_RELAY_CWD", &resource_dir)
                    .env("NODE_PATH", &node_modules)
                    .stdout(Stdio::piped())
                    .spawn()
                    .expect("Failed to start backend server (production)");

                let _port = start_and_wait(child, Duration::from_secs(30))
                    .map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                stop_backend();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Tauri's run loop exits the process directly, so cleanup after
            // run() is never reached when the user chooses Quit.
            if let tauri::RunEvent::Exit = event {
                stop_backend();
            }
        });
}

/// Find a Tauri sidecar binary by name (handles platform triple suffix).
#[cfg(not(debug_assertions))]
fn find_sidecar(app_dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidates = [
        app_dir.join(name),
        app_dir.join(format!("{name}-aarch64-apple-darwin")),
        app_dir.join(format!("{name}-x86_64-apple-darwin")),
        app_dir.join(format!("{name}-x86_64-unknown-linux-gnu")),
        app_dir.join(format!("{name}-aarch64-unknown-linux-gnu")),
        app_dir.join(format!("{name}-x86_64-pc-windows-msvc.exe")),
    ];
    for c in &candidates {
        if c.exists() {
            return c.clone();
        }
    }
    std::path::PathBuf::from("node")
}
