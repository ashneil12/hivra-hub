use super::store::Memory;
use super::*;
use crate::session_store::SessionStore;
use rusqlite::Connection;
use std::sync::MutexGuard;

struct Bench {
    store: SessionStore,
    vault: Memory,
    now: i64,
}

impl Bench {
    fn new() -> Self {
        Self {
            store: SessionStore::open_in_memory().unwrap(),
            vault: Memory::new(),
            now: 1_700_000_000_000,
        }
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.store.lock_conn().unwrap()
    }

    fn save(&self, scope: &str, name: &str, value: &str) -> SecretRow {
        let conn = self.conn();
        save_value(&self.vault, &conn, scope, name, None, value, self.now).unwrap()
    }
}

const VALUE: &str = "sk_live_51NxAbCdEfGhIjKl";

// ---- the service name rules -----------------------------------------------------------------------------------------

#[test]
fn a_name_normalizes_to_the_slug_the_card_shows() {
    assert_eq!(normalize_name("Stripe API Key").unwrap(), "stripe-api-key");
    assert_eq!(normalize_name("my_key").unwrap(), "my-key");
    assert_eq!(normalize_name("  padded  ").unwrap(), "padded");
    assert_eq!(normalize_name("a--b").unwrap(), "a--b");
    assert_eq!(normalize_name("Mixed CASE").unwrap(), "mixed-case");
}

#[test]
fn empty_missing_unicode_and_dotted_names_are_refused() {
    for bad in [
        "",
        "   ",
        "-starts-with-dash",
        "ends-with-dash-",
        "a..b",
        "with/slash",
        "with:colon",
        "café-key",
        &"x".repeat(65),
    ] {
        assert!(normalize_name(bad).is_err(), "{bad:?} must be refused");
    }
    assert!(normalize_name(&"x".repeat(64)).is_ok());
}

#[test]
fn case_only_names_are_one_secret() {
    assert_eq!(
        normalize_name("Token").unwrap(),
        normalize_name("token").unwrap()
    );
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "Token", VALUE);
    let conn = bench.conn();
    assert_eq!(list_secrets(&conn).unwrap().len(), 1);
    assert!(resolve(&conn, None, "token").unwrap().is_some());
    assert!(resolve(&conn, None, "TOKEN").unwrap().is_some());
}

#[test]
fn the_daily_and_dev_items_are_exactly_the_ones_in_the_package() {
    use crate::hub_keychain::scoped_service;
    use crate::instance::Kind;
    let daily = service(SCOPE_GLOBAL, "stripe-api-key").unwrap();
    assert_eq!(daily, "monocode-hub:secret:global:stripe-api-key");
    assert_eq!(
        scoped_service(Kind::Daily, &daily),
        "monocode-hub:secret:global:stripe-api-key"
    );
    assert_eq!(
        scoped_service(Kind::Dev, &daily),
        "monocode-hub-dev:secret:global:stripe-api-key"
    );
    // A dev copy never forms a daily name; a daily item is never a dev one.
    assert!(!scoped_service(Kind::Dev, &daily).starts_with("monocode-hub:secret:"));
}

#[test]
fn a_project_id_that_breaks_the_guard_becomes_a_short_hash_and_the_row_keeps_the_readable_id() {
    let long = format!("/Users/someone/{}", "a".repeat(200));
    let scope = scope_for(Some(&long));
    let served = service(&scope, "stripe-api-key").unwrap();
    assert!(served.len() <= SERVICE_MAX, "{served}");
    assert!(served.starts_with("monocode-hub:secret:project."));
    assert!(!served.contains(&"a".repeat(20)));
    // The readable id stays in the scope, which is what the row stores.
    assert_eq!(scope_project(&scope), Some(long.as_str()));

    // A plain project id the guard accepts is kept readable when it fits. A project folder path carries `/`, which the
    // guard refuses, so a real one is always hashed (the assertion above).
    let plain = "tally_prod.v2";
    let scope = scope_for(Some(plain));
    let served = service(&scope, "stripe-api-key").unwrap();
    assert!(served.contains(plain), "{served}");
    assert!(served.len() <= SERVICE_MAX);

    // A path with characters the keychain guard refuses is hashed too, so the store call never fails the guard.
    let odd = "/Users/person/my project";
    let scope = scope_for(Some(odd));
    assert!(!service(&scope, "k").unwrap().contains("my project"));
}

#[test]
fn a_dev_copy_cannot_name_a_daily_vault_service() {
    use crate::hub_keychain::scoped_service;
    use crate::instance::Kind;
    assert_eq!(
        scoped_service(Kind::Dev, grant::KEY_SERVICE),
        "monocode-hub-dev:secret-key:grant"
    );
    assert_eq!(
        scoped_service(Kind::Daily, grant::KEY_SERVICE),
        "monocode-hub:secret-key:grant"
    );
    // Every service this module builds goes through the same function, so a dev copy's names all start with its prefix.
    for scope in [SCOPE_GLOBAL.to_string(), scope_for(Some("/p"))] {
        let daily = service(&scope, "stripe-api-key").unwrap();
        assert!(scoped_service(Kind::Dev, &daily).starts_with(crate::hub_keychain::DEV_PREFIX));
        assert_ne!(scoped_service(Kind::Dev, &daily), daily);
    }
    // An isolated HOME turns the daily keychain off, which is what makes `name_kind` dev.
    assert!(
        !crate::instance::Kind::Daily
            .policy()
            .in_isolated_home()
            .daily_keychain
    );
}

#[test]
fn an_isolated_home_uses_the_memory_store() {
    // `store::active()` picks memory whenever `instance::isolated_home()` is set; this proves the choice without the
    // Keychain or the process environment. The test binary itself is a daily build (`name_kind` follows the compiled
    // identifier), so it must never reach the login keychain here.
    let serviced = service(SCOPE_GLOBAL, "stripe-api-key").unwrap();
    let vault = store::vault_for(true);
    vault.write(&serviced, ACCOUNT, VALUE).unwrap();
    assert_eq!(
        vault.read(&serviced, ACCOUNT).unwrap().as_deref(),
        Some(VALUE)
    );
    assert!(vault.remove(&serviced, ACCOUNT).unwrap());
    // The seeded memory is what a bench is handed, and it starts empty when the process carries no seed variable.
    if std::env::var_os(store::SEED_ENV).is_none() {
        let seeded = store::vault_for(true);
        assert_eq!(seeded.read(&serviced, ACCOUNT).unwrap(), None);
    }
}

