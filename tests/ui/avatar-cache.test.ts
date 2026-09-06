import { expect, test } from "bun:test";
import { BoundedCache } from "../../src/ui/bounded-cache.js";

test("bounded cache evicts the least recently used entry", () => {
  const now = 0;
  const cache = new BoundedCache<string, string>({
    maxEntries: 2,
    ttlMs: 100,
    now: () => now,
  });

  cache.set("first", "one");
  cache.set("second", "two");
  expect(cache.get("first")).toBe("one");
  cache.set("third", "three");

  expect(cache.get("first")).toBe("one");
  expect(cache.get("second")).toBeUndefined();
  expect([...cache.keys()]).toEqual(["third", "first"]);
});

test("bounded cache expires and prunes entries on ordinary operations", () => {
  let now = 10;
  const cache = new BoundedCache<string, string>({
    maxEntries: 3,
    ttlMs: 20,
    now: () => now,
  });

  cache.set("old", "value");
  now = 30;

  expect(cache.get("old")).toBeUndefined();
  expect(cache.size).toBe(0);

  cache.set("live", "value");
  now = 49;
  expect(cache.get("live")).toBe("value");
  now = 50;
  expect(cache.has("live")).toBe(false);
});
