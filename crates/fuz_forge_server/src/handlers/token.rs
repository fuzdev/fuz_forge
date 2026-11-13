//! Scoped-token RPC handlers.
//!
//! Port of `src/lib/server/routes/fuz_forge_token.ts`:
//! `fuz_forge_token_create_scoped` / `fuz_forge_token_policy_list`. Maps the
//! wire `template` discriminated union onto the [`FuzForgeTokenTemplate`]
//! grammar, derives the policy doc via the shared [`policy_from_template`], and
//! writes the `api_token` + `fuz_forge_api_token_policy` rows in one tx.

use std::collections::BTreeSet;
use std::sync::Arc;

use futures::future::BoxFuture;
use fuz_actions::ActionContext;
use fuz_auth::api_token::generate_api_token;
use fuz_auth::token_scope::TokenScopeDocument;
use fuz_forge_wire::output::{TokenCreateScopedOutput, TokenPolicyEntry, TokenPolicyListOutput};
use fuz_http::{
    JsonrpcError, internal_error, internal_error_with_source, invalid_params, parse_strict_params,
    parse_strict_params_allowing_null, validation_error,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::input_bounds::{require_len, require_nonempty_entries};
use super::to_value_out;
use crate::app::FuzForgeApp;
use crate::token_policy::{
    FuzForgeTokenPolicy, FuzForgeTokenTemplate, MAX_POLICY_BYTES, TemplateResources,
    policy_from_template,
};

// =============================================================================
//  fuz_forge_token_create_scoped / fuz_forge_token_policy_list
// =============================================================================

/// The context [`to_value_out`] names on a failed serialize.
const SERIALIZE_CONTEXT: &str = "fuz_forge_token: serialize output";

/// The `fuz_forge_token_create_scoped` keys the strict decode's `null` walk
/// skips: `lifetime`, whose every refusal — `null` included — is the spine
/// parser's (see [`parse_token_create_params`]). Not a nullable key: the twin
/// admits no `null` there either.
const TOKEN_CREATE_NULL_WALK_EXEMPT: &[&str] = &["lifetime"];

/// Mirrors `FuzForgeTokenCreateScopedInput` in `action_specs.ts`.
///
/// `lifetime` is parsed off the raw params by the spine
/// (`fuz_auth::account_action_specs::parse_token_lifetime_param`) after this
/// struct is built, and `acting` by the dispatcher; both are declared here so
/// `deny_unknown_fields` admits the keys the wire actually carries.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenCreateInput {
    name: String,
    template: TokenTemplateInput,
    #[serde(default)]
    #[expect(dead_code, reason = "parsed off the raw params by the spine")]
    lifetime: Option<Value>,
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

/// Mirrors `fuz_forge_token_policy_list`'s input — `acting` only, and
/// `with_default_fn` supplies `{}` when params are absent. Carries no field the
/// handler reads; it exists so an unknown key is the same `-32602` the TS strict `object`
/// produces.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenPolicyListInput {
    #[serde(default, deserialize_with = "fuz_http::deserialize_optional_wire_uuid")]
    #[expect(dead_code, reason = "resolved by the dispatcher, not the handler")]
    acting: Option<Uuid>,
}

/// Wire shape for `fuz_forge_token_create_scoped`'s `template` field — the
/// `FuzForgeTokenTemplateInput` discriminated union declared in
/// `action_specs.ts` (`repo_ids` for forge templates, `filenames` for file
/// templates, `methods` for `rpc_subset`). Maps to [`FuzForgeTokenTemplate`]
/// via [`TokenTemplateInput::into_template`], then [`policy_from_template`]
/// derives the policy doc — the same grammar the TS handler honors.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum TokenTemplateInput {
    /// Spelled as a **fieldless struct variant**, not a unit variant:
    /// `deny_unknown_fields` on an internally-tagged enum is applied by each
    /// arm's own deserializer, and a unit variant has none — it accepts the
    /// tag and discards the rest of the object. `{"kind":"admin",
    /// "filenames":["a.txt"]}` would then mint a **full-admin** token from a
    /// body the TS `object({kind: literal('admin')})` answers with
    /// `-32602`. The empty braces are what makes the attribute reach this arm.
    Admin {},
    ForgePush {
        repo_ids: Vec<String>,
    },
    ForgePull {
        repo_ids: Vec<String>,
    },
    FilesRead {
        filenames: TemplateResourcesInput,
    },
    FilesWrite {
        filenames: TemplateResourcesInput,
    },
    FilesReadWrite {
        filenames: TemplateResourcesInput,
    },
    RpcSubset {
        methods: Vec<String>,
    },
}

/// Wire shape for a template's resource set: the `'*'` literal or an explicit
/// id list (`FuzForgeTokenTemplateInput`'s `'*' | string[]`). Converts to
/// [`TemplateResources`]; a bare string that isn't `'*'` is rejected.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TemplateResourcesInput {
    Wildcard(String),
    List(Vec<String>),
}