// ---- values ---------------------------------------------------------------------------------------------------------

#[test]
fn value_bounds_are_exact() {
    assert!(validate_value("1234567").is_err());
    assert_eq!(validate_value("12345678").unwrap().as_str(), "12345678");
    assert!(validate_value(&"x".repeat(VALUE_MAX)).is_ok());
    assert!(validate_value(&"x".repeat(VALUE_MAX + 1)).is_err());
    assert!(validate_value("").is_err());
    assert!(validate_value("   ").is_err());
    assert!(validate_value("\n\t ").is_err());
    assert!(validate_value("has\u{0}nul").is_err());
    let err = validate_value("1234567").unwrap_err();
    assert!(err.contains("shorter than 8"));
    assert!(!err.contains("1234567"));
}

#[test]
fn trailing_crlf_is_trimmed_and_internal_newlines_are_kept() {
    let pem = "-----BEGIN KEY-----\nabcdefghij\n-----END KEY-----";
    assert_eq!(validate_value(&format!("{pem}\r\n")).unwrap().as_str(), pem);
    assert_eq!(validate_value(&format!("{pem}\n\n")).unwrap().as_str(), pem);
    assert!(validate_value(pem).unwrap().contains('\n'));
    // A trailing CR is trimmed on its own too.
    assert_eq!(validate_value("abcdefgh\r").unwrap().as_str(), "abcdefgh");
}

#[test]
fn last4_is_only_for_a_value_of_twelve_or_more() {
    assert_eq!(last4("12345678901"), None);
    assert_eq!(last4("123456789012"), Some("9012".into()));
    assert_eq!(last4("sk_live_abcdefgh"), Some("efgh".into()));
    // Characters, not bytes.
    assert_eq!(last4("kéy-with-ünicode"), Some("code".into()));
}

// ---- saving and the card -------------------------------------------------------------------------------------------

#[test]
fn a_save_writes_the_value_to_the_store_and_only_metadata_to_the_database() {
    let bench = Bench::new();
    let row = bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    assert_eq!(row.version, 1);
    assert_eq!(row.last4.as_deref(), Some("IjKl"));
    let conn = bench.conn();
    // The value is in the store.
    assert_eq!(
        read_value(&bench.vault, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .as_str(),
        VALUE
    );
    // And nowhere in the database, in any table this package owns or the request it came from.
    let dump = db_text(&conn);
    assert!(!dump.contains(VALUE), "the value reached the database");
    assert!(!dump.contains("iKl"));
}

fn db_text(conn: &Connection) -> String {
    let mut out = String::new();
    for table in [
        "secrets",
        "secret_grants",
        "secret_requests",
        "secret_env_writes",
        "decisions",
        "activity",
    ] {
        let sql = format!("SELECT * FROM {table}");
        let Ok(mut stmt) = conn.prepare(&sql) else {
            continue;
        };
        let columns = stmt.column_count();
        let Ok(rows) = stmt.query_map([], |row| {
            let mut text = String::new();
            for index in 0..columns {
                if let Ok(Some(value)) = row.get::<_, Option<String>>(index) {
                    text.push_str(&value);
                    text.push(' ');
                }
                if let Ok(Some(value)) = row.get::<_, Option<i64>>(index) {
                    text.push_str(&value.to_string());
                    text.push(' ');
                }
            }
            Ok(text)
        }) else {
            continue;
        };
        for row in rows.flatten() {
            out.push_str(&row);
            out.push('\n');
        }
    }
    out
}

#[test]
fn two_windows_answering_one_request_save_once() {
    let bench = Bench::new();
    let conn = bench.conn();
    let out = open_request(
        &bench.vault,
        &conn,
        RequestInput {
            chat: "chat-1".into(),
            mono: Some("mono-1".into()),
            project: None,
            scope: None,
            name: "Stripe API Key".into(),
            why: "to list customers".into(),
        },
        bench.now,
    )
    .unwrap();
    let id = out.request.unwrap().id;
    // Both windows take the card; only one wins the open -> saving transition.
    let (_, first) = begin_save(&conn, &id, bench.now).unwrap();
    let second = begin_save(&conn, &id, bench.now);
    assert!(second.is_err());
    assert!(second.unwrap_err().contains("already saved"));
    finish_save(&bench.vault, &conn, &id, &first, None, VALUE, bench.now).unwrap();
    // A stale answer after the save is refused, and the stored value is the winner's.
    let again = finish_save(
        &bench.vault,
        &conn,
        &id,
        &first,
        None,
        "sk_live_other_key",
        bench.now,
    );
    assert!(again.is_err());
    assert_eq!(
        read_value(&bench.vault, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .as_str(),
        VALUE
    );
    let request = get_request(&conn, &id).unwrap().unwrap();
    assert_eq!(request.state, FILLED);
}

#[test]
fn a_stale_saving_request_reopens_at_startup() {
    let bench = Bench::new();
    let conn = bench.conn();
    let out = open_request(
        &bench.vault,
        &conn,
        RequestInput {
            chat: "chat-1".into(),
            mono: None,
            project: None,
            scope: None,
            name: "stripe-api-key".into(),
            why: "to list customers".into(),
        },
        bench.now,
    )
    .unwrap();
    let id = out.request.unwrap().id;
    begin_save(&conn, &id, bench.now).unwrap();
    // A crash between the keychain write and the row update leaves it saving. Five minutes later it reopens.
    assert_eq!(reopen_stale(&conn, bench.now + 1000).unwrap(), 0);
    assert_eq!(
        reopen_stale(&conn, bench.now + STALE_SAVING_MS + 1).unwrap(),
        1
    );
    assert_eq!(get_request(&conn, &id).unwrap().unwrap().state, OPEN);
    // Saving again works, and leaves exactly one row.
    let (_, token) = begin_save(&conn, &id, bench.now + STALE_SAVING_MS + 2).unwrap();
    finish_save(
        &bench.vault,
        &conn,
        &id,
        &token,
        None,
        VALUE,
        bench.now + STALE_SAVING_MS + 2,
    )
    .unwrap();
    assert_eq!(list_secrets(&conn).unwrap().len(), 1);
}

#[test]
fn a_save_that_wrote_the_value_but_not_the_row_leaves_nothing_usable_by_name() {
    // The construction is keychain first, row second. If the row step never happens (a crash), the item is in the store
    // but no handle, grant or request can name it: nothing usable is left.
    let bench = Bench::new();
    let conn = bench.conn();
    let serviced = service(SCOPE_GLOBAL, "stripe-api-key").unwrap();
    bench.vault.write(&serviced, ACCOUNT, VALUE).unwrap();
    assert!(list_secrets(&conn).unwrap().is_empty());
    assert!(resolve(&conn, None, "stripe-api-key").unwrap().is_none());
    assert!(handles(&conn).unwrap().is_empty());
}

#[test]
fn a_request_returns_a_handle_instead_of_a_card_when_the_name_resolves() {
    let bench = Bench::new();
    bench.save(&scope_for(Some("/p")), "stripe-api-key", VALUE);
    let conn = bench.conn();
    let out = open_request(
        &bench.vault,
        &conn,
        RequestInput {
            chat: "chat-1".into(),
            mono: None,
            project: Some("/p".into()),
            scope: None,
            name: "Stripe API Key".into(),
            why: "to list customers".into(),
        },
        bench.now,
    )
    .unwrap();
    assert!(out.request.is_none());
    assert_eq!(out.secret.unwrap().scope, scope_for(Some("/p")));
    // Asking again in the same chat changes nothing.
    let first = open_request(
        &bench.vault,
        &conn,
        RequestInput {
            chat: "chat-2".into(),
            mono: None,
            project: None,
            scope: None,
            name: "other-key".into(),
            why: "why".into(),
        },
        bench.now,
    )
    .unwrap();
    let again = open_request(
        &bench.vault,
        &conn,
        RequestInput {
            chat: "chat-2".into(),
            mono: None,
            project: None,
            scope: None,
            name: "other-key".into(),
            why: "another reason".into(),
        },
        bench.now + 1,
    )
    .unwrap();
    assert_eq!(first.request.unwrap().id, again.request.unwrap().id);
}

#[test]
fn decline_marks_the_request_and_hands_the_mono_a_plain_note() {
    let bench = Bench::new();
    let conn = bench.conn();
    let out = open_request(
        &bench.vault,
        &conn,
        RequestInput {
            chat: "chat-1".into(),
            mono: None,
            project: None,
            scope: None,
            name: "stripe-api-key".into(),
            why: "why".into(),
        },
        bench.now,
    )
    .unwrap();
    let id = out.request.unwrap().id;
    decline(&conn, &id, None, bench.now + 1).unwrap();
    assert_eq!(get_request(&conn, &id).unwrap().unwrap().state, DECLINED);
    assert!(list_requests(&conn).unwrap().is_empty());
}

// ---- rotate, delete, denial ----------------------------------------------------------------------------------------

#[test]
fn rotate_bumps_the_version_and_an_old_grant_no_longer_matches() {
    let bench = Bench::new();
    let row = bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let old_version = row.version;
    let conn = bench.conn();
    let rotated = rotate(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "sk_live_newer_key",
        bench.now + 1,
    )
    .unwrap();
    assert_eq!(rotated.version, old_version + 1);
    assert_ne!(rotated.version, old_version);
    assert_eq!(rotated.created_at, row.created_at);
    assert_eq!(
        read_value(&bench.vault, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .as_str(),
        "sk_live_newer_key"
    );
    // The old item's last4 and label are carried over, never the old value.
    assert_eq!(rotated.label, row.label);
}

#[test]
fn a_key_that_was_deleted_during_a_run_says_so() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    delete(&bench.vault, &conn, SCOPE_GLOBAL, "stripe-api-key").unwrap();
    let err = read_value(&bench.vault, SCOPE_GLOBAL, "stripe-api-key").unwrap_err();
    assert!(err.contains("deleted"), "{err}");
    assert!(!err.contains(VALUE));
}

/// A store that holds values as the bench does but refuses every write, as a denied Keychain prompt does.
struct RefusesWrites(Memory);

impl Vault for RefusesWrites {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        self.0.read(service, account)
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        Err(crate::platform::secrets::not_saved().to_string())
    }
    fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
        self.0.remove(service, account)
    }
}

