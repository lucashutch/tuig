//! A small least-recently-used cache bounded by entry count and total weight.
//!
//! Entries live in a `Vec` ordered from least to most recently used. The caches hold tens of
//! entries, so a linear key lookup costs less than the Git process it replaces.

pub struct LruCache<K, V> {
    entries: Vec<(K, V, usize)>,
    max_entries: usize,
    max_weight: usize,
    weight: usize,
}

impl<K: PartialEq, V: Clone> LruCache<K, V> {
    pub fn new(max_entries: usize, max_weight: usize) -> Self {
        Self {
            entries: Vec::new(),
            max_entries: max_entries.max(1),
            max_weight,
            weight: 0,
        }
    }

    /// Returns a copy of the value and marks it most recently used.
    pub fn get(&mut self, key: &K) -> Option<V> {
        let index = self.entries.iter().position(|(k, ..)| k == key)?;
        let entry = self.entries.remove(index);
        let value = entry.1.clone();
        self.entries.push(entry);
        Some(value)
    }

    /// Stores a value of the given weight. A value heavier than the whole budget is not stored.
    pub fn insert(&mut self, key: K, value: V, weight: usize) {
        if let Some(index) = self.entries.iter().position(|(k, ..)| *k == key) {
            self.weight -= self.entries.remove(index).2;
        }
        if weight > self.max_weight {
            return;
        }
        self.entries.push((key, value, weight));
        self.weight += weight;
        while self.entries.len() > self.max_entries || self.weight > self.max_weight {
            self.weight -= self.entries.remove(0).2;
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_least_recently_used_by_count() {
        let mut cache = LruCache::new(2, 100);
        cache.insert("a", 1, 1);
        cache.insert("b", 2, 1);
        assert_eq!(cache.get(&"a"), Some(1));
        cache.insert("c", 3, 1);
        assert_eq!(cache.get(&"b"), None);
        assert_eq!(cache.get(&"a"), Some(1));
        assert_eq!(cache.get(&"c"), Some(3));
    }

    #[test]
    fn evicts_by_weight_and_skips_oversized_values() {
        let mut cache = LruCache::new(10, 10);
        cache.insert("a", 1, 6);
        cache.insert("b", 2, 6);
        assert_eq!(cache.get(&"a"), None);
        cache.insert("huge", 3, 11);
        assert_eq!(cache.get(&"huge"), None);
        assert_eq!(cache.get(&"b"), Some(2));
        cache.insert("b", 4, 2);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get(&"b"), Some(4));
    }
}