impl TemplateResourcesInput {
    /// The TS twin is `union([literal('*'), pipe(array(pipe(string,
    /// min_length(1))), min_length(1), max_length(256))])`, so an explicit list
    /// is held to 1..=256 non-empty entries here.
    fn into_resources(self) -> Result<TemplateResources, JsonrpcError> {
        match self {
            Self::Wildcard(s) if s == "*" => Ok(TemplateResources::All),
            // `-32602`, not `validation_error`: the TS twin is a
            // `union([literal('*'), pipe(array(...), ...)])` inside the input
            // schema, so a bare string that isn't `"*"` fails at dispatch.
            Self::Wildcard(s) => Err(invalid_params(
                &format!("invalid params: filenames must be \"*\" or a string list, got {s:?}"),
                None,
            )),
            Self::List(ids) => {
                require_nonempty_entries("filenames", &ids, 1, 256)?;
                Ok(TemplateResources::List(ids))
            }
        }
    }
}

/// Reject repo ids that are not repo cell-id UUIDs.
///
/// The git gate checks `forge.push:<repo cell id>`, so a **slug** here produces
/// a policy that can never match — and that failure is invisible by
/// construction, since git smart-HTTP answers every refusal with one generic
/// 401. The token would look minted and simply never authorize anything, with
/// no way for the operator to tell why. Mint is the only point where the mistake
/// can still be reported.
///
/// Twin of the `FuzForgeTokenTemplateRepoIds` schema in `action_specs.ts`
/// (`pipe(array(RepoId), min_length(1), max_length(64))`), which the TS dispatcher enforces before
/// the handler runs — so the grammar is [`fuz_forge_wire::is_valid_repo_id`]
/// (the `RepoId` twin, shared with the repo RPCs' id ingress), the list bounds
/// are mirrored here, and the envelope is `invalid_params` (-32602), the code
/// a TS dispatch-schema failure produces. **Not**
/// `fuz_forge_wire::looks_like_uuid`, which is a slug-vs-id *disambiguator*
/// for the CLI's `<id-or-slug>` argument rather than a validator.
///
/// Returns the ids lowercased, as `RepoId` outputs them: they become the
/// policy's map keys, matched against the cell id's lowercase rendering, so an
/// id minted in uppercase would otherwise be the same silent never-match.
fn validate_repo_ids(repo_ids: Vec<String>) -> Result<Vec<String>, JsonrpcError> {
    if repo_ids.is_empty() || repo_ids.len() > 64 {
        return Err(invalid_params(
            &format!(
                "invalid repo_ids: expected 1-64 entries, got {}",
                repo_ids.len()
            ),
            None,
        ));
    }
    for id in &repo_ids {
        if !fuz_forge_wire::is_valid_repo_id(id) {
            return Err(invalid_params(
                &format!("invalid repo id {id:?}: repo_ids must be repo cell-id UUIDs, not slugs"),
                None,
            ));
        }
    }
    Ok(repo_ids
        .into_iter()
        .map(|id| id.to_ascii_lowercase())
        .collect())
}

impl TokenTemplateInput {
    /// The `kind` discriminant, stored in `fuz_forge_api_token_policy.template`.
    const fn kind_str(&self) -> &'static str {
        match self {
            Self::Admin {} => "admin",
            Self::ForgePush { .. } => "forge_push",
            Self::ForgePull { .. } => "forge_pull",
            Self::FilesRead { .. } => "files_read",
            Self::FilesWrite { .. } => "files_write",
            Self::FilesReadWrite { .. } => "files_read_write",
            Self::RpcSubset { .. } => "rpc_subset",
        }
    }

    /// Map the wire input into the [`FuzForgeTokenTemplate`] grammar enum.
    fn into_template(self) -> Result<FuzForgeTokenTemplate, JsonrpcError> {
        Ok(match self {
            Self::Admin {} => FuzForgeTokenTemplate::Admin,
            Self::ForgePush { repo_ids } => FuzForgeTokenTemplate::ForgePush(
                TemplateResources::List(validate_repo_ids(repo_ids)?),
            ),
            Self::ForgePull { repo_ids } => FuzForgeTokenTemplate::ForgePull(
                TemplateResources::List(validate_repo_ids(repo_ids)?),
            ),
            Self::FilesRead { filenames } => {
                FuzForgeTokenTemplate::FilesRead(filenames.into_resources()?)
            }
            Self::FilesWrite { filenames } => {
                FuzForgeTokenTemplate::FilesWrite(filenames.into_resources()?)
            }
            Self::FilesReadWrite { filenames } => {
                FuzForgeTokenTemplate::FilesReadWrite(filenames.into_resources()?)
            }
            Self::RpcSubset { methods } => {
                // 1..=64 non-empty entries, as the TS twin's — an empty list
                // would mint a token that grants nothing but reads as scoped.
                require_nonempty_entries("methods", &methods, 1, 64)?;
                FuzForgeTokenTemplate::RpcSubset(TemplateResources::List(methods))
            }
        })
    }
}

