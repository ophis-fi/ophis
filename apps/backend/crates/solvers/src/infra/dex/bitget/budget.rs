use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

/// One persisted byte per attempted request, reserved before touching the API.
/// No automatic reset: increasing the cap requires an explicit config change.
pub struct Budget {
    state: Mutex<State>,
    limit: u64,
    interval: Duration,
}

struct State {
    // Held open and exclusively locked for the lifetime of this client.
    file: File,
    last_request: Instant,
}

impl Budget {
    pub fn open(path: &Path, limit: u64, interval: Duration) -> io::Result<Self> {
        // Missing state must fail closed, including after a lost volume. The
        // operator creates the empty journal once when provisioning the pilot.
        let file = OpenOptions::new().read(true).append(true).open(path)?;
        file.try_lock().map_err(io::Error::from)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("Bitget budget must be a regular file"));
        }
        Ok(Self {
            state: Mutex::new(State {
                file,
                // Also enforce a quiet interval after every restart.
                last_request: Instant::now(),
            }),
            limit,
            interval,
        })
    }

    /// Returns the total reserved requests, or None when capped/throttled.
    pub fn reserve(&self) -> io::Result<Option<u64>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("Bitget budget lock poisoned"))?;
        let used = state.file.metadata()?.len();
        if used >= self.limit || state.last_request.elapsed() < self.interval {
            return Ok(None);
        }
        // Count failures, cancellations and 429s too: their billing is unknown.
        // ponytail: synchronous fsync under one lock; suitable for the low-rate
        // pilot. Move to a blocking worker if measured latency warrants it.
        state.file.write_all(&[0])?;
        state.file.sync_all()?;
        state.last_request = Instant::now();
        Ok(Some(used + 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_survives_restarts_and_rejects_competing_clients() {
        let path = std::env::temp_dir().join(format!(
            "bitget-budget-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(Budget::open(&path, 2, Duration::ZERO).is_err());
        File::create_new(&path).unwrap();

        let paced = Budget::open(&path, 2, Duration::from_secs(10)).unwrap();
        assert_eq!(paced.reserve().unwrap(), None);
        paced.state.lock().unwrap().last_request = Instant::now() - Duration::from_secs(11);
        assert_eq!(paced.reserve().unwrap(), Some(1));
        assert_eq!(paced.reserve().unwrap(), None);
        assert!(Budget::open(&path, 2, Duration::ZERO).is_err());
        drop(paced);

        let budget = Budget::open(&path, 2, Duration::ZERO).unwrap();
        std::thread::scope(|scope| {
            let attempts: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| budget.reserve().unwrap().is_some()))
                .collect();
            assert_eq!(
                attempts
                    .into_iter()
                    .map(|a| a.join().unwrap())
                    .filter(|allowed| *allowed)
                    .count(),
                1
            );
        });
        drop(budget);
        let restarted = Budget::open(&path, 2, Duration::ZERO).unwrap();
        assert_eq!(restarted.reserve().unwrap(), None);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 2);
        drop(restarted);
        let disabled = Budget::open(&path, 0, Duration::ZERO).unwrap();
        assert_eq!(disabled.reserve().unwrap(), None);
        drop(disabled);
        std::fs::remove_file(path).unwrap();
    }
}