#[test]
fn a_store_that_refuses_the_new_value_leaves_the_row_as_it_was() {
    // The row is claimed first and the value second. If the store refuses, the claim is put back: no row may claim a
    // value the store never took, and the old value stays the one a matching grant runs.
    let bench = Bench::new();
    let row = bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    let store = RefusesWrites(Memory::new());
    store.0.seed(
        &service(SCOPE_GLOBAL, "stripe-api-key").unwrap(),
        ACCOUNT,
        VALUE,
    );
    let err = save_value(
        &store,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        None,
        "sk_live_a_newer_key",
        bench.now + 1,
    )
    .unwrap_err();
    assert_eq!(err, crate::platform::secrets::not_saved());
    let kept = get_secret(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .unwrap();
    assert_eq!(kept.version, row.version);
    assert_eq!(kept.last4, row.last4);
    assert_eq!(kept.label, row.label);
    // Nothing claims a value that was never written.
    assert_eq!(
        read_value(&store.0, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .as_str(),
        VALUE
    );

    // The same for a name with no row yet: a refused write leaves no row behind.
    let err = save_value(
        &store,
        &conn,
        SCOPE_GLOBAL,
        "another-key",
        None,
        "sk_live_a_newer_key",
        bench.now + 1,
    )
    .unwrap_err();
    assert_eq!(err, crate::platform::secrets::not_saved());
    assert!(get_secret(&conn, SCOPE_GLOBAL, "another-key")
        .unwrap()
        .is_none());
    assert_eq!(list_secrets(&conn).unwrap().len(), 1);
}

#[test]
fn a_row_write_that_fails_never_leaves_a_value_in_the_store() {
    // The row is the claim. If it cannot be written, for any reason, the store is not given a value that no row names:
    // a value under an old version would be run by a grant that approved the old one.
    let bench = Bench::new();
    let conn = bench.conn();
    conn.execute_batch(
        "CREATE TRIGGER refuse_rows BEFORE INSERT ON secrets BEGIN SELECT RAISE(ABORT, 'no'); END;
         CREATE TRIGGER refuse_changes BEFORE UPDATE ON secrets BEGIN SELECT RAISE(ABORT, 'no'); END;",
    )
    .unwrap();
    assert!(save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        None,
        VALUE,
        bench.now
    )
    .is_err());
    assert!(bench.vault.is_empty());

    // The same for a change to an existing row: its version and last four stay, and so does the store's value.
    conn.execute_batch("DROP TRIGGER refuse_rows; DROP TRIGGER refuse_changes;")
        .unwrap();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    conn.execute_batch(
        "CREATE TRIGGER refuse_changes BEFORE UPDATE ON secrets BEGIN SELECT RAISE(ABORT, 'no'); END;",
    )
    .unwrap();
    assert!(save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        None,
        "sk_live_a_newer_key",
        bench.now + 1
    )
    .is_err());
    assert_eq!(
        read_value(&bench.vault, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .as_str(),
        VALUE
    );
    assert_eq!(
        get_secret(&conn, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .unwrap()
            .last4
            .as_deref(),
        Some("IjKl")
    );
}

#[test]
fn a_lost_row_claim_never_writes_the_value() {
    // Another window took the row (its version moved on) between this window's read and its write. The claim fails
    // first, so the keychain is never given a value under a version nobody approved.
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    conn.execute(
        "UPDATE secrets SET version = version + 1 WHERE scope = ?1 AND name = ?2",
        params![SCOPE_GLOBAL, "stripe-api-key"],
    )
    .unwrap();
    let row = SecretRow {
        scope: SCOPE_GLOBAL.into(),
        name: "stripe-api-key".into(),
        label: "stripe-api-key".into(),
        last4: Some("9999".into()),
        created_at: bench.now,
        updated_at: bench.now,
        last_used_at: None,
        version: 2,
        approved: Vec::new(),
        executables: Vec::new(),
        env_files: Vec::new(),
        needs_value: false,
    };
    // Version 2 is taken now, so a claim at 2 from a read that saw 1 cannot land.
    let err = write_row(&conn, &row, Some(1)).unwrap_err();
    assert!(err.contains("another window"), "{err}");
    assert_eq!(
        read_value(&bench.vault, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .as_str(),
        VALUE
    );
    assert_eq!(
        get_secret(&conn, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .unwrap()
            .last4
            .as_deref(),
        Some("IjKl")
    );
}

/// A store that looks at the row in the database at the moment it receives a value. The order of the two writes is
/// the whole of 5.1: a value must never reach the store while the row still names the old version.
struct WatchesTheRowAtWrite {
    values: Memory,
    db: std::path::PathBuf,
    seen: std::sync::Mutex<Vec<(Option<i64>, Option<String>)>>,
}

impl WatchesTheRowAtWrite {
    fn new(db: &std::path::Path) -> Self {
        Self {
            values: Memory::new(),
            db: db.to_path_buf(),
            seen: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl Vault for WatchesTheRowAtWrite {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        self.values.read(service, account)
    }
    fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        let conn = Connection::open(&self.db).map_err(|e| e.to_string())?;
        let seen = conn
            .query_row(
                "SELECT version, last4 FROM secrets WHERE scope = ?1 AND name = ?2",
                params![SCOPE_GLOBAL, "stripe-api-key"],
                |row| {
                    Ok((
                        Some(row.get::<_, i64>(0)?),
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        self.seen.lock().unwrap().push(seen.unwrap_or((None, None)));
        self.values.write(service, account, value)
    }
    fn remove(&self, service: &str, account: &str) -> Result<bool, String> {
        self.values.remove(service, account)
    }
}

#[test]
fn the_value_is_written_only_after_the_row_names_its_version() {
    // The exact dangerous case from the review: the value changes and the version does not. Reading the row at the
    // instant the store receives the value proves the order rather than trusting it: with the old keychain-first code
    // the row still said version 1 (and the old last four) here.
    let dir = std::env::temp_dir().join(format!("wp92-order-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("monocode.db");
    let store = SessionStore::open(db.clone()).unwrap();
    let vault = WatchesTheRowAtWrite::new(&db);
    const NEW: &str = "sk_live_zzzzzzzzzzzzNew";
    {
        let conn = store.lock_conn().unwrap();
        save_value(
            &vault,
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            None,
            VALUE,
            1,
        )
        .unwrap();
        let seen = vault.seen.lock().unwrap().clone();
        // A name with no row: the row is created (version 1) before the store is given the value.
        assert_eq!(seen, vec![(Some(1), Some("IjKl".to_string()))]);
        save_value(&vault, &conn, SCOPE_GLOBAL, "stripe-api-key", None, NEW, 2).unwrap();
    }
    let seen = vault.seen.lock().unwrap().clone();
    // The change: version 2 and the new last four were already in the row when the store was written.
    assert_eq!(seen.last(), Some(&(Some(2), Some("zNew".to_string()))));
    assert_eq!(
        read_value(&vault, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .as_str(),
        NEW
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn two_windows_saving_at_once_never_pair_a_new_value_with_an_old_version() {
    // Two windows, two database connections to one file, each saving a different value for the same name. Whatever
    // order they finish in, the row's version counts every save and its last four belong to the value the store holds:
    // no grant for an earlier version can run a later value and be told it was the approved one.
    let dir = std::env::temp_dir().join(format!("wp92-race-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("monocode.db");
    let first = SessionStore::open(db.clone()).unwrap();
    let second = SessionStore::open(db.clone()).unwrap();
    let vault = Memory::new();
    const A: &str = "sk_live_aaaaaaaaaaaaAA";
    const B: &str = "sk_live_bbbbbbbbbbbbBB";
    const SAVES: i64 = 5;
    let vault_ref = &vault;
    std::thread::scope(|scope| {
        for (store, value) in [(&first, A), (&second, B)] {
            scope.spawn(move || {
                for step in 0..SAVES {
                    let conn = store.lock_conn().unwrap();
                    save_value(
                        vault_ref,
                        &conn,
                        SCOPE_GLOBAL,
                        "stripe-api-key",
                        None,
                        value,
                        step,
                    )
                    .unwrap();
                }
            });
        }
    });
    let conn = first.lock_conn().unwrap();
    let row = get_secret(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .unwrap();
    let held = read_value(&vault, SCOPE_GLOBAL, "stripe-api-key").unwrap();
    assert_eq!(row.version, SAVES * 2);
    assert_eq!(row.last4.as_deref(), last4(&held).as_deref());
    assert!(held.as_str() == A || held.as_str() == B);
    assert_eq!(list_secrets(&conn).unwrap().len(), 1);
}

#[test]
fn rotate_never_brings_back_a_deleted_secret() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    delete(&bench.vault, &conn, SCOPE_GLOBAL, "stripe-api-key").unwrap();
    let err = rotate(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "sk_live_a_newer_key",
        bench.now + 1,
    )
    .unwrap_err();
    assert!(err.contains("isn't here any more"), "{err}");
    assert!(list_secrets(&conn).unwrap().is_empty());
    assert!(read_value(&bench.vault, SCOPE_GLOBAL, "stripe-api-key").is_err());
}

struct RefusesRemoval(Memory);

impl Vault for RefusesRemoval {
    fn read(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        self.0.read(service, account)
    }
    fn write(&self, service: &str, account: &str, value: &str) -> Result<(), String> {
        self.0.write(service, account, value)
    }
    fn remove(&self, _: &str, _: &str) -> Result<bool, String> {
        Err(crate::platform::secrets::not_removed().to_string())
    }
}

#[test]
fn delete_takes_the_grants_and_the_row_before_the_keychain_item() {
    // A delete that cannot remove the keychain item still leaves nothing that names it: no grant can pass and then
    // fail on a missing value forever. The item is unreachable, and the report says it stayed.
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        "stripe",
        "always",
        bench.now,
    )
    .unwrap();
    let store = RefusesRemoval(Memory::new());
    store.0.seed(
        &service(SCOPE_GLOBAL, "stripe-api-key").unwrap(),
        ACCOUNT,
        VALUE,
    );
    let report = delete(&store, &conn, SCOPE_GLOBAL, "stripe-api-key").unwrap();
    assert_eq!(report.removed_grants, 1);
    assert!(report.keychain_kept);
    assert!(list_secrets(&conn).unwrap().is_empty());
    assert!(grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .is_empty());
    assert_eq!(
        find_grant(
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            Some("mono-1"),
            None,
            "stripe"
        )
        .unwrap(),
        None
    );
    assert_eq!(store.0.len(), 1);
}

#[test]
fn delete_says_nothing_about_the_keychain_when_the_item_is_gone() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    let report = delete(&bench.vault, &conn, SCOPE_GLOBAL, "stripe-api-key").unwrap();
    assert!(!report.keychain_kept);
    assert!(bench.vault.is_empty());
}

struct Denied;

impl Vault for Denied {
    fn read(&self, _: &str, _: &str) -> Result<Option<String>, String> {
        Err(crate::platform::secrets::not_read().to_string())
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        Err(crate::platform::secrets::not_saved().to_string())
    }
    fn remove(&self, _: &str, _: &str) -> Result<bool, String> {
        Err(crate::platform::secrets::not_removed().to_string())
    }
}

#[test]
fn a_store_refusal_is_try_again_not_wrong_secret() {
    let bench = Bench::new();
    let conn = bench.conn();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    let err = read_value(&Denied, SCOPE_GLOBAL, "stripe-api-key").unwrap_err();
    assert!(!err.contains("wrong"), "{err}");
    assert!(!err.contains(VALUE));
    // The sentence the run shows for any store refusal lives in one place.
    assert!(super::run::KEYCHAIN_DENIED.contains("Try again"));
    // A locked keychain has its own sentence, in `platform::secrets` where the other failure words live.
    assert!(crate::platform::secrets::locked().contains("locked"));
}

struct Locked;

impl Vault for Locked {
    fn read(&self, _: &str, _: &str) -> Result<Option<String>, String> {
        Err(crate::platform::secrets::locked().to_string())
    }
    fn write(&self, _: &str, _: &str, _: &str) -> Result<(), String> {
        Err(crate::platform::secrets::locked().to_string())
    }
    fn remove(&self, _: &str, _: &str) -> Result<bool, String> {
        Err(crate::platform::secrets::locked().to_string())
    }
}

#[test]
fn a_locked_store_says_locked_and_never_shows_the_value() {
    let bench = Bench::new();
    let conn = bench.conn();
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    let err = read_value(&Locked, SCOPE_GLOBAL, "stripe-api-key").unwrap_err();
    assert_eq!(err, crate::platform::secrets::locked());
    assert!(err.contains("Unlock it and try again"), "{err}");
    assert!(!err.contains(VALUE));
}

#[test]
fn delete_removes_every_grant_and_names_what_stops_working() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        "stripe",
        "always",
        bench.now,
    )
    .unwrap();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "project",
        "/p",
        "stripe",
        "always",
        bench.now,
    )
    .unwrap();
    let report = delete(&bench.vault, &conn, SCOPE_GLOBAL, "stripe-api-key").unwrap();
    assert_eq!(report.removed_grants, 2);
    assert!(grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .is_empty());
    assert!(list_secrets(&conn).unwrap().is_empty());
    assert!(bench
        .vault
        .read(&service(SCOPE_GLOBAL, "stripe-api-key").unwrap(), ACCOUNT)
        .unwrap()
        .is_none());
}

#[test]
fn renaming_changes_the_label_and_keeps_the_slug_and_grants() {
    let bench = Bench::new();
    let row = bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        "stripe",
        "always",
        bench.now,
    )
    .unwrap();
    let renamed = rename(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "Stripe (live)",
        row.version,
        bench.now + 1,
    )
    .unwrap();
    assert_eq!(renamed.label, "Stripe (live)");
    assert_eq!(renamed.name, "stripe-api-key");
    assert_eq!(
        grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
            .unwrap()
            .len(),
        1
    );
    // A stale rename is refused.
    assert!(rename(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "other",
        row.version,
        bench.now + 2
    )
    .is_err());
}

// ---- grants --------------------------------------------------------------------------------------------------------

#[test]
fn a_mono_grant_works_for_that_mono_and_not_another() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        "stripe",
        "always",
        bench.now,
    )
    .unwrap();
    assert!(find_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        Some("mono-1"),
        None,
        "stripe"
    )
    .unwrap()
    .is_some());
    assert!(find_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        Some("mono-2"),
        None,
        "stripe"
    )
    .unwrap()
    .is_none());
    // A different executable is not covered by the same grant.
    assert!(find_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        Some("mono-1"),
        None,
        "curl"
    )
    .unwrap()
    .is_none());
}

#[test]
fn a_project_grant_works_for_every_mono_in_the_project_and_not_outside_it() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "project",
        "/p",
        "stripe",
        "always",
        bench.now,
    )
    .unwrap();
    for mono in ["mono-1", "mono-2"] {
        assert!(find_grant(
            &conn,
            SCOPE_GLOBAL,
            "stripe-api-key",
            Some(mono),
            Some("/p"),
            "stripe"
        )
        .unwrap()
        .is_some());
    }
    assert!(find_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        Some("mono-1"),
        Some("/other"),
        "stripe"
    )
    .unwrap()
    .is_none());
    assert!(find_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        Some("mono-1"),
        None,
        "stripe"
    )
    .unwrap()
    .is_none());
}

#[test]
fn a_once_grant_is_spent_once_even_when_two_runs_race_for_it() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    put_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        "stripe",
        "once",
        bench.now,
    )
    .unwrap();
    assert!(spend_once(&conn, SCOPE_GLOBAL, "stripe-api-key", "mono-1", "stripe").unwrap());
    assert!(!spend_once(&conn, SCOPE_GLOBAL, "stripe-api-key", "mono-1", "stripe").unwrap());
    assert!(find_grant(
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        Some("mono-1"),
        None,
        "stripe"
    )
    .unwrap()
    .is_none());
    drop(conn);

    // The race itself: two connections to one database file released together. The DELETE is compare-and-swap on the
    // `once` row, so exactly one of them may win.
    let dir = std::env::temp_dir().join(format!("wp92-race-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("race.sqlite");
    let setup = Connection::open(&path).unwrap();
    ensure_tables(&setup).unwrap();
    put_grant(
        &setup,
        SCOPE_GLOBAL,
        "stripe-api-key",
        "mono",
        "mono-1",
        "stripe",
        "once",
        bench.now,
    )
    .unwrap();
    drop(setup);
    let start = std::sync::Arc::new(std::sync::Barrier::new(2));
    let racers: Vec<_> = (0..2)
        .map(|_| {
            let (path, start) = (path.clone(), start.clone());
            std::thread::spawn(move || {
                let conn = Connection::open(&path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                start.wait();
                spend_once(&conn, SCOPE_GLOBAL, "stripe-api-key", "mono-1", "stripe").unwrap()
            })
        })
        .collect();
    let wins = racers
        .into_iter()
        .map(|racer| racer.join().unwrap())
        .filter(|won| *won)
        .count();
    assert_eq!(wins, 1, "exactly one racing run may spend the once grant");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- the tools' rules -----------------------------------------------------------------------------------------------

#[test]
fn a_shell_wrapper_is_refused_and_an_argv_is_taken() {
    for command in [
        vec!["sh".to_string(), "-c".into(), "stripe".into()],
        vec!["bash".into(), "-lc".into(), "x".into()],
        vec!["cmd".into(), "/c".into(), "x".into()],
        vec!["cmd.exe".into(), "/c".into(), "x".into()],
        vec!["powershell".into(), "-Command".into(), "x".into()],
        vec!["powershell.exe".into(), "-Command".into(), "x".into()],
        vec!["pwsh".into(), "-c".into(), "x".into()],
        vec!["env".into(), "stripe".into()],
        vec!["/usr/bin/env".into(), "stripe".into()],
    ] {
        assert!(executable_of(&command).is_err(), "{command:?}");
    }
    assert_eq!(
        executable_of(&["stripe".into(), "customers".into(), "list".into()]).unwrap(),
        "stripe"
    );
    assert_eq!(
        executable_of(&["/usr/local/bin/stripe".into(), "list".into()]).unwrap(),
        "/usr/local/bin/stripe"
    );
    assert!(executable_of(&[]).is_err());
    assert!(executable_of(&["stripe customers list".into()]).is_err());
}

#[test]
fn the_environment_name_is_capital_letters_digits_and_underscores() {
    for good in ["A", "STRIPE_API_KEY", "_X", "A1_B2"] {
        assert!(valid_env_name(good), "{good}");
    }
    for bad in ["", "lower", "1A", "A-B", "A B", &"A".repeat(65)] {
        assert!(!valid_env_name(bad), "{bad:?}");
    }
}

#[test]
fn a_project_secret_wins_over_a_global_one() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", "global-value-123");
    bench.save(
        &scope_for(Some("/p")),
        "stripe-api-key",
        "project-value-123",
    );
    let conn = bench.conn();
    let row = resolve(&conn, Some("/p"), "stripe-api-key")
        .unwrap()
        .unwrap();
    assert_eq!(row.scope, scope_for(Some("/p")));
    let global = resolve(&conn, Some("/other"), "stripe-api-key")
        .unwrap()
        .unwrap();
    assert_eq!(global.scope, SCOPE_GLOBAL);
}

// ---- the approval flow ----------------------------------------------------------------------------------------------

fn run_request(project: Option<&str>, mono: &str) -> RunRequest {
    RunRequest {
        chat: "chat-1".into(),
        mono: Some(mono.into()),
        project: project.map(str::to_string),
        name: "stripe-api-key".into(),
        env: "STRIPE_API_KEY".into(),
        command: vec!["stripe".into(), "customers".into(), "list".into()],
        cwd: None,
        timeout_seconds: None,
    }
}

#[test]
fn first_use_asks_once_and_always_for_this_mono_stops_the_asking() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let mut conn = bench.conn();
    let first = prepare_run(
        &bench.vault,
        &mut conn,
        run_request(None, "mono-1"),
        bench.now,
    )
    .unwrap();
    let RunOutcome::Waiting { decision_key, .. } = first else {
        panic!("the first use must ask");
    };
    // The card is an ordinary decision, so it lands in the Inbox and survives a restart.
    let asked = crate::decisions::get(&conn, "", &decision_key)
        .unwrap()
        .unwrap();
    assert_eq!(asked.options, vec!["Once", "Always for this Mono", "No"]);
    assert!(asked.question.contains("stripe"));
    // Answer "Always for this Mono".
    // The person answers on their own path (the Inbox sends `user`); a bare `None` is no one's and never settles a
    // secret card.
    crate::decisions::answer(
        &mut conn,
        "",
        &decision_key,
        "Always for this Mono",
        Some("user".into()),
        bench.now + 1,
    )
    .unwrap();
    let granted = prepare_run(
        &bench.vault,
        &mut conn,
        run_request(None, "mono-1"),
        bench.now + 2,
    )
    .unwrap();
    let RunOutcome::Granted { grant, version, .. } = granted else {
        panic!("the answer grants the run");
    };
    assert_eq!(version, 1);
    assert!(!grant.is_empty());
    // The next run never asks.
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            run_request(None, "mono-1"),
            bench.now + 3
        )
        .unwrap(),
        RunOutcome::Granted { .. }
    ));
    // Only that Mono.
    let other = prepare_run(
        &bench.vault,
        &mut conn,
        run_request(None, "mono-2"),
        bench.now + 4,
    )
    .unwrap();
    assert!(matches!(other, RunOutcome::Waiting { .. }));
}