/// The spine-level scope a template implies, the twin of the TS mint's
/// `token_scope` ternary in `src/lib/server/routes/fuz_forge_token.ts`.
///
/// Two records govern a forge token and they are not redundant: the spine's
/// `api_token.scope` covers RPC methods and the non-RPC *spine* surfaces
/// (db-admin, bare-fact, audit stream, WS), while the
/// `fuz_forge_api_token_policy` row covers forge's own resource-bound REST
/// surfaces (`files.read:<filename>`, `forge.push:<repo_id>`), which the spine
/// has no vocabulary for.
///
/// The mapping is mechanical, and the file/forge templates land on an **empty**
/// method set on purpose: those tokens grant no RPC, and this empty set is the
/// **only** thing that denies it. The policy row does not — its `rpc` grant is
/// a mint-time record with no checker ([`crate::token_policy`]), so a file token
/// whose scope came back `full` would call every method on the server with
/// nothing else in the way. It also means rule 3 keeps these tokens out of the
/// db-admin browser, which their old unscoped `api_token` row did not.
///
/// Split out of the handler so it can be asserted directly. Which of the two
/// records governs a forge surface ([`crate::token_surfaces`]) is argued
/// entirely from what this function returns — a template that silently started
/// yielding [`TokenScopeDocument::full`] would leave every one of those
/// arguments reading correctly while a scoped token walked into the db-admin
/// browser.
fn token_scope_for_template(template: &TokenTemplateInput) -> TokenScopeDocument {
    match template {
        TokenTemplateInput::Admin {} => TokenScopeDocument::full(),
        TokenTemplateInput::RpcSubset { methods } => {
            TokenScopeDocument::methods(methods.iter().cloned().collect())
        }
        TokenTemplateInput::ForgePush { .. }
        | TokenTemplateInput::ForgePull { .. }
        | TokenTemplateInput::FilesRead { .. }
        | TokenTemplateInput::FilesWrite { .. }
        | TokenTemplateInput::FilesReadWrite { .. } => TokenScopeDocument::methods(BTreeSet::new()),
    }
}

/// Parse `fuz_forge_token_create_scoped`'s params into the decoded input and
/// the lifetime (`None` = deliberately eternal, `Some(days)` = bounded TTL).
///
/// `lifetime` is required and parsed off the raw params by the spine's own
/// parser (`fuz_auth::account_action_specs::parse_token_lifetime_param`), so
/// this inlined mint can't drift from `account_token_create`'s input shape.
/// Every refusal of it — absent, `null`, a non-object, a bad `kind` or `days` —
/// carries `token_lifetime_invalid`, the reason the twin declares on the field:
/// the strict decode's `null` walk skips `lifetime` (it would answer a `null`
/// with no reason) and leaves it to that parser. The decode and the `name`
/// bounds still run first, the twin's `object` shape order, so a
/// decode fault or a `name` fault answers ahead of one in `lifetime`; the
/// `template` bounds run later, in the handler, so a body faulting both
/// `template` and `lifetime` answers the lifetime reason where the twin answers
/// none — the declared reason is defined for a single-fault body only. The
/// clone is the price of reading `lifetime` off the raw params after the decode
/// consumed them; the body is a mint payload, bounded by the request cap.
///
/// # Errors
///
/// `-32602` for any input-shape refusal; one in `lifetime` carries
/// `token_lifetime_invalid`, the rest no reason.
fn parse_token_create_params(
    params: &Value,
) -> Result<(TokenCreateInput, Option<u32>), JsonrpcError> {
    let input: TokenCreateInput =
        parse_strict_params_allowing_null(params.clone(), TOKEN_CREATE_NULL_WALK_EXEMPT)?;
    require_len("name", &input.name, 1, 80)?;
    let ttl_days = fuz_auth::account_action_specs::parse_token_lifetime_param(params)?;
    Ok((input, ttl_days))
}

