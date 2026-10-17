#!/usr/bin/env python3
"""Create StoreBase's compact SBD1 copy/insert delta between two APK files."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import struct
import sys
from pathlib import Path

WINDOW = 64
MIN_CHUNK = 2048
AVG_CHUNK = 8192
MAX_CHUNK = 32768
MASK = AVG_CHUNK - 1
MAGIC = b"SBD1"


def _rotl64(value: int, amount: int) -> int:
    amount &= 63
    return ((value << amount) | (value >> (64 - amount))) & 0xFFFFFFFFFFFFFFFF


def _table() -> tuple[int, ...]:
    # Stable SplitMix64 values make chunk boundaries reproducible on every host.
    result = []
    state = 0x9E3779B97F4A7C15
    for _ in range(256):
        state = (state + 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF
        value = state
        value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
        value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
        result.append(value ^ (value >> 31))
    return tuple(result)


BUZHASH = _table()


def chunks(data: bytes):
    start = 0
    size = len(data)
    while start < size:
        limit = min(start + MAX_CHUNK, size)
        end = min(start + WINDOW, limit)
        rolling = 0
        for byte in data[start:end]:
            rolling = _rotl64(rolling, 1) ^ BUZHASH[byte]
        while end < limit:
            chunk_size = end - start
            if chunk_size >= MIN_CHUNK and (rolling & MASK) == 0:
                break
            incoming = data[end]
            outgoing = data[end - WINDOW] if chunk_size >= WINDOW else None
            rolling = _rotl64(rolling, 1) ^ BUZHASH[incoming]
            if outgoing is not None:
                rolling ^= _rotl64(BUZHASH[outgoing], WINDOW)
            end += 1
        yield start, end, data[start:end]
        start = end


def _ops(old: bytes, new: bytes):
    index: dict[bytes, list[tuple[int, bytes]]] = {}
    for offset, end, chunk in chunks(old):
        index.setdefault(hashlib.sha256(chunk).digest(), []).append((offset, chunk))
    operations: list[tuple[str, int | bytes, int]] = []
    for _, _, chunk in chunks(new):
        matches = index.get(hashlib.sha256(chunk).digest(), ())
        match_offset = next((offset for offset, candidate in matches if candidate == chunk), None)
        if match_offset is None:
            if operations and operations[-1][0] == "add":
                operations[-1] = ("add", operations[-1][1] + chunk, 0)  # type: ignore[operator]
            else:
                operations.append(("add", chunk, 0))
        elif operations and operations[-1][0] == "copy" and operations[-1][1] + operations[-1][2] == match_offset:
            previous = operations[-1]
            operations[-1] = ("copy", previous[1], previous[2] + len(chunk))
        else:
            operations.append(("copy", match_offset, len(chunk)))
    return operations


def create_delta(old: bytes, new: bytes) -> bytes:
    raw = bytearray(MAGIC + struct.pack(">Q", len(new)))
    for kind, value, length in _ops(old, new):
        if kind == "copy":
            raw.extend(b"\x00")
            raw.extend(struct.pack(">QI", int(value), length))
        else:
            data = bytes(value)
            if not data:
                continue
            raw.extend(b"\x01")
            raw.extend(struct.pack(">I", len(data)))
            raw.extend(data)
    return gzip.compress(bytes(raw), compresslevel=9, mtime=0)


def apply_delta(old: bytes, patch: bytes) -> bytes:
    import io
    if not patch.startswith(b"\x1f\x8b"):
        raise ValueError("Invalid compressed SBD1 patch")
    with gzip.GzipFile(fileobj=io.BytesIO(patch), mode="rb") as stream:
        decoded = stream.read()
    if len(decoded) < 12 or decoded[:4] != MAGIC:
        raise ValueError("Invalid SBD1 patch")
    target_size = struct.unpack_from(">Q", decoded, 4)[0]
    if target_size > 1024 * 1024 * 1024:
        raise ValueError("Patch output is too large")
    output = bytearray()
    cursor = 12
    while len(output) < target_size:
        if cursor >= len(decoded):
            raise ValueError("Truncated patch")
        operation = decoded[cursor]
        cursor += 1
        if operation == 0:
            if cursor + 12 > len(decoded):
                raise ValueError("Truncated copy operation")
            offset, length = struct.unpack_from(">QI", decoded, cursor)
            cursor += 12
            if offset + length > len(old) or length == 0 or len(output) + length > target_size:
                raise ValueError("Invalid copy operation")
            output.extend(old[offset:offset + length])
        elif operation == 1:
            if cursor + 4 > len(decoded):
                raise ValueError("Truncated data operation")
            length = struct.unpack_from(">I", decoded, cursor)[0]
            cursor += 4
            if length == 0 or cursor + length > len(decoded) or len(output) + length > target_size:
                raise ValueError("Invalid data operation")
            output.extend(decoded[cursor:cursor + length])
            cursor += length
        else:
            raise ValueError("Unknown patch operation")
    if len(output) != target_size or cursor != len(decoded):
        raise ValueError("Patch size or trailing bytes do not match")
    return bytes(output)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("old_apk", type=Path)
    parser.add_argument("new_apk", type=Path)
    parser.add_argument("output_patch", type=Path)
    args = parser.parse_args()
    old = args.old_apk.read_bytes()
    new = args.new_apk.read_bytes()
    if not old or not new:
        parser.error("Both APKs must be non-empty")
    patch = create_delta(old, new)
    if apply_delta(old, patch) != new:
        raise RuntimeError("Internal patch verification failed")
    args.output_patch.parent.mkdir(parents=True, exist_ok=True)
    args.output_patch.write_bytes(patch)
    print(f"Created verified delta: {len(patch)} bytes (full APK: {len(new)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
