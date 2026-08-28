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
  test("masks corners into the row background and paints the ring", () => {
    const source = solidImage(32, 200, 100, 50);
    const masked = circularAvatar(
      source,
      "#4b9cd3",
      "#282c34",
      4 / 3,
      "test-key",
    );
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
    // Corners carry the row background at full opacity, so avatars blend
    // with the pane even in terminals that ignore image alpha.
    expect(at(0, 0)).toEqual([0x28, 0x2c, 0x34, 255]);
    // The vertical lane remains visible in the image area outside the circle.
    expect(at(32, 0)).toEqual([0x4b, 0x9c, 0xd3, 255]);
    // The ring band carries the lane color at full opacity. The mask is an
    // ellipse, so the ring point is sampled on its vertical axis.
    const edge = at(32, 11);
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

  test("falls back to a neutral ring and black corners for unparsable colors", () => {
    const source = solidImage(32, 1, 2, 3);
    const masked = circularAvatar(source, "not-a-color", "also-bad", 1, "k2");
    const raw = masked.raw("rgba8");
    const stride = raw.stride || raw.width * 4;
    const corner = raw.data[3]!;
    expect(corner).toBe(255);
    const edge = raw.data[(raw.height - 1 - 54) * stride + 16 * 4 + 3]!;
    expect(edge).toBeGreaterThan(200);
    source.dispose();
  });
});
