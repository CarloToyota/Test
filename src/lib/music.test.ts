import { describe, expect, it } from "vitest";
import { displayName, keyAccidentalCount, vexKey, writtenKey } from "./music";

describe("writtenKey", () => {
  it("transposes concert Bb for each instrument family", () => {
    expect(writtenKey("Bb", 0)).toBe("Bb"); // flute, trombone, tuba
    expect(writtenKey("Bb", 2)).toBe("C"); // trumpet, clarinet
    expect(writtenKey("Bb", 14)).toBe("C"); // tenor sax
    expect(writtenKey("Bb", 9)).toBe("G"); // alto sax
    expect(writtenKey("Bb", 21)).toBe("G"); // bari sax
    expect(writtenKey("Bb", 7)).toBe("F"); // horn
  });
  it("concert Eb", () => {
    expect(writtenKey("Eb", 2)).toBe("F");
    expect(writtenKey("Eb", 9)).toBe("C");
    expect(writtenKey("Eb", 7)).toBe("Bb");
  });
});

describe("spelling", () => {
  it("uses the key signature's spelling", () => {
    expect(vexKey(66, "D")).toBe("f#/4");
    expect(vexKey(70, "F")).toBe("bb/4");
    expect(vexKey(65, "F#")).toBe("e#/4");
    expect(vexKey(59, "Gb")).toBe("cb/4"); // Cb4 sounds as B3
  });
  it("prefers naturals for chromatic notes, then sharps or flats by key", () => {
    expect(vexKey(65, "G")).toBe("f/4");
    expect(vexKey(68, "D")).toBe("g#/4");
    expect(vexKey(68, "Eb")).toBe("ab/4");
    expect(vexKey(61, "Bb")).toBe("db/4");
  });
  it("display names", () => {
    expect(displayName(70, "Bb")).toBe("B♭4");
    expect(displayName(60, "C")).toBe("C4");
  });
  it("counts key signature accidentals", () => {
    expect(keyAccidentalCount("C")).toBe(0);
    expect(keyAccidentalCount("Eb")).toBe(3);
    expect(keyAccidentalCount("E")).toBe(4);
  });
});
