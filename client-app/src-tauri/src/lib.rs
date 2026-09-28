mod host;

use std::sync::Mutex;
use tauri::{Manager, State};
use tauri::async_runtime::JoinHandle;

struct AppState {
    host_task: Mutex<Option<JoinHandle<()>>>,
}

#[tauri::command]
fn start_host_agent_cmd(device_id: String, token: String, jwt: String, state: State<'_, AppState>) {
    let mut task_guard = state.host_task.lock().unwrap();
    
    // Stop the previous host agent if it's running
    if let Some(task) = task_guard.take() {
        task.abort();
    }

    // Start a new one
    let new_task = tauri::async_runtime::spawn(async move {
        let url = std::env::var("SIGNALING_URL").unwrap_or_else(|_| "ws://127.0.0.1:8080/ws".to_string());
        host::start_host_agent(device_id, token, jwt, url).await;
    });

    *task_guard = Some(new_task);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AppState {
                host_task: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![start_host_agent_cmd])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
