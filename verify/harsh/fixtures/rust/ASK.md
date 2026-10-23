# Clamp `clamp_percent`

`clamp_percent` must return a value between 0 and 100, but today it returns its input unchanged.

1. Fix it in `src/lib.rs`.
2. Add tests for a value above the range (150 becomes 100) and a value below it (-5 becomes 0). Keep the
   existing test passing.

`cargo test` must pass. This change touches native Rust: a green test run is the evidence.