#[test]
fn once_asks_again_after_it_is_spent() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let mut conn = bench.conn();
    let RunOutcome::Waiting { decision_key, .. } = prepare_run(
        &bench.vault,
        &mut conn,
        run_request(None, "mono-1"),
        bench.now,
    )
    .unwrap() else {
        panic!("asks first");
    };
    crate::decisions::answer(
        &mut conn,
        "",
        &decision_key,
        "Once",
        Some("user".into()),
        bench.now + 1,
    )
    .unwrap();
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            run_request(None, "mono-1"),
            bench.now + 2
        )
        .unwrap(),
        RunOutcome::Granted { .. }
    ));
    // Spent: the next run asks again.
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            run_request(None, "mono-1"),
            bench.now + 3
        )
        .unwrap(),
        RunOutcome::Waiting { .. }
    ));
}

#[test]
fn no_writes_nothing_and_says_so() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let mut conn = bench.conn();
    let RunOutcome::Waiting { decision_key, .. } = prepare_run(
        &bench.vault,
        &mut conn,
        run_request(None, "mono-1"),
        bench.now,
    )
    .unwrap() else {
        panic!("asks first");
    };
    crate::decisions::answer(
        &mut conn,
        "",
        &decision_key,
        "No",
        Some("user".into()),
        bench.now + 1,
    )
    .unwrap();
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            run_request(None, "mono-1"),
            bench.now + 2
        )
        .unwrap(),
        RunOutcome::Denied { .. }
    ));
    assert!(grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .is_empty());
}

