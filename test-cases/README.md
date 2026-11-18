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

Re-run the current engine on every recording:

```bash
for d in test-cases/*/; do
  inst=$(node -e "console.log(require('./$d/session.json').instrument)")
  (cd src-tauri && cargo run -q --release --example replay -- "../$d/recording.wav" "$inst" > "../$d/replayed.json")
done
```

Then notate and compare against `expected.txt`:

```bash
npm test
```

A case without `expected.txt` prints what the app writes, so it can be checked by eye.
