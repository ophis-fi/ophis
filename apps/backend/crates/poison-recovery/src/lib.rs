//! Poison-recovery wrappers for `std::sync::Mutex` and `std::sync::RwLock`.
//!
//! Originally three near-identical helpers existed in `driver/competition`,
//! `driver/tokens`, and `solvers/fills` (PRs #99–#111). This crate
//! consolidates the pattern + sweeps the ~25 remaining production lock
//! sites flagged by sharp-edges in the PR-X review.
//!
//! ## Why
//!
//! `std::sync::Mutex` and `RwLock` poison when the lock-holding task
//! panics with an exclusive guard held. After poison every
//! `.lock()/.write().unwrap()` panics — permanently disabling the
//! protected code path until container restart. For best-effort caches
//! (balances, prices, in-flight requests, token metadata) that's a
//! strictly worse failure mode than "operate on a stale or empty cache."
//!
//! ## Variants
//!
//! - [`lock_or_recover`] — for `Mutex<T>`. Logs on poison, calls
//!   `clear_poison()` so subsequent acquisitions take the happy path,
//!   returns the recovered guard via `into_inner()`.
//! - [`read_or_recover`] — for `RwLock<T>` reads.
//! - [`write_or_recover`] — for `RwLock<T>` writes.
//! - [`write_or_recover_clear`] — for caches whose **partial mutation is
//!   dangerous** (e.g. balance maps where a half-updated state causes
//!   over-allocation downstream). Clears the inner before returning.
//! - [`lock_or_recover_clear`] — same as above but for `Mutex<T>` where
//!   the inner has a `Default` impl.
//!
//! Picking the right variant per site is a security decision: see PR-X
//! sharp-edges HIGH-2 for the canonical example (tokens::Metadata.balance
//! mid-mutation must clear; partial-fill amounts can keep stale state).
//!
//! After the first recovery `clear_poison()` resets the flag, so a single
//! poison event produces exactly one `tracing::error!` — no log-once
//! gate needed.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Acquire a `Mutex` lock, recovering from poison with a logged error.
pub fn lock_or_recover<'a, T>(m: &'a Mutex<T>, label: &'static str) -> MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|e| {
        tracing::error!(
            label,
            "Mutex was poisoned — recovering with possibly inconsistent state. \
             Investigate the originating panic in journald."
        );
        m.clear_poison();
        e.into_inner()
    })
}

/// Acquire a `RwLock` read guard, recovering from poison with a logged error.
///
/// Note: `RwLock` only poisons on writer panic; reader panics leave the
/// flag clean (shared guards can't violate invariants). This helper
/// exists for symmetry with [`write_or_recover`] and to handle the case
/// where a sibling task poisoned via a write before this reader arrived.
pub fn read_or_recover<'a, T>(rw: &'a RwLock<T>, label: &'static str) -> RwLockReadGuard<'a, T> {
    rw.read().unwrap_or_else(|e| {
        tracing::error!(
            label,
            "RwLock was poisoned (writer panicked) — recovering with possibly \
             inconsistent state for read. Investigate the originating panic in journald."
        );
        rw.clear_poison();
        e.into_inner()
    })
}

/// Acquire a `RwLock` write guard, recovering from poison with a logged error.
pub fn write_or_recover<'a, T>(rw: &'a RwLock<T>, label: &'static str) -> RwLockWriteGuard<'a, T> {
    rw.write().unwrap_or_else(|e| {
        tracing::error!(
            label,
            "RwLock was poisoned — recovering with possibly inconsistent state \
             for write. Investigate the originating panic in journald."
        );
        rw.clear_poison();
        e.into_inner()
    })
}

/// Acquire a `Mutex` lock and **reset the inner to `Default`** on poison.
/// Use for caches where a half-mutated inner is more dangerous than an
/// empty one (e.g. balance/price caches).
pub fn lock_or_recover_clear<'a, T: Default>(
    m: &'a Mutex<T>,
    label: &'static str,
) -> MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|e| {
        tracing::error!(
            label,
            "Mutex was poisoned — clearing inner (mid-mutation state may be \
             dangerous downstream) and recovering."
        );
        m.clear_poison();
        let mut guard = e.into_inner();
        *guard = T::default();
        guard
    })
}

/// Acquire a `RwLock` write guard and **reset the inner to `Default`** on poison.
pub fn write_or_recover_clear<'a, T: Default>(
    rw: &'a RwLock<T>,
    label: &'static str,
) -> RwLockWriteGuard<'a, T> {
    rw.write().unwrap_or_else(|e| {
        tracing::error!(
            label,
            "RwLock was poisoned — clearing inner (mid-mutation state may be \
             dangerous downstream) and recovering."
        );
        rw.clear_poison();
        let mut guard = e.into_inner();
        *guard = T::default();
        guard
    })
}

#[cfg(test)]
mod tests {
    use {super::*, std::panic::AssertUnwindSafe};

    #[test]
    fn lock_or_recover_handles_poison() {
        let m: Mutex<Vec<u8>> = Mutex::new(vec![1, 2, 3]);
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("poisoning");
        }));
        assert!(m.is_poisoned());
        let g = lock_or_recover(&m, "test");
        assert_eq!(*g, vec![1, 2, 3]); // preserved
        drop(g);
        assert!(!m.is_poisoned());
    }

    #[test]
    fn lock_or_recover_clear_resets_inner() {
        let m: Mutex<Vec<u8>> = Mutex::new(vec![1, 2, 3]);
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("poisoning");
        }));
        let g = lock_or_recover_clear(&m, "test");
        assert!(g.is_empty(), "must clear");
        drop(g);
        assert!(!m.is_poisoned());
    }

    #[test]
    fn write_or_recover_handles_poison() {
        let rw: RwLock<Vec<u8>> = RwLock::new(vec![9, 9, 9]);
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _g = rw.write().unwrap();
            panic!("poisoning");
        }));
        assert!(rw.is_poisoned());
        let g = write_or_recover(&rw, "test");
        assert_eq!(*g, vec![9, 9, 9]);
        drop(g);
        assert!(!rw.is_poisoned());
    }

    #[test]
    fn write_or_recover_clear_resets_inner() {
        let rw: RwLock<Vec<u8>> = RwLock::new(vec![9, 9, 9]);
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _g = rw.write().unwrap();
            panic!("poisoning");
        }));
        let g = write_or_recover_clear(&rw, "test");
        assert!(g.is_empty(), "must clear");
        drop(g);
        assert!(!rw.is_poisoned());
    }

    #[test]
    fn read_or_recover_handles_poison() {
        let rw: RwLock<Vec<u8>> = RwLock::new(vec![5, 5, 5]);
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let _g = rw.write().unwrap();
            panic!("poisoning");
        }));
        assert!(rw.is_poisoned());
        let g = read_or_recover(&rw, "test");
        assert_eq!(*g, vec![5, 5, 5]);
        drop(g);
        assert!(!rw.is_poisoned());
    }
}
