#!/usr/bin/env bash
# Compiles and runs the unit tests of the conformance Rust extern implementations
# (conformance/externs/rust), which need no third-party crates. They are linked against conformance/externs/rust/stub/yaffle_runtime.rs, a copy of the runtime's host
# interface (Codec, ExternType, Arg, CodecCtx).
# Needs rustc: `nix shell nixpkgs#rustc --command conformance/scripts/test-rust-externs.sh [file.rs...]`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/yaffle-rust-externs"
mkdir -p "$OUT"
files=("$@")
if [[ ${#files[@]} -eq 0 ]]; then
  files=("$ROOT"/conformance/externs/rust/*.rs)
fi
rustc --edition 2021 --crate-type lib --crate-name yaffle_runtime \
  "$ROOT/conformance/externs/rust/stub/yaffle_runtime.rs" -o "$OUT/libyaffle_runtime.rlib"
{
  echo "#![allow(dead_code)]"
  for f in "${files[@]}"; do
    n="$(basename "$f" .rs)"
    echo "#[path = \"$f\"] mod $n;"
  done
} >"$OUT/lib.rs"
rustc --edition 2021 --test "$OUT/lib.rs" --extern "yaffle_runtime=$OUT/libyaffle_runtime.rlib" -o "$OUT/tests"
"$OUT/tests"
