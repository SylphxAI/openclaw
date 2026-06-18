import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, encodePngRgba, fillPixel, pngChunk } from "./png-encode.js";

describe("crc32", () => {
  it("matches the canonical CRC-32 test vector", () => {
    // Standard ISO-HDLC reference vector: CRC32("123456789") === 0xCBF43926.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("returns 0 for an empty buffer", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("produces an unsigned 32-bit result", () => {
    const crc = crc32(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(crc)).toBe(true);
  });

  it("is sensitive to byte order", () => {
    expect(crc32(Buffer.from([1, 2, 3]))).not.toBe(crc32(Buffer.from([3, 2, 1])));
  });
});

describe("pngChunk", () => {
  it("frames a chunk as [length][type][data][crc]", () => {
    const chunk = pngChunk("IEND", Buffer.alloc(0));
    // 4 (length) + 4 (type) + 0 (data) + 4 (crc) = 12 bytes.
    expect(chunk).toHaveLength(12);
    // Canonical empty IEND chunk per the PNG spec.
    expect(chunk.toString("hex")).toBe("0000000049454e44ae426082");
  });

  it("writes the data length as a big-endian uint32", () => {
    const data = Buffer.from([0xaa, 0xbb, 0xcc]);
    const chunk = pngChunk("IDAT", data);
    expect(chunk.readUInt32BE(0)).toBe(data.length);
    expect(chunk.subarray(4, 8).toString("ascii")).toBe("IDAT");
    expect(chunk.subarray(8, 8 + data.length)).toEqual(data);
  });

  it("appends a crc computed over type + data", () => {
    const data = Buffer.from([0x01, 0x02]);
    const chunk = pngChunk("tEXt", data);
    const expectedCrc = crc32(Buffer.concat([Buffer.from("tEXt", "ascii"), data]));
    expect(chunk.readUInt32BE(chunk.length - 4)).toBe(expectedCrc);
  });
});

describe("fillPixel", () => {
  it("writes RGBA bytes at the computed offset", () => {
    const buf = Buffer.alloc(16); // 2x2 RGBA
    fillPixel(buf, 0, 0, 2, 10, 20, 30, 40);
    expect([...buf.subarray(0, 4)]).toEqual([10, 20, 30, 40]);
  });

  it("computes offset from x, y and width", () => {
    const buf = Buffer.alloc(16); // 2x2 RGBA
    fillPixel(buf, 1, 1, 2, 1, 2, 3, 4); // idx = (1*2 + 1) * 4 = 12
    expect([...buf.subarray(12, 16)]).toEqual([1, 2, 3, 4]);
  });

  it("defaults alpha to 255", () => {
    const buf = Buffer.alloc(4);
    fillPixel(buf, 0, 0, 1, 5, 6, 7);
    expect([...buf]).toEqual([5, 6, 7, 255]);
  });

  it("ignores negative coordinates", () => {
    const buf = Buffer.alloc(16);
    fillPixel(buf, -1, 0, 2, 99, 99, 99, 99);
    fillPixel(buf, 0, -1, 2, 99, 99, 99, 99);
    expect(buf.every((byte) => byte === 0)).toBe(true);
  });

  it("ignores x at or beyond width", () => {
    const buf = Buffer.alloc(16);
    fillPixel(buf, 2, 0, 2, 99, 99, 99, 99);
    expect(buf.every((byte) => byte === 0)).toBe(true);
  });

  it("ignores writes that would overflow the buffer", () => {
    const buf = Buffer.alloc(16); // 2x2 -> y=2 yields idx 16, out of range
    fillPixel(buf, 0, 2, 2, 99, 99, 99, 99);
    expect(buf.every((byte) => byte === 0)).toBe(true);
  });
});

describe("encodePngRgba", () => {
  it("emits a valid PNG signature", () => {
    const png = encodePngRgba(Buffer.from([0, 0, 0, 255]), 1, 1);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("encodes dimensions and RGBA format in the IHDR chunk", () => {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]); // 2x1
    const png = encodePngRgba(pixels, 2, 1);
    const ihdr = png.subarray(16, 29); // 8 sig + 4 len + 4 type
    expect(ihdr.readUInt32BE(0)).toBe(2); // width
    expect(ihdr.readUInt32BE(4)).toBe(1); // height
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // color type RGBA
  });

  it("stores pixel data behind a 'filter: none' scanline that round-trips via inflate", () => {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]); // red, blue
    const png = encodePngRgba(pixels, 2, 1);
    const idatType = png.indexOf(Buffer.from("IDAT", "ascii"));
    const idatLen = png.readUInt32BE(idatType - 4);
    const idatData = png.subarray(idatType + 4, idatType + 4 + idatLen);
    const raw = inflateSync(idatData);
    // Leading 0 = filter "none", followed by the original scanline bytes.
    expect([...raw]).toEqual([0, ...pixels]);
  });

  it("terminates with the canonical IEND chunk", () => {
    const png = encodePngRgba(Buffer.from([0, 0, 0, 255]), 1, 1);
    expect(png.subarray(-12).toString("hex")).toBe("0000000049454e44ae426082");
  });
});
