//! Forge fact-store handle — a thin wrapper over the shared `fuz_fact` crate.
//!
//! The streaming PG-backed `FactStore`, the `<shard>/<rest>` disk CAS, and the
//! orphan-temp sweeper all live in `fuz_fact`. This module keeps only the
//! forge's composition-root handle ([`FactStoreHandle`]) and re-exports the
//! `fuz_fact` types the file store uses, so the rest of the forge reaches
//! them as `crate::fact_store::…`.

use std::path::PathBuf;
use std::sync::Arc;

use deadpool_postgres::Pool;

pub use fuz_fact::{FactContent, FactStore, PutOptions, PutStreamOutcome};

/// The active `FactStore` impl behind the forge's composition root.
pub type FactStoreHandleInner = Arc<dyn FactStore>;

/// Builder + wrapper around the active `FactStore`, so `FuzForgeApp` need not
/// name the concrete type and the impl can swap (PG-only, PG+disk, mock).
#[derive(Clone)]
pub struct FactStoreHandle {
    inner: FactStoreHandleInner,
}

impl std::fmt::Debug for FactStoreHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FactStoreHandle").finish_non_exhaustive()
    }
}

impl FactStoreHandle {
    /// Build a [`fuz_fact::PgFactStore`] over `pool`, with optional disk overflow
    /// at `disk_root` (the `<shard>/<rest>` CAS root). The embedded-vs-disk
    /// threshold stays the 1 MiB default.
    #[must_use]
    pub fn new(pool: Pool, disk_root: Option<PathBuf>) -> Self {
        let mut store = fuz_fact::PgFactStore::new(pool);
        if let Some(root) = disk_root {
            store = store.with_disk_root(root);
        }
        Self {
            inner: Arc::new(store),
        }
    }

    /// Borrow the active `FactStore` (consumed as `Arc<dyn FactStore>`).
    #[must_use]
    pub const fn inner(&self) -> &FactStoreHandleInner {
        &self.inner
    }
}
