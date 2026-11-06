/**
 * The known-divergence ledger for the forge's TS-vs-Rust differential
 * (`differential.cross.test.ts`).
 *
 * An entry is a tracked, accepted difference between the Deno and Rust
 * forges' normalized responses to the same conformance case, naming the
 * paths it differs at (`KnownDivergence`). The differential asserts each
 * entry still differs there and nowhere else, and turns red when it closes,
 * so an entry is deleted as soon as the backends converge. Nothing goes here
 * without a tracking id and a reason the difference is accepted rather than
 * fixed — a divergence the forge can close is fixed on the wrong side, not
 * recorded. An empty list means the backends answer every row of its leg
 * alike.
 *
 * @module
 */

import type { KnownDivergence } from '@fuzdev/fuz_app/testing/cross_backend/differential.ts';

/** Divergences the HTTP legs show, the hand-written cases' leg included. */
export const differential_known_divergences: ReadonlyArray<KnownDivergence> = [];

/** Divergences the WS leg shows. */
export const differential_ws_known_divergences: ReadonlyArray<KnownDivergence> = [];
