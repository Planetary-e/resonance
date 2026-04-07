use std::io::{BufRead, BufReader};
use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static SERVER_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

/// Start the Node.js backend and wait until it prints the RESONANCE_READY line.
/// Returns the port the server is listening on.
fn start_and_wait(mut child: Child, timeout: Duration) -> u16 {
    let stdout = child.stdout.take().expect("Failed to capture stdout");
    let reader = BufReader::new(stdout);
    let start = Instant::now();

    let mut port: u16 = 3000;

    for line in reader.lines() {
        if start.elapsed() > timeout {
            eprintln!("Backend startup timed out after {:?}", timeout);
            break;
        }
        match line {
            Ok(text) => {
                eprintln!("[backend] {}", text); // forward to Tauri console
                if let Some(rest) = text.strip_prefix("RESONANCE_READY:") {
                    if let Ok(p) = rest.trim().parse::<u16>() {
                        port = p;
                    }
                    break;
                }
            }
            Err(_) => break,
        }
    }

    *SERVER_PROCESS.lock().unwrap() = Some(child);
    port
}

/// Start the backend in dev mode using `npx tsx`.
fn start_backend_dev() -> u16 {
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
    let _port = start_backend_dev();

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

                let child = Command::new(node_bin)
                    .arg(&server_mjs)
                    .env("RESONANCE_PORT", "3000")
                    .env("RESONANCE_RELAY", "ws://localhost:9091")
                    .env("NODE_PATH", &node_modules)
                    .stdout(Stdio::piped())
                    .spawn()
                    .expect("Failed to start backend server (production)");

                let _port = start_and_wait(child, Duration::from_secs(30));
            }
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                stop_backend();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    stop_backend();
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