#[test]
fn always_for_this_project_covers_every_mono_in_it_and_no_other_project() {
    let bench = Bench::new();
    bench.save(&scope_for(Some("/p")), "stripe-api-key", VALUE);
    let mut conn = bench.conn();
    let RunOutcome::Waiting { decision_key, .. } = prepare_run(
        &bench.vault,
        &mut conn,
        run_request(Some("/p"), "mono-1"),
        bench.now,
    )
    .unwrap() else {
        panic!("asks first");
    };
    let asked = crate::decisions::get(&conn, "/p", &decision_key)
        .unwrap()
        .unwrap();
    assert!(asked
        .options
        .contains(&"Always for this project".to_string()));
    crate::decisions::answer(
        &mut conn,
        "/p",
        &decision_key,
        "Always for this project",
        Some("user".into()),
        bench.now + 1,
    )
    .unwrap();
    for mono in ["mono-1", "mono-2"] {
        assert!(matches!(
            prepare_run(
                &bench.vault,
                &mut conn,
                run_request(Some("/p"), mono),
                bench.now + 2
            )
            .unwrap(),
            RunOutcome::Granted { .. }
        ));
    }
    assert!(matches!(
        prepare_run(
            &bench.vault,
            &mut conn,
            run_request(Some("/other"), "mono-1"),
            bench.now + 3
        )
        .unwrap(),
        RunOutcome::Missing { .. }
    ));
}

