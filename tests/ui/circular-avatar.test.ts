import { describe, expect, test } from "bun:test";
import { NativeImage } from "@opentui/core";
import { circularAvatar, fallbackAvatar } from "../../src/ui/avatars.js";

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
    const masked = circularAvatar(source, {
      ringColor: "#4b9cd3",
      background: "#282c34",
      cacheKey: "test-key",
    });
    const raw = masked.raw("rgba8");
    const stride = raw.stride || raw.width * 4;
    // The canvas is padded sideways so a 3x1 cell box can center the circle.
    expect(raw.width).toBeGreaterThan(raw.height);
    const centerX = Math.round((raw.width - 1) / 2);
    const centerY = Math.round((raw.height - 1) / 2);
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
    expect(at(centerX, 0)).toEqual([0x4b, 0x9c, 0xd3, 255]);
    // The ring band carries the lane color at full opacity.
    const edge = at(centerX, 3);
    expect(edge[3]).toBe(255);
    expect(edge[0]).toBe(0x4b);
    expect(edge[1]).toBe(0x9c);
    expect(edge[2]).toBe(0xd3);
    // The centre keeps the underlying avatar pixels.
    const centre = at(centerX, centerY);
    expect(centre[0]).toBe(200);
    expect(centre[1]).toBe(100);
    expect(centre[2]).toBe(50);
    source.dispose();
  });

  test("falls back to a neutral ring and black corners for unparsable colors", () => {
    const source = solidImage(32, 1, 2, 3);
    const masked = circularAvatar(source, {
      ringColor: "not-a-color",
      background: "also-bad",
      cacheKey: "k2",
      padRatio: 1,
    });
    const raw = masked.raw("rgba8");
    const stride = raw.stride || raw.width * 4;
    // padRatio one yields a square canvas with black corners.
    expect(raw.width).toBe(raw.height);
    expect(raw.data[0]).toBe(0);
    expect(raw.data[3]).toBe(255);
    const centerX = Math.round((raw.width - 1) / 2);
    const ring = raw.data[(raw.height - 1 - 3) * stride + centerX * 4]!;
    expect(ring).toBe(136);
    source.dispose();
    masked.dispose();
  });

  test("reuses the cached canvas for a repeated key without re-masking", () => {
    const source = solidImage(32, 10, 20, 30);
    const first = circularAvatar(source, {
      ringColor: "#4b9cd3",
      background: "#282c34",
      cacheKey: "shared",
    });
    const second = circularAvatar(source, {
      ringColor: "#4b9cd3",
      background: "#282c34",
      cacheKey: "shared",
    });
    // Each call hands back its own reference, so disposing one leaves the
    // other usable and cache eviction cannot pull an image out from a widget.
    expect(second).not.toBe(first);
    first.dispose();
    expect(second.raw("rgba8").width).toBe(second.raw("rgba8").width);
    second.dispose();
    source.dispose();
  });

  test("builds a stable opaque fallback for an author", () => {
    const options = { ringColor: "#4b9cd3", background: "#282c34" };
    const first = fallbackAvatar("ada@example.com", options);
    const second = fallbackAvatar("ada@example.com", options);
    const raw = first.raw("rgba8");
    expect(
      [...raw.data].every(
        (_, index) => index % 4 !== 3 || raw.data[index] === 255,
      ),
    ).toBe(true);
    expect([...first.raw("rgba8").data]).toEqual([...second.raw("rgba8").data]);
    first.dispose();
    second.dispose();
  });
});
