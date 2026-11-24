//! A small insertion-ordered cache with lazy TTL expiry.
//!
//! Reads refresh recency, and expired entries are removed during normal cache operations. No
//! timer runs, so an idle cache holds no background task.
//!
//! Entries live in a `Vec` ordered from least to most recently used. Every operation already
//! scans for expired entries, so a linear key lookup does not change the cost.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheConfigError {
    MaxEntries,
    TtlMs,
}

impl fmt::Display for CacheConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MaxEntries => f.write_str("maxEntries must be a positive integer"),
            Self::TtlMs => f.write_str("ttlMs must be positive and finite"),
        }
    }
}

impl std::error::Error for CacheConfigError {}

struct Entry<K, V> {
    key: K,
    value: V,
    expires_at: u64,
}

pub struct BoundedCache<K, V> {
    entries: Vec<Entry<K, V>>,
    max_entries: usize,
    ttl_ms: u64,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
}

fn system_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl<K: PartialEq, V> BoundedCache<K, V> {
    pub fn new(max_entries: usize, ttl_ms: u64) -> Result<Self, CacheConfigError> {
        Self::with_clock(max_entries, ttl_ms, system_now_ms)
    }

    /// Build a cache with an injected millisecond clock, so expiry is deterministic.
    pub fn with_clock(
        max_entries: usize,
        ttl_ms: u64,
        now: impl Fn() -> u64 + Send + Sync + 'static,
    ) -> Result<Self, CacheConfigError> {
        if max_entries < 1 {
            return Err(CacheConfigError::MaxEntries);
        }
        if ttl_ms == 0 {
            return Err(CacheConfigError::TtlMs);
        }
        Ok(Self {
            entries: Vec::new(),
            max_entries,
            ttl_ms,
            now: Box::new(now),
        })
    }

    fn position(&self, key: &K) -> Option<usize> {
        self.entries.iter().position(|entry| entry.key == *key)
    }

    fn prune_at(&mut self, now: u64) -> usize {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.expires_at > now);
        before - self.entries.len()
    }

    /// Move the entry at `index` to the most recently used end and return its new index.
    fn touch(&mut self, index: usize) -> usize {
        let entry = self.entries.remove(index);
        self.entries.push(entry);
        self.entries.len() - 1
    }

    pub fn get(&mut self, key: &K) -> Option<&V> {
        self.prune_at((self.now)());
        let index = self.position(key)?;
        let index = self.touch(index);
        Some(&self.entries[index].value)
    }

    pub fn set(&mut self, key: K, value: V) {
        let now = (self.now)();
        self.prune_at(now);
        if let Some(index) = self.position(&key) {
            self.entries.remove(index);
        }
        self.entries.push(Entry {
            key,
            value,
            expires_at: now + self.ttl_ms,
        });
        while self.entries.len() > self.max_entries {
            self.entries.remove(0);
        }
    }

    pub fn delete(&mut self, key: &K) -> bool {
        self.prune_at((self.now)());
        match self.position(key) {
            Some(index) => {
                self.entries.remove(index);
                true
            }
            None => false,
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Like `get`, a hit refreshes recency.
    pub fn has(&mut self, key: &K) -> bool {
        self.prune_at((self.now)());
        match self.position(key) {
            Some(index) => {
                self.touch(index);
                true
            }
            None => false,
        }
    }

    pub fn len(&mut self) -> usize {
        self.prune_at((self.now)());
        self.entries.len()
    }

    pub fn is_empty(&mut self) -> bool {
        self.len() == 0
    }

    /// Remove expired entries and return how many were removed.
    pub fn prune_expired(&mut self) -> usize {
        self.prune_at((self.now)())
    }

    /// Keys from least recently used to most recently used.
    pub fn keys(&mut self) -> impl Iterator<Item = &K> {
        self.prune_at((self.now)());
        self.entries.iter().map(|entry| &entry.key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn cache(max: usize, ttl: u64) -> (BoundedCache<&'static str, i32>, Arc<AtomicU64>) {
        let clock = Arc::new(AtomicU64::new(0));
        let handle = clock.clone();
        let cache =
            BoundedCache::with_clock(max, ttl, move || handle.load(Ordering::Relaxed)).unwrap();
        (cache, clock)
    }

    #[test]
    fn rejects_invalid_limits() {
        assert!(BoundedCache::<u8, u8>::new(0, 10).is_err());
        assert!(BoundedCache::<u8, u8>::new(1, 0).is_err());
    }

    #[test]
    fn reads_refresh_recency_before_eviction() {
        let (mut cache, _) = cache(2, 100);
        cache.set("a", 1);
        cache.set("b", 2);
        assert_eq!(cache.get(&"a"), Some(&1));
        cache.set("c", 3);
        assert_eq!(cache.keys().copied().collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!(cache.get(&"b"), None);
    }

    #[test]
    fn entries_expire_at_the_ttl_without_a_timer() {
        let (mut cache, clock) = cache(4, 100);
        cache.set("a", 1);
        clock.store(99, Ordering::Relaxed);
        assert!(cache.has(&"a"));
        clock.store(100, Ordering::Relaxed);
        assert_eq!(cache.get(&"a"), None);
        cache.set("b", 2);
        clock.store(250, Ordering::Relaxed);
        assert_eq!(cache.prune_expired(), 1);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn overwriting_a_key_moves_it_to_the_newest_slot_with_a_new_ttl() {
        let (mut cache, clock) = cache(3, 100);
        cache.set("a", 1);
        cache.set("b", 2);
        clock.store(60, Ordering::Relaxed);
        cache.set("a", 10);
        assert_eq!(cache.keys().copied().collect::<Vec<_>>(), ["b", "a"]);
        clock.store(130, Ordering::Relaxed);
        assert_eq!(cache.get(&"b"), None);
        assert_eq!(cache.get(&"a"), Some(&10));
    }
}