pub fn fuz_forge_token_create_scoped(
    _app: Arc<FuzForgeApp>,
    params: Value,
    ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        let (input, ttl_days) = parse_token_create_params(&params)?;
        let expires_at = ttl_days.map(|days| {
            std::time::SystemTime::now() + std::time::Duration::from_secs(u64::from(days) * 86_400)
        });
        let template_kind = input.template.kind_str().to_owned();

        let token_scope = token_scope_for_template(&input.template);
        let token_scope_json = token_scope.to_json().map_err(|e| {
            internal_error_with_source("fuz_forge_token_create_scoped: scope json", &e)
        })?;

        // Derive the policy doc from the template grammar via the same
        // `policy_from_template` the TS handler runs. `admin` is unscoped
        // (`None`, no policy row); every other kind maps its resource
        // selector (`repo_ids` / `filenames` / `methods`) into the
        // allow-keyed policy. Mirrors `fuz_forge_token_policy.ts`.
        let policy_doc: Option<FuzForgeTokenPolicy> =
            policy_from_template(&input.template.into_template()?);

        if let Some(ref policy) = policy_doc {
            let serialized = serde_json::to_vec(policy).map_err(|e| {
                internal_error_with_source("fuz_forge_token_create_scoped: serialize", &e)
            })?;
            if serialized.len() > MAX_POLICY_BYTES {
                return Err(validation_error(&format!(
                    "policy too large: {} bytes exceeds {}",
                    serialized.len(),
                    MAX_POLICY_BYTES
                )));
            }
        }

        // Session-admin auth means ctx.auth is Some.
        let Some(auth) = ctx.auth.actor() else {
            return Err(internal_error(
                "fuz_forge_token_create_scoped: missing auth",
            ));
        };
        let account_id: Uuid = auth.account.id;

        // Generate the api_token + hash via fuz_auth.
        let generated = generate_api_token();

        // Insert api_token row + fuz_forge_api_token_policy row in the same
        // tx (ctx.db is a Tx because the spec is `side_effects: true`).
        // TODO: swap the inlined INSERT to `fuz_auth::query_create_api_token`,
        // run over `ctx.db` with `fuz_db::action_db_dispatch!`.
        ctx.db
            .execute(
                // `$5::text::jsonb` for the same reason as the policy insert
                // below: a bare `::jsonb` makes Postgres infer the parameter as
                // jsonb, which tokio-postgres can't serialize a `String` into.
                "INSERT INTO api_token (id, account_id, name, token_hash, scope, expires_at) \
                 VALUES ($1, $2, $3, $4, $5::text::jsonb, $6)",
                &[
                    &generated.id,
                    &account_id,
                    &input.name,
                    &generated.token_hash,
                    &token_scope_json,
                    &expires_at,
                ],
            )
            .await
            .map_err(|e| {
                internal_error_with_source("fuz_forge_token_create_scoped: api_token", &e)
            })?;

        if let Some(policy) = &policy_doc {
            let policy_text = serde_json::to_string(policy).map_err(|e| {
                internal_error_with_source("fuz_forge_token_create_scoped: policy json", &e)
            })?;
            ctx.db
                .execute(
                    // `$2::text::jsonb`, not `$2::jsonb`: a bare `::jsonb` cast
                    // makes Postgres infer the bound parameter's type as `jsonb`,
                    // and tokio-postgres can't serialize a Rust `String` into a
                    // jsonb parameter (`error serializing parameter 1`). The
                    // double cast keeps the parameter `text` (which `String`
                    // serializes to) and casts text→jsonb server-side — the same
                    // idiom the spine audit-log insert uses.
                    "INSERT INTO fuz_forge_api_token_policy \
                       (api_token_id, policy, policy_version, template) \
                     VALUES ($1, $2::text::jsonb, $3, $4)",
                    &[
                        &generated.id,
                        &policy_text,
                        &policy.version.number(),
                        &template_kind,
                    ],
                )
                .await
                .map_err(|e| {
                    internal_error_with_source("fuz_forge_token_create_scoped: policy", &e)
                })?;
        }

        to_value_out(
            &TokenCreateScopedOutput {
                ok: true,
                token: generated.token,
                id: generated.id,
                name: input.name,
                template: template_kind,
            },
            SERIALIZE_CONTEXT,
        )
    })
}

pub fn fuz_forge_token_policy_list(
    _app: Arc<FuzForgeApp>,
    params: Value,
    ctx: ActionContext<'_>,
) -> BoxFuture<'_, Result<Value, JsonrpcError>> {
    Box::pin(async move {
        // Absent params reach here as `Value::Null`, which `parse_params`
        // maps to `{}` — the twin of the TS dispatcher's `raw_params ?? {}`
        // against the spec's `with_default_fn`. Every field is dispatcher-owned,
        // so the parse is a shape check only.
        let _input: TokenPolicyListInput = parse_strict_params(params)?;
        let Some(auth) = ctx.auth.actor() else {
            return Err(internal_error("fuz_forge_token_policy_list: missing auth"));
        };
        let account_id: Uuid = auth.account.id;
        let rows = ctx
            .db
            .query(
                "SELECT p.api_token_id, p.template \
                 FROM fuz_forge_api_token_policy p \
                 JOIN api_token t ON t.id = p.api_token_id \
                 WHERE t.account_id = $1 \
                 ORDER BY t.created_at",
                &[&account_id],
            )
            .await
            .map_err(|e| internal_error_with_source("fuz_forge_token_policy_list: query", &e))?;
        let policies: Vec<TokenPolicyEntry> = rows
            .into_iter()
            .map(|row| TokenPolicyEntry {
                api_token_id: row.get::<_, String>(0),
                template: row.get::<_, String>(1),
            })
            .collect();
        to_value_out(&TokenPolicyListOutput { policies }, SERIALIZE_CONTEXT)
    })
}

#[cfg(test)]
mod tests {
    //! Twin of the `the mint stamps the spine scope each template implies` case
    //! in `src/test/server/routes/fuz_forge_token_create_scoped_rpc.db.test.ts`,
    //! which asserts the same mapping through a real mint + DB read-back.
    //!
    //! Here it is a direct call, because this backend has no in-process route
    //! harness — its only route-level coverage is the cross-backend suite, which
    //! is gated behind `FUZ_TEST_CROSS_BACKEND=1`. Asserting the pure function
    //! puts the premise in `cargo test --workspace`.