#[test]
fn a_missing_secret_says_which_scope_to_ask_in() {
    let bench = Bench::new();
    let mut conn = bench.conn();
    let outcome = prepare_run(
        &bench.vault,
        &mut conn,
        run_request(None, "mono-1"),
        bench.now,
    )
    .unwrap();
    let RunOutcome::Missing { name, scope } = outcome else {
        panic!("missing");
    };
    assert_eq!(name, "stripe-api-key");
    assert_eq!(scope, SCOPE_GLOBAL);
}

#[test]
fn a_cwd_outside_the_project_is_refused_before_any_grant() {
    let bench = Bench::new();
    bench.save(&scope_for(Some("/p")), "stripe-api-key", VALUE);
    let mut conn = bench.conn();
    let mut request = run_request(Some("/p"), "mono-1");
    request.cwd = Some("/definitely/not/p".into());
    assert!(prepare_run(&bench.vault, &mut conn, request, bench.now).is_err());
    // No project means no cwd at all. A global secret of the same name lets the request get past "missing" and as far
    // as the folder rule.
    save_value(
        &bench.vault,
        &conn,
        SCOPE_GLOBAL,
        "stripe-api-key",
        None,
        VALUE,
        bench.now,
    )
    .unwrap();
    let mut request = run_request(None, "mono-1");
    request.cwd = Some("/tmp".into());
    assert!(prepare_run(&bench.vault, &mut conn, request, bench.now).is_err());
}

