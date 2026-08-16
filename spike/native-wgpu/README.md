# Spike 1 — native wgpu renderer (retired 16 Aug 2026)

Kept, not deleted. This is the evidence behind
`notes/Projects/Marlin/Decision 2026-08-16 Platform.md`, and it holds the `--bench`
harness the current renderer has to beat.

Measured on an M-series Mac, 200 frames, 100x30 grid:

| Build   | p50      | p99      | Effective |
|---------|----------|----------|-----------|
| debug   | 1258 ms  | 1710 ms  | 1 fps     |
| release | 67.9 ms  | 83.7 ms  | 15 fps    |

The release profile alone was an 18.5x speedup, which is why "Rust is slow" was
not the conclusion. The remaining ~150x gap is algorithmic: this spike lays the
whole screen out as a paragraph and reshapes every glyph every frame.

    cargo run --release -- --bench
