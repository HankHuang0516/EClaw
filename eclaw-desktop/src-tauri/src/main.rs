// P1-A: main.rs — Tauri entry point, delegates to lib::run()
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eclaw_desktop_lib::run();
}
