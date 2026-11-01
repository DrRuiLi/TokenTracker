use std::path::Path;

use tokentracker_linux::oauth::{
    appimage_desktop_entry, callback_url, is_allowed_oauth_url, parse_auth_callback,
    PendingAuthCode,
};

#[test]
fn parses_only_the_expected_auth_callback() {
    assert_eq!(
        parse_auth_callback("tokentracker://auth/callback?insforge_code=abc%2F123"),
        Some("abc/123".to_string())
    );

    for invalid in [
        // Wrong scheme.
        "https://auth/callback?insforge_code=abc",
        "http://auth/callback?insforge_code=abc",
        "tokentracker2://auth/callback?insforge_code=abc",
        // Wrong host.
        "tokentracker://open/callback?insforge_code=abc",
        "tokentracker://Auth.evil.com/callback?insforge_code=abc",
        // Wrong path.
        "tokentracker://auth/done?insforge_code=abc",
        "tokentracker://auth/callback/extra?insforge_code=abc",
        "tokentracker://auth/?insforge_code=abc",
        // Missing or empty code.
        "tokentracker://auth/callback",
        "tokentracker://auth/callback?insforge_code=",
        "tokentracker://auth/callback?other=abc",
        // Ambiguous: refuse rather than guess which code is authoritative.
        "tokentracker://auth/callback?insforge_code=one&insforge_code=two",
        "tokentracker://auth/callback?insforge_code=one&other=x&insforge_code=two",
        // A fragment can hide a second value from `query_pairs`.
        "tokentracker://auth/callback#insforge_code=abc",
        "tokentracker://auth/callback?insforge_code=abc#extra",
        // Not a URL at all.
        "",
        "not a url",
        "tokentracker://",
    ] {
        assert_eq!(parse_auth_callback(invalid), None, "accepted {invalid}");
    }
}

#[test]
fn callback_url_rejects_anything_but_a_bare_loopback_base() {
    for invalid in [
        // Non-loopback or non-http bases would send the code off-machine.
        "https://127.0.0.1:17680",
        "http://localhost:17680",
        "http://0.0.0.0:17680",
        "http://example.com:17680",
        "http://[::1]:17680",
        // A missing port would target the default HTTP port, not our server.
        "http://127.0.0.1",
        // The base must be bare: an existing path/query/fragment means the
        // caller passed something other than the dashboard origin.
        "http://127.0.0.1:17680/dashboard",
        "http://127.0.0.1:17680/?next=/evil",
        "http://127.0.0.1:17680/#frag",
        "not a url",
        "",
    ] {
        assert_eq!(
            callback_url(invalid, "code"),
            None,
            "accepted base {invalid}"
        );
    }
}

#[test]
fn callback_url_percent_encodes_hostile_codes() {
    // The code is attacker-influenced text; it must never be able to introduce
    // another query parameter or escape into the fragment.
    let url = callback_url("http://127.0.0.1:17680", "a&app=0#x").expect("valid base");

    assert_eq!(
        url,
        "http://127.0.0.1:17680/auth/callback?insforge_code=a%26app%3D0%23x&app=1"
    );
    assert!(!url.contains("app=0"), "must not inject a second parameter");
    assert!(!url.contains('#'), "must not introduce a fragment");
}

#[test]
fn callback_url_accepts_a_fallback_port() {
    // `pick_available_port` falls back to an OS-assigned port, so the builder
    // must not be hardcoded to 17680.
    assert_eq!(
        callback_url("http://127.0.0.1:39215", "abc").as_deref(),
        Some("http://127.0.0.1:39215/auth/callback?insforge_code=abc&app=1")
    );
}

#[test]
fn opens_only_absolute_https_oauth_urls() {
    assert!(is_allowed_oauth_url(
        "https://auth.example.com/oauth?client_id=1"
    ));

    for invalid in [
        "http://auth.example.com/oauth",
        "file:///tmp/token",
        "javascript:alert(1)",
        "data:text/plain,secret",
        "/relative/oauth",
        "https://",
    ] {
        assert!(!is_allowed_oauth_url(invalid), "accepted {invalid}");
    }
}

#[test]
fn builds_a_loopback_callback_url_with_an_encoded_code() {
    assert_eq!(
        callback_url("http://127.0.0.1:17680", "a/b+c?d").as_deref(),
        Some("http://127.0.0.1:17680/auth/callback?insforge_code=a%2Fb%2Bc%3Fd&app=1")
    );
    assert_eq!(callback_url("https://example.com", "code"), None);
}

#[test]
fn pending_auth_code_is_consumed_once_and_latest_wins() {
    let pending = PendingAuthCode::default();
    pending.store("first".to_string());
    pending.store("second".to_string());

    assert_eq!(pending.take().as_deref(), Some("second"));
    assert_eq!(pending.take(), None);
}

