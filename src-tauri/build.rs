fn main() {
    // generate_context! embeds icons; cargo ignores them unless we watch here.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=macos/Assets.car");
    // GNU ld exports every symbol from the Tauri cdylib and blows past the
    // 65535 PE ordinal limit. Hide them; the desktop exe links the rlib.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        println!("cargo::rustc-link-arg-cdylib=-Wl,--exclude-libs=ALL,--exclude-all-symbols");
    }
    // The hub plugin's three commands get their permissions here (capabilities/default.json allows `hub:default`).
    let hub = tauri_build::InlinedPlugin::new()
        .commands(&[
            "hub_call",
            "hub_events_open",
            "hub_events_close",
            "hub_ash_os_mcp",
            "connector_login_store",
            "connector_login_exists",
            "connector_login_delete",
            "model_key_save",
            "model_key_test",
            "model_key_delete",
        ])
        .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(tauri_build::Attributes::new().plugin("hub", hub))
        .expect("failed to run tauri-build");
}
