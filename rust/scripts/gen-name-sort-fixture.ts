// Writes name pairs with the sign of `a.localeCompare(b, LOCALE)` from Bun, for the
// name_sort cross-check test. Run: bun rust/scripts/gen-name-sort-fixture.ts
import { writeFileSync } from "node:fs";

// The root collator has no locale tailoring. Fix the locale so the fixture does not depend on the process locale.
const LOCALE = "en-US";

let seed = 0x5eed1234;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;

const pools = {
  lower: [..."abcdefghijklmnopqrstuvwxyz"],
  upper: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
  digit: [..."0123456789"],
  punct: [..." _-.,;'()[]{}@#+~$&!%^=`"],
  accent: [..."àáâãäåçèéêëìíîïñòóôõöùúûüýÿÀÉÖÜÑßæøœðþłšž"],
  other: [..."αβγДЖюї€£§°µ"],
  cjk: [..."漢字日本語中文한글あいうカタカナ"],
};
const mixes = [
  ["lower"],
  ["lower", "upper"],
  ["lower", "digit", "punct"],
  ["lower", "upper", "digit", "punct"],
  ["lower", "accent"],
  ["lower", "upper", "accent", "punct"],
  ["lower", "cjk"],
  ["lower", "upper", "digit", "punct", "accent", "other", "cjk"],
] as const;

const word = (mix: readonly (keyof typeof pools)[]) => {
  const length = 1 + Math.floor(random() * 7);
  let text = "";
  for (let at = 0; at < length; at++) text += pick(pools[pick(mix)]);
  return text;
};
// Half of the pairs share a prefix or differ by one character, so the lower
// collation levels decide the result.
const mutate = (text: string, mix: readonly (keyof typeof pools)[]) => {
  const chars = [...text];
  const at = Math.floor(random() * chars.length);
  const kind = random();
  if (kind < 0.35) chars[at] = pick(pools[pick(mix)]);
  else if (kind < 0.55) chars[at] = chars[at]!.toUpperCase();
  else if (kind < 0.7) chars[at] = chars[at]!.toLowerCase();
  else if (kind < 0.85) chars.splice(at, 0, pick(pools[pick(mix)]));
  else chars.splice(at, 1);
  return chars.join("");
};

const pairs: [string, string, number][] = [];
for (let count = 0; count < 8000; count++) {
  const mix = pick(mixes);
  const a =
    word(mix) + (random() < 0.3 ? `.${pick(["ts", "rs", "TS", "md"])}` : "");
  const b = random() < 0.5 ? mutate(a, mix) : word(mix);
  pairs.push([a, b, Math.sign(a.localeCompare(b, LOCALE))]);
}
writeFileSync(
  new URL(
    "../crates/tuig-ui-model/tests/fixtures/name_sort.json",
    import.meta.url,
  ),
  JSON.stringify({
    bun: Bun.version,
    icu: process.versions.icu,
    locale: LOCALE,
    pairs,
  }),
);
