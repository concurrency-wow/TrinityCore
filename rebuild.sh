#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT_DIR/build}"
SERVER_DIR="${SERVER_DIR:-/home/czirz/server}"
JOBS="${JOBS:-$(nproc)}"
TARGETS=("${@:-all}")

if [[ ! -f "$BUILD_DIR/CMakeCache.txt" ]]; then
    printf 'CMake build directory is not configured: %s\n' "$BUILD_DIR" >&2
    printf 'Configure it first with: cmake -S "%s" -B "%s"\n' "$ROOT_DIR" "$BUILD_DIR" >&2
    exit 1
fi

mkdir -p "$SERVER_DIR"

printf 'Cleaning %s\n' "$BUILD_DIR"
cmake --build "$BUILD_DIR" --target clean

printf 'Building targets: %s\n' "${TARGETS[*]}"
cmake --build "$BUILD_DIR" --parallel "$JOBS" --target "${TARGETS[@]}"

for executable in worldserver authserver; do
    built_files=("$BUILD_DIR"/bin/*/bin/"$executable")
    if [[ -x "${built_files[0]}" ]]; then
        printf 'Moving %s to %s/%s\n' "${built_files[0]}" "$SERVER_DIR" "$executable"
        mv -f -- "${built_files[0]}" "$SERVER_DIR/$executable"
    fi
done

printf 'Build complete.\n'