    use std::collections::BTreeSet;

    use fuz_auth::token_scope::{TokenScope, TokenScopeDocument};
    use fuz_http::{JsonrpcError, JsonrpcErrorCode, parse_strict_params};

    use fuz_auth::account_action_specs::ERROR_TOKEN_LIFETIME_INVALID;

    use super::{
        TemplateResourcesInput, TokenTemplateInput, parse_token_create_params,
        policy_from_template, token_scope_for_template,
    };
    use crate::token_policy::{FuzForgeTokenTemplate, ResourceMap, TemplateResources};

    const REPO_UUID: &str = "3f8a1c2e-1234-4abc-9def-0123456789ab";

    /// Every input-shape refusal here is the `-32602` a TS dispatch-schema
    /// failure produces — never a `validation_error` (422) or a 404.
    fn assert_invalid_params(err: &JsonrpcError) {
        assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
    }

    /// The refusal's `data.reason`, if any.
    fn reason(err: &JsonrpcError) -> Option<&str> {
        err.data.as_ref()?.get("reason")?.as_str()
    }

    /// The twin declares `invalid_reason: token_lifetime_invalid` on
    /// `lifetime`, so its schema answers that reason on every refusal of the
    /// field — absent, `null`, a non-object, a bad `kind`, an out-of-range
    /// `days`. The strict decode's `null` walk would answer a `null` with no
    /// reason, so the mint's parse exempts `lifetime` from it.
    #[test]
    fn lifetime_refusals_carry_the_declared_reason() {
        let base = || serde_json::json!({"name": "probe", "template": {"kind": "admin"}});
        let mut cases = vec![base()];
        for lifetime in [
            serde_json::Value::Null,
            serde_json::json!(42),
            serde_json::json!("eternal"),
            serde_json::json!([]),
            serde_json::json!({"kind": "forever"}),
            serde_json::json!({"kind": "ttl", "days": 0}),
            serde_json::json!({"kind": "eternal", "days": 1}),
        ] {
            let mut params = base();
            params["lifetime"] = lifetime;
            cases.push(params);
        }
        for params in cases {
            let err =
                parse_token_create_params(&params).expect_err(&format!("{params} must be refused"));
            assert_invalid_params(&err);
            assert_eq!(reason(&err), Some(ERROR_TOKEN_LIFETIME_INVALID), "{params}");
        }
        let (_, ttl_days) = parse_token_create_params(&serde_json::json!({
            "name": "probe",
            "template": {"kind": "admin"},
            "lifetime": {"kind": "ttl", "days": 7},
        }))
        .unwrap();
        assert_eq!(ttl_days, Some(7));
    }

    /// The twin's `object` reports its first issue in shape order —
    /// `name`, `template`, then `lifetime` — so a body faulty in an earlier
    /// field and in `lifetime` answers the earlier field's refusal, which
    /// declares no reason. An unknown key is a whole-input fault, no reason.
    #[test]
    fn earlier_field_faults_answer_ahead_of_lifetime() {
        for params in [
            serde_json::json!({"name": null, "template": {"kind": "admin"}, "lifetime": null}),
            serde_json::json!({"name": 42, "template": {"kind": "admin"}}),
            serde_json::json!({"name": "", "template": {"kind": "admin"}, "lifetime": null}),
            serde_json::json!({"name": "probe", "template": {"kind": "nope"}, "lifetime": null}),
            serde_json::json!({"name": "probe", "lifetime": {"kind": "eternal"}}),
            serde_json::json!({
                "name": "probe",
                "template": {"kind": "admin"},
                "lifetime": {"kind": "eternal"},
                "nope": 1,
            }),
        ] {
            let err =
                parse_token_create_params(&params).expect_err(&format!("{params} must be refused"));
            assert_invalid_params(&err);
            assert_eq!(reason(&err), None, "{params}");
        }
    }

