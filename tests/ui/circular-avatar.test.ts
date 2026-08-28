import { describe, expect, test } from "bun:test";
import { NativeImage } from "@opentui/core";
import { circularAvatar } from "../../src/ui/avatars.js";

function solidImage(size: number, r: number, g: number, b: number) {
  const pixels = new Uint8Array(size * size * 4);
  for (let at = 0; at < size * size; at++) {
    pixels[at * 4] = r;
    pixels[at * 4 + 1] = g;
    pixels[at * 4 + 2] = b;
    pixels[at * 4 + 3] = 255;
  }
  return NativeImage.fromRgba(pixels, size, size);
}

describe("circular avatars", () => {
  test("masks corners and paints the ring in the lane color", () => {
    const source = solidImage(32, 200, 100, 50);
    const masked = circularAvatar(source, "#4b9cd3", "test-key");
    const raw = masked.raw("rgba8");
    const stride = raw.stride || raw.width * 4;
    // NativeImage's raw readout returns rows bottom-up.
    const at = (x: number, y: number) => {
      const row = raw.height - 1 - y;
      const out = row * stride + x * 4;
      return [
        raw.data[out]!,
        raw.data[out + 1]!,
        raw.data[out + 2]!,
        raw.data[out + 3]!,
      ];
    };
    // Corners are outside the circle and fully transparent.
    expect(at(0, 0)[3]).toBe(0);
    // The ring band carries the lane color at full opacity.
    const edge = at(16, 54);
    expect(edge[3]).toBeGreaterThan(200);
    expect(edge[0]).toBe(0x4b);
    expect(edge[1]).toBe(0x9c);
    expect(edge[2]).toBe(0xd3);
    // The centre keeps the underlying avatar pixels.
    const centre = at(16, 16);
    expect(centre[0]).toBe(200);
    expect(centre[1]).toBe(100);
    expect(centre[2]).toBe(50);
    source.dispose();
  });

  test("falls back to a neutral ring for unparsable colors", () => {
    const source = solidImage(32, 1, 2, 3);
    const masked = circularAvatar(source, "not-a-color", "fallback-key");
    const raw = masked.raw("rgba8");
    const stride = raw.stride || raw.width * 4;
    const edge = raw.data[(raw.height - 1 - 54) * stride + 16 * 4 + 3]!;
    expect(edge).toBeGreaterThan(200);
    source.dispose();
  });
});
