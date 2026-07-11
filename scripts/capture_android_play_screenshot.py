#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RAW_DIR = Path(os.environ.get("ECLAW_ANDROID_STORE_RAW_DIR", "/tmp/eclaw-android-store/raw"))


def find_adb(explicit: str | None) -> str:
    if explicit:
        return explicit

    found = shutil.which("adb")
    if found:
        return found

    sdk_adb = Path.home() / "Android/sdk/platform-tools/adb"
    if sdk_adb.exists():
        return str(sdk_adb)

    raise SystemExit("adb not found in PATH or ~/Android/sdk/platform-tools/adb")


def adb_command(adb: str, serial: str | None, args: list[str]) -> list[str]:
    cmd = [adb]
    if serial:
        cmd += ["-s", serial]
    return cmd + args


def run(adb: str, serial: str | None, args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        adb_command(adb, serial, args),
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def ensure_device(adb: str, serial: str | None) -> None:
    result = run(adb, serial, ["devices"])
    devices = [
        line.split("\t", 1)[0]
        for line in result.stdout.splitlines()
        if "\tdevice" in line
    ]
    if serial:
        if serial not in devices:
            raise SystemExit(f"device {serial!r} is not available; adb devices:\n{result.stdout}")
        return
    if len(devices) != 1:
        raise SystemExit(
            "expected exactly one connected emulator/device; use --device when multiple exist.\n"
            f"adb devices:\n{result.stdout}"
        )


def launch_target(adb: str, serial: str | None, package: str | None, activity: str | None, url: str | None) -> None:
    if package:
        run(adb, serial, ["shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1"])
    if activity:
        run(adb, serial, ["shell", "am", "start", "-n", activity])
    if url:
        run(adb, serial, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url])


def capture_png(adb: str, serial: str | None, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = adb_command(adb, serial, ["exec-out", "screencap", "-p"])
    with out_path.open("wb") as fh:
        proc = subprocess.run(cmd, stdout=fh, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.decode("utf-8", errors="replace"))


def capture_xml(adb: str, serial: str | None, out_path: Path) -> None:
    dump = run(adb, serial, ["shell", "uiautomator", "dump", "/sdcard/window.xml"], check=False)
    if dump.returncode != 0:
        print(f"warning: uiautomator dump failed: {dump.stderr.strip()}", file=sys.stderr)
        return

    cat = subprocess.run(
        adb_command(adb, serial, ["exec-out", "cat", "/sdcard/window.xml"]),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if cat.returncode != 0:
        print(f"warning: cannot read window.xml: {cat.stderr.decode('utf-8', errors='replace').strip()}", file=sys.stderr)
        return
    out_path.write_bytes(cat.stdout)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Capture a real Android emulator/device screenshot for the Play Store screenshot pipeline."
    )
    parser.add_argument("slug", help="output basename without extension, for example 01-live-usage-monitor")
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR, help=f"default: {DEFAULT_RAW_DIR}")
    parser.add_argument("--adb", help="adb binary path; defaults to PATH or ~/Android/sdk/platform-tools/adb")
    parser.add_argument("--device", help="adb serial, for example emulator-5554")
    parser.add_argument("--package", default="com.hank.clawlive", help="package to launch before capture")
    parser.add_argument("--activity", help="optional component to start, for example com.hank.clawlive/.MainActivity")
    parser.add_argument("--open-url", help="optional deep link or web URL to open before capture")
    parser.add_argument("--wait", type=float, default=1.5, help="seconds to wait after launch/deeplink, default: 1.5")
    parser.add_argument("--skip-launch", action="store_true", help="capture the current screen without launching the app")
    parser.add_argument("--skip-xml", action="store_true", help="do not capture the UIAutomator XML sidecar")
    return parser


def main(argv: Iterable[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    adb = find_adb(args.adb)
    ensure_device(adb, args.device)

    if not args.skip_launch:
        launch_target(adb, args.device, args.package, args.activity, args.open_url)
        time.sleep(max(0, args.wait))

    raw_dir = args.raw_dir if args.raw_dir.is_absolute() else ROOT / args.raw_dir
    png_path = raw_dir / f"{args.slug}.png"
    capture_png(adb, args.device, png_path)
    print(f"wrote {png_path}")

    if not args.skip_xml:
        xml_path = raw_dir / f"{args.slug}.xml"
        capture_xml(adb, args.device, xml_path)
        if xml_path.exists():
            print(f"wrote {xml_path}")


if __name__ == "__main__":
    main()
