// Key signatures, transposition of keys, and note spelling for VexFlow.

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
type Letter = (typeof LETTERS)[number];
const NATURAL_PC: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];

/** Major keys offered as the concert key, in band-friendly order. */
export const CONCERT_KEYS = ["Bb", "Eb", "F", "Ab", "C", "Db", "G", "Gb", "D", "A", "E", "B"] as const;
export type KeyName = string;

const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"]);

/** Preferred key name for each pitch class (fewest accidentals). */
const KEY_FOR_PC: Record<number, KeyName> = {
  0: "C", 1: "Db", 2: "D", 3: "Eb", 4: "E", 5: "F", 6: "F#", 7: "G", 8: "Ab", 9: "A", 10: "Bb", 11: "B",
};

export function keyPitchClass(key: KeyName): number {
  const letter = key[0] as Letter;
  const alter = key.slice(1) === "#" ? 1 : key.slice(1) === "b" ? -1 : 0;
  return (NATURAL_PC[letter] + alter + 12) % 12;
}

/** The written key for a transposing instrument, e.g. concert Bb + 2 -> C. */
export function writtenKey(concertKey: KeyName, transposeSemitones: number): KeyName {
  const pc = (((keyPitchClass(concertKey) + transposeSemitones) % 12) + 12) % 12;
  if (pc === 6) return FLAT_KEYS.has(concertKey) ? "Gb" : "F#";
  return KEY_FOR_PC[pc];
}

interface Spelled {
  letter: Letter;
  alter: number; // -2..2
}

function scaleOf(key: KeyName): Spelled[] {
  const tonic = key[0] as Letter;
  const tonicPc = keyPitchClass(key);
  const start = LETTERS.indexOf(tonic);
  return MAJOR_STEPS.map((step, degree) => {
    const letter = LETTERS[(start + degree) % 7];
    const pc = (tonicPc + step) % 12;
    let alter = pc - NATURAL_PC[letter];
    if (alter > 6) alter -= 12;
    if (alter < -6) alter += 12;
    return { letter, alter };
  });
}

/** Number of accidentals in a key signature (for layout width). */
export function keyAccidentalCount(key: KeyName): number {
  return scaleOf(key).filter((s) => s.alter !== 0).length;
}

const C_MAJOR_CHROMATIC: Record<number, Spelled> = {
  1: { letter: "C", alter: 1 },
  3: { letter: "E", alter: -1 },
  6: { letter: "F", alter: 1 },
  8: { letter: "G", alter: 1 },
  10: { letter: "B", alter: -1 },
};

function spellPc(pc: number, key: KeyName): Spelled {
  const scale = scaleOf(key);
  const inScale = scale.find((s) => (NATURAL_PC[s.letter] + s.alter + 12) % 12 === pc);
  if (inScale) return inScale;
  // A natural sign beats a sharp or flat on an unrelated letter.
  const natural = LETTERS.find((l) => NATURAL_PC[l] === pc);
  if (natural) return { letter: natural, alter: 0 };
  if (key === "C") return C_MAJOR_CHROMATIC[pc];
  if (FLAT_KEYS.has(key)) {
    const letter = LETTERS.find((l) => (NATURAL_PC[l] + 11) % 12 === pc)!;
    return { letter, alter: -1 };
  }
  const letter = LETTERS.find((l) => (NATURAL_PC[l] + 1) % 12 === pc)!;
  return { letter, alter: 1 };
}

const ALTER_TEXT: Record<number, string> = { [-2]: "bb", [-1]: "b", 0: "", 1: "#", 2: "##" };
const ALTER_DISPLAY: Record<number, string> = { [-2]: "𝄫", [-1]: "♭", 0: "", 1: "♯", 2: "𝄪" };

function octaveOf(midi: number, s: Spelled): number {
  return Math.round((midi - NATURAL_PC[s.letter] - s.alter) / 12) - 1;
}

/** VexFlow key string such as "f#/4", spelled for the key signature. */
export function vexKey(midi: number, key: KeyName): string {
  const s = spellPc(((midi % 12) + 12) % 12, key);
  return `${s.letter.toLowerCase()}${ALTER_TEXT[s.alter]}/${octaveOf(midi, s)}`;
}

/** Display name such as "F♯4", spelled for the key signature. */
export function displayName(midi: number, key: KeyName): string {
  const s = spellPc(((midi % 12) + 12) % 12, key);
  return `${s.letter}${ALTER_DISPLAY[s.alter]}${octaveOf(midi, s)}`;
}

export function displayKey(key: KeyName): string {
  return key.replace("b", "♭").replace("#", "♯");
}