    /// A slug where a repo cell id belongs mints a policy that can never match,
    /// and git's generic-401 posture means the operator never finds out. Mint is
    /// the last point it can be reported.
    ///
    /// The envelope is pinned to `-32602` (`InvalidParams`): the TS twin
    /// rejects these at dispatch via `pipe(array(RepoId), min_length(1), max_length(64))`, and the
    /// cross-backend rejection suite (`repo_id_grammar.cross.test.ts`) asserts
    /// the same code from both backends.
    /// `deny_unknown_fields` is the strict `object` twin, and on the
    /// internally-tagged template union each **arm** applies it with its own
    /// deserializer (the `kind` tag is consumed before the arm, so an arm still
    /// admits its own discriminant). That is exactly why `admin` is spelled as
    /// the fieldless struct variant `Admin {}` — a unit variant has no
    /// deserializer for the attribute to reach, so it would swallow every extra
    /// key and mint a full-admin token from a body the TS schema refuses. The
    /// loop below pins every arm, `admin` first. `lifetime` and `acting` are
    /// declared because the wire carries them — they are read by the spine and
    /// the dispatcher, not here.
    #[test]
    fn token_create_input_is_strict_but_admits_the_keys_the_wire_carries() {
        let ok = serde_json::json!({
            "name": "probe",
            "template": {"kind": "admin"},
            "lifetime": {"kind": "eternal"},
            "acting": REPO_UUID,
        });
        assert!(parse_strict_params::<super::TokenCreateInput>(ok).is_ok());

        let unknown_top_level = serde_json::json!({
            "name": "probe",
            "template": {"kind": "admin"},
            "nope": 1,
        });
        assert_invalid_params(
            &parse_strict_params::<super::TokenCreateInput>(unknown_top_level).unwrap_err(),
        );

        for template in [
            // The `admin` arm carries no field at all, so an extra key here is
            // the one that would otherwise mint full authority unnoticed.
            serde_json::json!({"kind": "admin", "filenames": ["a.txt"]}),
            serde_json::json!({"kind": "admin", "nope": 1}),
            serde_json::json!({"kind": "rpc_subset", "methods": ["cell_get"], "nope": 1}),
            serde_json::json!({"kind": "forge_push", "repo_ids": [REPO_UUID], "nope": 1}),
            serde_json::json!({"kind": "forge_pull", "repo_ids": [REPO_UUID], "nope": 1}),
            serde_json::json!({"kind": "files_read", "filenames": "*", "nope": 1}),
            serde_json::json!({"kind": "files_write", "filenames": "*", "nope": 1}),
            serde_json::json!({"kind": "files_read_write", "filenames": "*", "nope": 1}),
        ] {
            let params = serde_json::json!({"name": "probe", "template": template.clone()});
            assert_invalid_params(
                &parse_strict_params::<super::TokenCreateInput>(params)
                    .err()
                    .unwrap_or_else(|| panic!("{template} must be refused")),
            );
        }
    }

    /// `fuz_forge_token_policy_list` takes only `acting`, so an unknown key is
    /// the same `-32602` the TS strict `{acting}` object (default `{}`) gives.
    #[test]
    fn token_policy_list_input_is_strict() {
        assert!(
            parse_strict_params::<super::TokenPolicyListInput>(
                serde_json::json!({"acting": REPO_UUID})
            )
            .is_ok()
        );
        assert_invalid_params(
            &parse_strict_params::<super::TokenPolicyListInput>(serde_json::json!({"nope": 1}))
                .unwrap_err(),
        );
    }

    /// `null` on an optional key is `-32602` on the TS side; serde would read
    /// it as `None`. The strict decode walks for it ahead of the decode, so a
    /// `null` `acting` is refused with no reason, through the mint's own parse.
    /// (`lifetime` is the walk's one exemption — see
    /// `lifetime_refusals_carry_the_declared_reason`.)
    #[test]
    fn token_inputs_reject_a_null_on_an_optional_key() {
        let err = parse_token_create_params(&serde_json::json!({
            "name": "probe",
            "template": {"kind": "admin"},
            "lifetime": {"kind": "eternal"},
            "acting": null,
        }))
        .unwrap_err();
        assert_invalid_params(&err);
        assert_eq!(reason(&err), None);
        assert!(
            parse_strict_params::<super::TokenPolicyListInput>(
                serde_json::json!({"acting": REPO_UUID})
            )
            .is_ok()
        );
    }

    /// `fuz_forge_token_policy_list`'s input is `acting` and nothing else, so
    /// a `null` there is the whole payload — the shape a client most easily
    /// sends by serializing an unset selector, and `-32602` on both backends
    /// rather than the unscoped listing a `None` would produce.
    #[test]
    fn token_policy_list_input_refuses_a_null_acting() {
        assert_invalid_params(
            &parse_strict_params::<super::TokenPolicyListInput>(
                serde_json::json!({"acting": serde_json::Value::Null}),
            )
            .unwrap_err(),
        );
        // Absent is the no-selector call, and still reaches the handler.
        assert!(parse_strict_params::<super::TokenPolicyListInput>(serde_json::json!({})).is_ok());
    }

    /// `pipe(array(pipe(string, min_length(1))), min_length(1), max_length(64))`
    /// on `methods` — an empty
    /// list, a 65-entry list, and an empty entry are all schema failures on the
    /// TS side, so they are `-32602` here.
    #[test]
    fn rpc_subset_bounds_its_method_list() {
        for methods in [vec![], vec!["cell_get".to_owned(); 65], vec![String::new()]] {
            let err = TokenTemplateInput::RpcSubset { methods }
                .into_template()
                .expect_err("out-of-bounds methods must be refused at mint");
            assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
        }
        assert!(
            TokenTemplateInput::RpcSubset {
                methods: vec!["cell_get".to_owned()],
            }
            .into_template()
            .is_ok()
        );
    }