#[test]
fn a_signed_grant_round_trips_and_the_wrong_store_refuses_it() {
    let payload = grant::Payload {
        scope: SCOPE_GLOBAL.into(),
        name: "stripe-api-key".into(),
        version: 1,
        subject: "mono-1".into(),
        env: "STRIPE_API_KEY".into(),
        command: vec!["stripe".into()],
        cwd: None,
        nonce: "0011223344556677".into(),
        expires_at: grant::now_millis() + 60_000,
        timeout_seconds: 120,
    };
    let daily = Memory::new();
    let dev = Memory::new();
    let signed = grant::sign_payload(&daily, &payload).unwrap();
    let dir = std::env::temp_dir().join(format!("mc-grant-t-{}", uuid::Uuid::new_v4()));
    let dev_dir = std::env::temp_dir().join(format!("mc-grant-t-{}", uuid::Uuid::new_v4()));
    // The daily app's store verifies it; a dev copy's store has a different key, so it refuses.
    assert_eq!(
        grant::check(&daily, &signed, &dir, grant::now_millis()).unwrap(),
        payload
    );
    assert!(grant::check(&dev, &signed, &dev_dir, grant::now_millis()).is_err());
    // A replayed nonce is refused even by the store that signed it.
    assert!(grant::check(&daily, &signed, &dir, grant::now_millis()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dev_dir);
}

// ---- memory and export ---------------------------------------------------------------------------------------------

#[test]
fn a_memory_note_that_holds_a_known_value_is_refused_whatever_its_shape() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    for text in [
        format!("note {VALUE}"),
        format!("note {}", scrub::percent(VALUE, true)),
        format!("note {}", scrub::hex(VALUE, false)),
    ] {
        assert!(
            holds_known_value(&bench.vault, &conn, None, &text),
            "{text}"
        );
    }
    assert!(!holds_known_value(
        &bench.vault,
        &conn,
        None,
        "an ordinary note"
    ));
    // Scoped: a project save only checks that project's values.
    save_value(
        &bench.vault,
        &conn,
        &scope_for(Some("/p")),
        "other-key",
        None,
        "project-only-value",
        bench.now,
    )
    .unwrap();
    assert!(!holds_known_value(
        &bench.vault,
        &conn,
        Some(SCOPE_GLOBAL),
        "project-only-value"
    ));
}

