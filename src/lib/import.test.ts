import { describe, expect, it } from "vitest";
import { strToU8 } from "fflate";
import { importFile } from "./import";

// The awkward things real MuseScore/Finale exports contain.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <movement-title>Pickup Tune</movement-title>
  <part-list>
    <score-part id="P1"><part-name>Alto Saxophone</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>3</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
        <transpose><diatonic>-5</diatonic><chromatic>-9</chromatic></transpose>
      </attributes>
      <direction><sound tempo="96"/></direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><grace/><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><tie type="start"/><voice>1</voice><type>half</type></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>half</type></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>2</duration><tie type="stop"/><voice>1</voice><type>quarter</type></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>6</duration><voice>2</voice><type>half</type><dot/></note>
    </measure>
    <measure number="2">
      <note><rest/><duration>2</duration><voice>1</voice></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="0" implicit="yes">
      <attributes><divisions>1</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><rest/><duration>1</duration></note>
    </measure>
    <measure number="1">
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>3</duration></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>3</duration></note>
    </measure>
  </part>
</score-partwise>`;

describe("MusicXML import of real-world structures", () => {
  const p = importFile("tune.xml", strToU8(XML));

  it("reads title, meter, tempo and concert key", () => {
    expect(p.title).toBe("Pickup Tune");
    expect(p.timeSig).toEqual({ num: 3, den: 4 });
    expect(p.bpm).toBe(96);
    expect(p.concertKey).toBe("Bb"); // alto written G = concert Bb
  });

  it("maps parts to instruments (by name, then by clef and range)", () => {
    expect(p.parts.map((x) => x.instrument)).toEqual(["altoSax", "trombone"]); // bass line around G2-D3
    expect(p.parts[0].name).toBe("Alto Saxophone");
  });

  it("aligns the pickup to the end of bar 1, keeps voice 1, skips grace notes and chord tones, merges ties", () => {
    // Written D5 (74) - 9 = concert F4 (65). Pickup quarter -> last beat of bar 1 (steps 8-12).
    expect(p.parts[0].doc.notes).toEqual([
      { midi: 65, s: 8, e: 12 },
      { midi: 70, s: 12, e: 24 }, // G5 written, tied half + quarter = dotted half
      { midi: 67, s: 28, e: 30 },
      { midi: 69, s: 30, e: 32 },
      { midi: 70, s: 32, e: 36 },
    ]);
  });

  it("pads every part to whole bars", () => {
    expect(p.parts.every((x) => x.doc.endStep === 36)).toBe(true);
  });
});
