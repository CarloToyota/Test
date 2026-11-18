# Real-world test cases

Each folder here is one take saved with **Export → Save test case** in the app:

| File | What it is |
|---|---|
| `recording.wav` | The exact audio the engine heard (mono, 16-bit) |
| `session.json` | Instrument, key, tempo, time signature, grid, latency, the detected note events, and what the app wrote |
| `expected.txt` | *(add by hand)* the correct notation, one bar per line, in the same format as `session.json` → `detected` |
| `replayed.json` | *(generated)* note events from the current engine, re-run on `recording.wav` |

## Adding a case

1. Record a short passage (10 to 30 s is plenty) and save it with **Save test case**. In the description, say exactly what you played, for example "8 staccato quarters on written C5, 100 bpm".
2. Copy the folder in here and push it.

## Running

`cargo test` (in `src-tauri`) runs the current engine on every `recording.wav` and checks the notes against `expected.txt`:

```bash
cd src-tauri && cargo test --test recordings -- --nocapture
```

`npm test` checks the notation (rhythm, ties, bars) from `replayed.json`. To refresh `replayed.json` after an engine change:

```bash
for d in test-cases/*/; do
  inst=$(node -e "console.log(require('./$d/session.json').instrument)")
  (cd src-tauri && cargo run -q --release --example replay -- "../$d/recording.wav" "$inst" > "../$d/replayed.json")
done
```

To accept the current reading as the new `expected.txt` (review the diff first):

```bash
WRITE_EXPECTED=1 npx vitest run src/lib/testcases.test.ts
```

`session.json` may contain `"notateAs": "3/4"` when a piece was recorded with a different click meter.

## Cases so far

| Case | What was played | Result |
|---|---|---|
| `21-15-27` | Alto, written C5: 4 quarters, 8 eighths, 16 sixteenths (dragged), 80 bpm | Exact; the dragged 16ths are written as played |
| `21-19-08` | Alto, G4 to G5 and back in quarters, whole note at the end, 80 bpm | Exact |
| `21-28-12` | Alto, The Star-Spangled Banner, 3/4 at 80 bpm (recorded with a 4/4 click); `.mxl` is the score | Every pitch right. 80 of 101 notes have exactly the score's start and length; the rest are expressive timing (rubato) |
| `21-32-08` | Alto, 16ths, four per scale step from D4 to C6, 80 bpm | Exact apart from one extra D5 |

`src/lib/rhythmeval.test.ts` scores rhythm settings against the anthem's score: `EVAL=1 npx vitest run src/lib/rhythmeval.test.ts`.
