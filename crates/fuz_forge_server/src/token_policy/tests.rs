use super::*;
use crate::parity::{flag, parity_rows};

const SCHEMA_FIXTURE: &str =
    include_str!("../../../../src/test/fixtures/parity/token_policy_schema.json");
const STORED_FIXTURE: &str =
    include_str!("../../../../src/test/fixtures/parity/policy_from_stored.json");

fn list(ids: &[&str]) -> TemplateResources {
    TemplateResources::List(ids.iter().map(|s| (*s).to_owned()).collect())
}

#[test]
fn admin_template_is_none() {
    assert!(policy_from_template(&FuzForgeTokenTemplate::Admin).is_none());
}

#[test]
fn files_read_keys_by_filename() {
    let p =
        policy_from_template(&FuzForgeTokenTemplate::FilesRead(list(&["allowed.bin"]))).unwrap();
    assert!(policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead {
            filename: "allowed.bin"
        }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead {
            filename: "denied.bin"
        }
    ));
    // read template grants neither write nor delete
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesWrite {
            filename: "allowed.bin"
        }
    ));
}

#[test]
fn files_write_does_not_grant_read() {
    let p =
        policy_from_template(&FuzForgeTokenTemplate::FilesWrite(TemplateResources::All)).unwrap();
    assert!(policy_check(
        Some(&p),
        &FuzForgeCapability::FilesWrite { filename: "x" }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead { filename: "x" }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesDelete { filename: "x" }
    ));
}

#[test]
fn files_read_write_grants_both_same_set() {
    let p = policy_from_template(&FuzForgeTokenTemplate::FilesReadWrite(list(&["a"]))).unwrap();
    assert!(policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead { filename: "a" }
    ));
    assert!(policy_check(
        Some(&p),
        &FuzForgeCapability::FilesWrite { filename: "a" }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead { filename: "b" }
    ));
}

#[test]
fn forge_pull_keys_by_repo_and_denies_push() {
    let p = policy_from_template(&FuzForgeTokenTemplate::ForgePull(list(&["repo-1"]))).unwrap();
    assert!(policy_check(
        Some(&p),
        &FuzForgeCapability::ForgePull { repo_id: "repo-1" }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::ForgePull { repo_id: "repo-2" }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::ForgePush { repo_id: "repo-1" }
    ));
}

#[test]
fn unscoped_policy_allows_all() {
    assert!(policy_check(
        None,
        &FuzForgeCapability::ForgePush { repo_id: "any" }
    ));
    assert!(policy_check(
        None,
        &FuzForgeCapability::FilesDelete { filename: "any" }
    ));
}

#[test]
fn deny_all_policy_denies_everything() {
    // A bare `{version: 1}` with no grant sections — also what an
    // unreadable stored policy resolves to.
    let p = DENY_ALL_POLICY;
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead { filename: "x" }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesWrite { filename: "x" }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesDelete { filename: "x" }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::ForgePush { repo_id: "x" }
    ));
}

/// The TS twin's `build_resource_map` had to be built with
/// `Object.fromEntries`, because `record["__proto__"] = true` invokes the
/// `Object.prototype.__proto__` setter instead of defining an own property
/// and silently drops the grant. `BTreeMap` has no such key, so this side
/// always worked — pinned so the pair stays a matched twin rather than an
/// accident, since `__proto__` passes the shared forge-key charset.
#[test]
fn a_proto_filename_is_an_ordinary_key() {
    let p = policy_from_template(&FuzForgeTokenTemplate::FilesRead(list(&["__proto__"]))).unwrap();
    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        serde_json::json!({"version": 1, "files": {"read": {"__proto__": true}}}),
    );
    assert!(policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead {
            filename: "__proto__"
        }
    ));
    assert!(!policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead { filename: "other" }
    ));
}

/// The `rpc` grant is a stored **record**, not a gate — the spine's
/// `api_token.scope` decides RPC, so `FuzForgeCapability` has no `Rpc`
/// variant and nothing reads this field back. The template still writes it,
/// so the row says what the token was minted for; that is what this pins.
#[test]
fn rpc_subset_records_its_grant_without_a_checker() {
    let p = policy_from_template(&FuzForgeTokenTemplate::RpcSubset(list(&["cell_get"]))).unwrap();
    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        serde_json::json!({"version": 1, "rpc": {"cell_get": true}}),
    );
}

#[test]
fn capability_string_matches_ts_format() {
    assert_eq!(
        FuzForgeCapability::ForgePush { repo_id: "r1" }.as_string(),
        "forge.push:r1"
    );
    assert_eq!(
        FuzForgeCapability::FilesRead {
            filename: "denied.bin"
        }
        .as_string(),
        "files.read:denied.bin"
    );
}

