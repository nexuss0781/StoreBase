#!/usr/bin/env python3
"""Create and verify a local StoreBase delta artifact for a later Telegram release."""
from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path

from create_apk_delta import apply_delta, create_delta


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path, help="New signed APK")
    parser.add_argument("--version-code", required=True, type=int, help="Android version code of the new APK")
    parser.add_argument("--version-name", required=True, help="Android version name of the new APK")
    parser.add_argument("--base-apk", type=Path, help="Previously released APK used as the delta base")
    parser.add_argument("--base-version-code", type=int, help="Version code of --base-apk")
    parser.add_argument("--output-dir", type=Path, default=Path("updates/releases"))
    args = parser.parse_args()

    if not args.apk.is_file() or args.apk.stat().st_size <= 0:
        parser.error("--apk must name a non-empty APK file")
    if args.version_code <= 0:
        parser.error("--version-code must be a positive integer")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}", args.version_name):
        parser.error("--version-name contains unsupported characters")
    if bool(args.base_apk) != bool(args.base_version_code):
        parser.error("--base-apk and --base-version-code must be supplied together")
    if args.base_apk and (not args.base_apk.is_file() or args.base_apk.stat().st_size <= 0
                          or args.base_version_code <= 0 or args.base_version_code >= args.version_code):
        parser.error("Base APK must exist and its positive version code must be lower than the new version")

    print(f"Full APK (publish this from the supplied path): {args.apk.resolve()} ({args.apk.stat().st_size} bytes)")
    if not args.base_apk:
        print("No base APK supplied; Telegram can carry a full-APK-only release.")
        return 0

    old = args.base_apk.read_bytes()
    new = args.apk.read_bytes()
    delta = create_delta(old, new)
    if apply_delta(old, delta) != new:
        raise RuntimeError("Generated delta failed round-trip verification")
    if len(delta) >= len(new):
        print("No smaller patch was produced; publish only the full APK to Telegram.")
        return 0

    digest = hashlib.sha256(delta).hexdigest()
    name = f"StoreBase-v{args.base_version_code}-to-v{args.version_code}-{digest[:12]}.sbd"
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    patch_path = output_dir / name
    patch_path.write_bytes(delta)
    print(f"Verified Telegram delta: {patch_path} ({len(delta)} bytes, sha256 {digest})")
    print("Pass this .sbd path and its base version code to storebase-publish; this script does not publish.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