#[test]
fn the_export_index_holds_metadata_only() {
    let bench = Bench::new();
    bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let conn = bench.conn();
    let index = index_json(&conn).unwrap();
    let text = index.to_string();
    assert!(text.contains("stripe-api-key"));
    assert!(!text.contains(VALUE));
    assert!(!text.contains("iKl"));
    assert!(index["secrets"][0].get("createdAt").is_some());
}

#[test]
fn an_import_lands_needing_its_value_with_no_grants() {
    let bench = Bench::new();
    let conn = bench.conn();
    let index = serde_json::json!({
        "secrets": [{"name": "stripe-api-key", "scope": "global", "label": "Stripe", "last4": "iKl", "createdAt": 1}]
    });
    assert_eq!(import_index(&conn, &index, bench.now).unwrap(), 1);
    let rows = handles(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].needs_value);
    assert_eq!(rows[0].label, "Stripe");
    assert!(grants_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .is_empty());
    assert!(env_writes_for(&conn, SCOPE_GLOBAL, "stripe-api-key")
        .unwrap()
        .is_empty());
    // Importing again changes nothing.
    assert_eq!(import_index(&conn, &index, bench.now).unwrap(), 0);
}

#[test]
fn an_import_bounds_a_label_and_a_last_four_it_cannot_trust() {
    let bench = Bench::new();
    let conn = bench.conn();
    let huge = "L".repeat(1_000_000);
    let index = serde_json::json!({
        "secrets": [
            {"name": "huge-label", "scope": "global", "label": huge, "last4": "wxyz"},
            {"name": "long-last4", "scope": "global", "label": "Fine", "last4": "abcdefghijkl"},
            {"name": "short-last4", "scope": "global", "label": "Fine", "last4": "ab"},
            {"name": "control-last4", "scope": "global", "label": "Fine", "last4": "ab\ncd"},
            {"name": "control-label", "scope": "global", "label": "Two\nlines\u{0}here", "last4": 1234},
            {"name": "blank-label", "scope": "global", "label": "   ", "last4": null},
            {"name": "unicode-label", "scope": "global", "label": "Clé secrète", "last4": "éèàù"}
        ]
    });
    assert_eq!(import_index(&conn, &index, bench.now).unwrap(), 7);
    let row = |name: &str| get_secret(&conn, SCOPE_GLOBAL, name).unwrap().unwrap();
    // An oversized label is cut to the same bound a save has, and the row is still a "needs its value" one.
    let huge_row = row("huge-label");
    assert_eq!(huge_row.label.chars().count(), LABEL_MAX);
    assert_eq!(huge_row.version, 0);
    assert_eq!(huge_row.last4.as_deref(), Some("wxyz"));
    // A last four is exactly four characters or nothing.
    assert_eq!(row("long-last4").last4, None);
    assert_eq!(row("short-last4").last4, None);
    assert_eq!(row("control-last4").last4, None);
    assert_eq!(row("control-label").last4, None);
    assert_eq!(row("unicode-label").last4.as_deref(), Some("éèàù"));
    // No control character gets into a label; a blank one falls back to the name.
    assert_eq!(row("control-label").label, "Twolineshere");
    assert_eq!(row("blank-label").label, "blank-label");
    assert_eq!(row("unicode-label").label, "Clé secrète");
}

#[test]
fn an_import_never_widens_a_scope_it_cannot_read_to_global() {
    let bench = Bench::new();
    let conn = bench.conn();
    let index = serde_json::json!({
        "secrets": [
            {"name": "kept-project", "scope": "project./work/proj", "label": "A"},
            {"name": "no-scope", "label": "B"},
            {"name": "bad-scope", "scope": "everyone", "label": "C"},
            {"name": "empty-project", "scope": "project.", "label": "D"},
            {"name": "huge-project", "scope": format!("project.{}", "p".repeat(5_000)), "label": "E"},
            {"name": "number-scope", "scope": 7, "label": "F"}
        ]
    });
    assert_eq!(import_index(&conn, &index, bench.now).unwrap(), 2);
    assert!(get_secret(&conn, "project./work/proj", "kept-project")
        .unwrap()
        .is_some());
    assert!(get_secret(&conn, SCOPE_GLOBAL, "no-scope")
        .unwrap()
        .is_some());
    for skipped in ["bad-scope", "empty-project", "huge-project", "number-scope"] {
        assert!(
            get_secret(&conn, SCOPE_GLOBAL, skipped).unwrap().is_none(),
            "{skipped} must not land in global"
        );
    }
}

#[test]
fn an_import_takes_at_most_a_thousand_rows() {
    let bench = Bench::new();
    let conn = bench.conn();
    let rows: Vec<serde_json::Value> = (0..1_200)
        .map(|n| serde_json::json!({"name": format!("key-{n}"), "scope": "global", "label": "k"}))
        .collect();
    let added = import_index(&conn, &serde_json::json!({ "secrets": rows }), bench.now).unwrap();
    assert_eq!(added, IMPORT_MAX);
    assert_eq!(list_secrets(&conn).unwrap().len(), IMPORT_MAX);
}

#[test]
fn a_secret_is_never_in_any_error_or_debug_line() {
    let bench = Bench::new();
    let row = bench.save(SCOPE_GLOBAL, "stripe-api-key", VALUE);
    let shown = format!("{row:?}");
    assert!(!shown.contains(VALUE));
    let value = validate_value(VALUE).unwrap();
    let wrapper = SecretValue {
        name: "stripe-api-key".into(),
        value,
        scope: SCOPE_GLOBAL.into(),
    };
    let shown = format!("{wrapper:?}");
    assert!(!shown.contains(VALUE), "{shown}");
    assert!(shown.contains("stripe-api-key"));
}