#[test]
fn deserializes_ts_wire_shape() {
    // The exact JSONB the TS `policy_from_template({kind:'files_read',
    // filenames:['allowed.bin']})` writes — both backends read this row.
    let json = serde_json::json!({
        "version": 1,
        "files": {"read": {"allowed.bin": true}},
    });
    let p: FuzForgeTokenPolicy = serde_json::from_value(json).unwrap();
    assert!(policy_check(
        Some(&p),
        &FuzForgeCapability::FilesRead {
            filename: "allowed.bin"
        }
    ));
    // The wildcard literal round-trips. Asserted on the `rpc` grant on
    // purpose: it has no checker, so parsing is the only thing standing
    // between a stored `rpc_subset` row and a deserialization error that
    // would fail the whole policy — including its file/forge grants.
    let wild: FuzForgeTokenPolicy =
        serde_json::from_value(serde_json::json!({"version": 1, "rpc": "*"})).unwrap();
    assert_eq!(wild.rpc, Some(ResourceMap::Wildcard(WildcardLiteral)));
    // …and a wildcard on a grant that *is* checked admits any id.
    let wild_files: FuzForgeTokenPolicy =
        serde_json::from_value(serde_json::json!({"version": 1, "files": {"read": "*"}})).unwrap();
    assert!(policy_check(
        Some(&wild_files),
        &FuzForgeCapability::FilesRead {
            filename: "anything"
        }
    ));
    // empty-qualifier object value is "allowed"
    let empty_q: FuzForgeTokenPolicy =
        serde_json::from_value(serde_json::json!({"version": 1, "files": {"write": {"f": {}}}}))
            .unwrap();
    assert!(policy_check(
        Some(&empty_q),
        &FuzForgeCapability::FilesWrite { filename: "f" }
    ));
}

/// The schema's three shared tables, asserted against
/// `src/test/fixtures/parity/token_policy_schema.json` — the TS twin's
/// `FuzForgeTokenPolicy schema` suite reads the same rows.
///
/// - `version`: exactly `1`, present, numeric, with the integral-float
///   spelling `1.0` reading as `1` (this side parses `policy::text` itself
///   and gets a float where the TS driver hands the schema a pre-parsed
///   jsonb value).
/// - `grant_values`: a value outside `true | {}` fails the whole document
///   rather than being read as a grant here and refused there.
/// - `optional_null`: `#[serde(default)] Option<T>` alone reads `null` as
///   absence, where the TS `.optional()` refuses it — so a
///   `{"files": null, "forge": {"push": "*"}}` row granted push here and
///   denied everything there.
///
/// An accepted row asserts the parse **result**, not merely that it parsed: a
/// deserializer that admitted `{"version": 1}` and dropped its grants would
/// pass an `is_ok()` loop while silently unscoping (or over-scoping) a token.
#[test]
fn schema_matches_the_shared_tables() {
    for table in ["version", "grant_values", "optional_null"] {
        for row in parity_rows(SCHEMA_FIXTURE, table) {
            let document = &row["document"];
            let parsed = serde_json::from_value::<FuzForgeTokenPolicy>(document.clone());
            assert_eq!(
                parsed.is_ok(),
                flag(&row, "accepted"),
                "{table} document {document}",
            );
            let Ok(policy) = parsed else { continue };
            let reads_f = policy_check(
                Some(&policy),
                &FuzForgeCapability::FilesRead { filename: "f" },
            );
            match table {
                // Every accepted `version` row is the bare grant-less document.
                "version" => assert_eq!(policy, DENY_ALL_POLICY, "version document {document}"),
                // Both accepted spellings — `true` and `{}` — grant `files.read` on `f`.
                "grant_values" => assert!(reads_f, "grant_values document {document}"),
                // Absent-or-empty sections parse and grant nothing.
                _ => assert!(!reads_f, "optional_null document {document}"),
            }
        }
    }
}

/// Both grant spellings round-trip unchanged — `{}` is not rewritten to
/// `true` on the way back out, so a document written by either backend
/// re-serializes to the bytes it was stored as.
#[test]
fn grant_spellings_round_trip() {
    let doc = serde_json::json!({
        "version": 1,
        "files": {"read": {"a": true, "b": {}}},
    });
    let parsed: FuzForgeTokenPolicy = serde_json::from_value(doc.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), doc);
}

/// The fail-closed read table, asserted against
/// `src/test/fixtures/parity/policy_from_stored.json` — the TS twin's
/// `policy_from_stored` suite reads the same rows. Every unreadable spelling
/// lands on [`DENY_ALL_POLICY`] rather than on the unscoped case, which is
/// what a `None` would mean to [`policy_check`].
///
/// A row carrying `text` instead of `document` is raw bytes this side reads
/// and the TS twin never sees: this side reads `policy::text` and does its own
/// parse, while the TS driver hands the schema an already-parsed jsonb value,
/// so unparseable bytes never reach `policy_from_stored` there.
#[test]
fn policy_from_stored_fails_closed() {
    for row in parity_rows(STORED_FIXTURE, "stored") {
        let stored = row.get("text").map_or_else(
            || serde_json::to_string(&row["document"]).expect("document serializes"),
            |text| text.as_str().expect("text row carries a string").to_owned(),
        );
        let policy = policy_from_stored(&stored, "tok_1");
        let readable = flag(&row, "accepted");
        let filename = row
            .get("filename")
            .and_then(|v| v.as_str())
            .unwrap_or("a.bin");
        assert_eq!(
            policy_check(Some(&policy), &FuzForgeCapability::FilesRead { filename }),
            readable,
            "stored policy {stored}",
        );
        if !readable {
            assert_eq!(
                policy, DENY_ALL_POLICY,
                "stored policy {stored} must deny all"
            );
        }
    }
}

#[test]
fn serializes_back_to_ts_wire_shape() {
    let p = policy_from_template(&FuzForgeTokenTemplate::FilesRead(list(&["a.bin"]))).unwrap();
    let value = serde_json::to_value(&p).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"version": 1, "files": {"read": {"a.bin": true}}})
    );
}