    /// `union([literal('*'), pipe(array(...), min_length(1), max_length(256))])`
    /// on `filenames` — the wildcard is unbounded, an explicit list is not.
    #[test]
    fn file_templates_bound_their_filename_list() {
        for filenames in [
            TemplateResourcesInput::List(vec![]),
            TemplateResourcesInput::List(vec!["a.txt".to_owned(); 257]),
            TemplateResourcesInput::List(vec![String::new()]),
        ] {
            let err = TokenTemplateInput::FilesRead { filenames }
                .into_template()
                .expect_err("out-of-bounds filenames must be refused at mint");
            assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
        }
        assert!(
            TokenTemplateInput::FilesRead {
                filenames: TemplateResourcesInput::List(vec!["a.txt".to_owned()]),
            }
            .into_template()
            .is_ok()
        );
        assert!(
            TokenTemplateInput::FilesRead {
                filenames: TemplateResourcesInput::Wildcard("*".to_owned()),
            }
            .into_template()
            .is_ok()
        );
    }

    /// A bare string that isn't `"*"` fails the TS `union([literal('*'),
    /// pipe(array(...), ...)])` **inside the input schema**, so it is `-32602` at
    /// dispatch — not the `validation_error` (-32005/422) a handler-side
    /// refusal would give.
    #[test]
    fn a_non_wildcard_bare_string_is_invalid_params_not_a_validation_error() {
        for selector in ["all", "", "**"] {
            let err = TokenTemplateInput::FilesRead {
                filenames: TemplateResourcesInput::Wildcard(selector.to_owned()),
            }
            .into_template()
            .expect_err("a non-wildcard bare string must be refused at mint");
            assert_invalid_params(&err);
        }
    }

    #[test]
    fn forge_templates_reject_a_slug_where_a_repo_id_belongs() {
        for template in [
            TokenTemplateInput::ForgePush {
                repo_ids: vec!["fuzdev/fuz_app".to_owned()],
            },
            TokenTemplateInput::ForgePull {
                repo_ids: vec!["fuz_app".to_owned()],
            },
        ] {
            let err = template
                .into_template()
                .expect_err("a slug must be refused at mint");
            assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
        }
    }

    /// The wire grammar is the strict `RepoId` twin
    /// (`fuz_forge_wire::is_valid_repo_id`), not `Uuid::parse_str` — a
    /// version-0 near-nil id and a non-hyphenated spelling are refused like
    /// the TS dispatcher refuses them.
    #[test]
    fn forge_templates_reject_non_rfc_uuid_spellings() {
        for bad in [
            "00000000-0000-0000-0000-000000000001",
            "3f8a1c2e12344abc9def0123456789ab",
        ] {
            let template = TokenTemplateInput::ForgePush {
                repo_ids: vec![bad.to_owned()],
            };
            let err = template
                .into_template()
                .expect_err("a non-RepoId string must be refused at mint");
            assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
        }
    }

    /// The TS twin's list bounds (`.min(1).max(64)`) are mirrored: an empty
    /// list must not mint a token that grants nothing.
    #[test]
    fn forge_templates_reject_out_of_bounds_lists() {
        let empty = TokenTemplateInput::ForgePush { repo_ids: vec![] };
        let err = empty
            .into_template()
            .expect_err("an empty repo_ids list must be refused at mint");
        assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);