#[test]
fn appimage_desktop_entry_registers_the_callback_and_quotes_the_path() {
    let entry = appimage_desktop_entry(Path::new(
        "/home/dev/Token Tracker 100%/$`\"\\/TokenTracker-linux.AppImage",
    ))
    .expect("valid AppImage path");

    assert!(entry.contains(
        "Exec=\"/home/dev/Token Tracker 100%%/\\$\\`\\\"\\\\/TokenTracker-linux.AppImage\" %u"
    ));
    assert!(entry.contains("MimeType=x-scheme-handler/tokentracker;"));
    assert!(entry.contains("X-AppImage-Integrate=false"));
}

#[test]
fn appimage_desktop_entry_rejects_control_characters() {
    assert_eq!(
        appimage_desktop_entry(Path::new("/tmp/bad\nname.AppImage")),
        None
    );
}

/// The AppImage writes `mimeapps.list` through `xdg-mime`, but a portal or app
/// chooser resolves the callback scheme by enumerating registered handlers from
/// the desktop database. Registration must therefore also refresh that database
/// (`update-desktop-database`), or browser sign-in cannot hand the code back.
mod appimage_registration {
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use tokentracker_linux::oauth::ensure_appimage_protocol_registration;

    // This test repoints `APPIMAGE`, `HOME`, `XDG_DATA_HOME` and `PATH` for the
    // whole process, and cargo runs the tests in this binary in parallel, so it
    // must not overlap itself. Poisoning is recovered from rather than
    // propagated, matching tests/server.rs.
    static ENV_GUARD: Mutex<()> = Mutex::new(());

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("tokentracker-oauth-{label}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("scratch dir should be creatable");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_stub(path: &Path, body: &str) {
        fs::write(path, body).expect("stub should be writable");
        let mut permissions = fs::metadata(path).expect("stub metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("stub should be executable");
    }

    #[test]
    fn registers_the_scheme_and_refreshes_the_desktop_database() {
        let _serial = ENV_GUARD.lock().unwrap_or_else(|error| error.into_inner());

        let scratch = Scratch::new("registration");
        let data_dir = scratch.path().join("data");
        let applications_dir = data_dir.join("applications");
        let bin_dir = scratch.path().join("bin");
        fs::create_dir_all(&applications_dir).expect("applications dir");
        fs::create_dir_all(&bin_dir).expect("stub dir");
        let appimage = scratch.path().join("TokenTracker.AppImage");
        fs::write(&appimage, b"stub").expect("appimage placeholder");

        let default_marker = scratch.path().join("xdg-mime-default");
        let refresh_marker = scratch.path().join("update-desktop-database-dir");
        write_stub(
            &bin_dir.join("xdg-mime"),
            &format!(
                "#!/bin/sh\ncase \"$1\" in\n  default) printf '%s\\n' \"$2\" > \"{marker}\" ;;\n  query) cat \"{marker}\" ;;\nesac\nexit 0\n",
                marker = default_marker.display()
            ),
        );
        write_stub(
            &bin_dir.join("update-desktop-database"),
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$1\" > \"{marker}\"\nexit 0\n",
                marker = refresh_marker.display()
            ),
        );

        let keys = ["APPIMAGE", "HOME", "XDG_DATA_HOME", "PATH"];
        let previous: Vec<Option<OsString>> = keys.iter().map(std::env::var_os).collect();
        // Prepend the stub directory: our fakes win the lookup, while the real
        // PATH stays reachable for the shell builtins the stubs rely on.
        let stub_path = std::env::join_paths(std::iter::once(bin_dir.clone()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
        ))
        .expect("PATH entries should join");
        std::env::set_var("APPIMAGE", &appimage);
        std::env::set_var("HOME", scratch.path());
        std::env::set_var("XDG_DATA_HOME", &data_dir);
        std::env::set_var("PATH", stub_path);

        let result = ensure_appimage_protocol_registration();

        let refreshed = fs::read_to_string(&refresh_marker).ok();
        let desktop =
            fs::read_to_string(applications_dir.join("tokentracker-appimage.desktop")).ok();

        for (key, value) in keys.iter().zip(previous) {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }

        assert_eq!(result, Ok(true), "registration should succeed");
        assert!(
            desktop.is_some_and(|entry| entry.contains("x-scheme-handler/tokentracker")),
            "the .desktop handler should be written"
        );
        assert_eq!(
            refreshed.as_deref().map(str::trim),
            Some(applications_dir.to_str().expect("utf-8 scratch path")),
            "update-desktop-database must run against the applications dir"
        );
    }
}
