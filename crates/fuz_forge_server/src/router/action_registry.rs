//! The forge's action registry — the one route-state input the spine's
//! builders (`fuz_actions::server::AppBackend`'s `*_route_state`) can't
//! provide, since which specs mount is the forge's own.

use std::sync::Arc;

use fuz_actions::server::{StartupError, compile_action_registry};
use fuz_actions::{ActionRegistry, PROTOCOL_ACTION_SPECS};

use crate::app::FuzForgeApp;
use crate::runtime::{ExtraActionSpecsFactory, FinalActionSpecsFactory};

pub(super) fn build_action_registry(
    app: &FuzForgeApp,
    extra_action_specs_factory: Option<ExtraActionSpecsFactory>,
    final_action_specs_factory: Option<FinalActionSpecsFactory>,
) -> Result<Arc<ActionRegistry>, StartupError> {
    let mut specs: Vec<fuz_actions::ActionSpec> = Vec::new();

    // Protocol actions (heartbeat + peer/ping). `cancel` is not among them —
    // it is a WS notification the read loop owns, never a dispatched method.
    // This one registry serves both transports, so `heartbeat` carries the
    // spine's `ws_only` marker and `rpc_dispatch` refuses it over HTTP with
    // `method_not_found`; `peer/ping` does not, so an HTTP call reaches the
    // handler and refuses with `peer_no_transport`.
    specs.extend(PROTOCOL_ACTION_SPECS());

    // Full auth surface from the spine: account self-service + admin +
    // role-grant-offer (consent flow). `build_auth_spec_set` concatenates all
    // three, matching the TS forge's `create_standard_rpc_actions` (admin +
    // role-grant-offer + account) — the dual-impl parity contract requires
    // both backends expose the same action surface (the admin dashboard
    // surfaces role grants on both).
    //
    // Their rate-limit classes ride the specs, so the dispatcher's limiters
    // charge them alongside consumer-owned specs — one budget per account.
    specs.extend(app.backend.auth_spec_set(
        Arc::new(fuz_auth::AdminOfferAuthorize),
        Arc::new(fuz_auth::RoleRegistry::default()),
    ));

    // fuz_forge-specific specs (repo reads + subprocess wrappers + scoped
    // token CRUD).
    specs.extend(crate::actions::all(app));

    // Unified cell surface from the `fuz_cell_actions` spine crate — the full
    // verb set (CRUD + policy + grant ACL + field + item + audit). Twin-impl with
    // the TS forge's `create_cell_actions` family; repos and the file store
    // are reflected as cells. `build_cell_spec_set` internally concatenates
    // the grant/field/item/audit verbs, so it's the single mount point —
    // calling the per-domain builders too would double-register (mirrors
    // `testing_spine_stub`).
    //
    // The builtin role registry (role-shaped `cell_grant`s validate against
    // it — an app role joins it if/when a forge cell-grant cross suite needs
    // one, mirroring the TS forge config), no data validator, and no grant
    // authorizers = open grant. The create authorizer reserves the kinds the
    // forge's own routes trust (`repo`, `file`) to the global admin, for
    // `cell_create` and `cell_clone` alike; it accepts no root `policy`, so
    // every policy write is still refused `cell_policy_unsupported`. Twin:
    // `cell_bundle.ts`.
    specs.extend(fuz_cell_actions::build_cell_spec_set(
        fuz_cell_actions::CellSpecSetOptions {
            create_authorizer: Some(Arc::new(
                crate::cell_create_authorize::ReservedKindCreateAuthorize,
            )),
            ..fuz_cell_actions::CellSpecSetOptions::default()
        },
    ));

    // Extra specs injection point — the test binary folds in `_testing_reset`
    // here via the factory, closing over `fuz_testing` types in its own
    // process so `fuz_forge_server` stays clean of the dep. Production: `None`.
    if let Some(factory) = extra_action_specs_factory {
        specs.extend(factory(
            Arc::new(app.clone()),
            app.backend.extra_action_specs_runtime(),
        )?);
    }

    // Last-position injection point — the test binary builds
    // `_testing_action_manifest` here, over the assembled list, so the manifest
    // enumerates every method mounted above it (the twin of
    // `testing_spine_stub`'s inline `create_testing_action_manifest_action_spec(&specs)`
    // push and of the TS `create_testing_action_manifest_action(actions)` in
    // `build_rpc_endpoint_specs`). Production: `None`.
    if let Some(factory) = final_action_specs_factory {
        let final_specs = factory(&specs);
        specs.extend(final_specs);
    }

    // Fail loud: a compile error means duplicate / malformed method names, and
    // booting an empty registry would answer `method_not_found` to everything.
    compile_action_registry(specs)
}