        let oversized = TokenTemplateInput::ForgePush {
            repo_ids: vec![REPO_UUID.to_owned(); 65],
        };
        let err = oversized
            .into_template()
            .expect_err("a 65-entry repo_ids list must be refused at mint");
        assert_eq!(err.code, JsonrpcErrorCode::InvalidParams);
    }

    /// One bad id in an otherwise-valid list fails the whole mint — a partially
    /// applied policy is the shape that silently half-works.
    #[test]
    fn forge_templates_reject_a_mixed_list() {
        let template = TokenTemplateInput::ForgePush {
            repo_ids: vec![REPO_UUID.to_owned(), "fuz_app".to_owned()],
        };
        assert!(template.into_template().is_err());
    }

    /// Ids are canonicalized to lowercase at mint, like the TS `RepoId`, so an
    /// uppercase spelling still matches the cell id the git gate checks.
    #[test]
    fn forge_templates_lowercase_repo_ids() {
        let template = TokenTemplateInput::ForgePull {
            repo_ids: vec![REPO_UUID.to_ascii_uppercase()],
        };
        assert_eq!(
            template
                .into_template()
                .expect("an uppercase repo id is valid"),
            FuzForgeTokenTemplate::ForgePull(TemplateResources::List(vec![REPO_UUID.to_owned()])),
        );
    }

    #[test]
    fn forge_templates_accept_repo_cell_ids() {
        let template = TokenTemplateInput::ForgePush {
            repo_ids: vec![REPO_UUID.to_owned()],
        };
        assert!(template.into_template().is_ok());
    }

    fn method_set(scope: &TokenScopeDocument) -> BTreeSet<String> {
        match scope.to_scope() {
            TokenScope::Methods(m) => m,
            TokenScope::Full => panic!("expected a narrowed scope"),
        }
    }

    fn is_full(scope: &TokenScopeDocument) -> bool {
        matches!(scope.to_scope(), TokenScope::Full)
    }

    /// `admin` is the one template meaning full authority — it writes no policy
    /// row, so the scope is the only thing governing it.
    #[test]
    fn admin_mints_a_full_scope() {
        assert!(is_full(&token_scope_for_template(
            &TokenTemplateInput::Admin {}
        )));
    }

    /// `rpc_subset` is the one template that grants RPC, so it is the one whose
    /// method list is non-empty.
    #[test]
    fn rpc_subset_mints_its_method_list() {
        let scope = token_scope_for_template(&TokenTemplateInput::RpcSubset {
            methods: vec!["fuz_forge_repo_list".to_owned()],
        });
        assert_eq!(
            method_set(&scope),
            BTreeSet::from(["fuz_forge_repo_list".to_owned()])
        );
    }

    /// The load-bearing case. These templates grant no RPC at all, so
    /// `Methods(∅)` is the honest encoding — and it is what makes them RPC-inert
    /// while their policy row keeps them working on the surfaces they were
    /// minted for.
    #[test]
    fn resource_templates_mint_an_rpc_inert_scope() {
        // Constructed inline rather than from a shared value: the wire input
        // types are deliberately not `Clone` (they are consumed by
        // `into_template`), and deriving it for a test would widen a production
        // type for the test's convenience.
        let wildcard = || TemplateResourcesInput::Wildcard("*".to_owned());
        let templates = [
            TokenTemplateInput::ForgePush {
                repo_ids: vec!["fuz_app".to_owned()],
            },
            TokenTemplateInput::ForgePull {
                repo_ids: vec!["fuz_app".to_owned()],
            },
            TokenTemplateInput::FilesRead {
                filenames: wildcard(),
            },
            TokenTemplateInput::FilesWrite {
                filenames: wildcard(),
            },
            TokenTemplateInput::FilesReadWrite {
                filenames: wildcard(),
            },
        ];
        for template in &templates {
            assert!(
                method_set(&token_scope_for_template(template)).is_empty(),
                "{template:?} must mint an RPC-inert scope",
            );
        }
    }

    /// The two records a mint writes agree about RPC.
    ///
    /// `policy_from_template` writes the policy row, `token_scope_for_template`
    /// writes the spine scope, and each is pinned by its own case above — so an
    /// edit to either one leaves both green while the row advertises a method
    /// set the scope refuses. Nothing else reads them together: they are
    /// consulted by different code, in different crates, at different layers.
    ///
    /// Two claims, and the first is the load-bearing one:
    ///
    /// - A `full` scope may only come from the template that writes **no**
    ///   policy row. Which axis governs a forge surface is decided by
    ///   `token_scope_admits_forge_surface` as `policy.is_some() ||
    ///   scope.admits_non_rpc_surface()`, so a template minting both would be a
    ///   token that passes on either axis and is narrowed by neither.
    /// - Otherwise the `rpc` grant the row records names exactly the methods the
    ///   scope admits — because the row is what an operator reads back to see
    ///   what a token was minted for, and the scope is what actually answers.
    #[test]
    fn the_two_records_a_mint_writes_agree_on_rpc() {
        let wildcard = || TemplateResourcesInput::Wildcard("*".to_owned());
        let inputs = [
            TokenTemplateInput::Admin {},
            TokenTemplateInput::RpcSubset {
                methods: vec!["fuz_forge_repo_list".to_owned(), "cell_get".to_owned()],
            },
            TokenTemplateInput::ForgePush {
                repo_ids: vec![REPO_UUID.to_owned()],
            },
            TokenTemplateInput::ForgePull {
                repo_ids: vec![REPO_UUID.to_owned()],
            },
            TokenTemplateInput::FilesRead {
                filenames: wildcard(),
            },
            TokenTemplateInput::FilesWrite {
                filenames: wildcard(),
            },
            TokenTemplateInput::FilesReadWrite {
                filenames: wildcard(),
            },
        ];
        for input in inputs {
            let kind = input.kind_str();
            let scope = token_scope_for_template(&input);
            let policy = policy_from_template(&input.into_template().expect("template maps"));

            if matches!(scope.to_scope(), TokenScope::Full) {
                assert!(
                    policy.is_none(),
                    "{kind} mints a full scope *and* a policy row — the token would pass \
                     `token_scope_admits_forge_surface` on either axis and be narrowed by neither",
                );
                continue;
            }

            let recorded: BTreeSet<String> = match policy.as_ref().and_then(|p| p.rpc.as_ref()) {
                None => BTreeSet::new(),
                Some(ResourceMap::Map(m)) => m.keys().cloned().collect(),
                // The wire's `methods` is a plain list, so no mint can produce
                // one; a row carrying it means the two records stopped being
                // derived from the same template.
                Some(ResourceMap::Wildcard(_)) => {
                    panic!("{kind} recorded an rpc wildcard the wire cannot express")
                }
            };
            assert_eq!(
                method_set(&scope),
                recorded,
                "{kind}: the policy row's `rpc` grant and the spine scope name different methods",
            );
        }
    }
}
