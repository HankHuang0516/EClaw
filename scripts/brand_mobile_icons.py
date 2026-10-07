#!/usr/bin/env python3
"""Rebuild EClawbot installation icons from preserved, H-free originals.

The selected general italic H is composited only inside the coordinates below.
Android adaptive art stays in the background layer; its transparent foreground
receives the H so launcher masks can crop the layers together.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageChops


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "branding/eclawbot/original"
WATERMARK = ROOT / "branding/eclawbot/h-watermark-general-italic.png"
RES = ROOT / "app/src/main/res"
IOS_ICON = ROOT / "ios-app/assets/icon.png"
IOS_BRANDED = ROOT / "ios-app/assets/icon-branded.png"
PLAY_ICON = SOURCE / "play_store_icon_512.png"
PLAY_BRANDED = ROOT / "google_play/play_store_icon_512-branded.png"
DENSITIES = ("mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi")

# Coordinates are relative to each image size, then rounded to its own pixels.
# Keep H in the lower-right visible area, below the lettering and inside masks.
PLACEMENTS = {
    "ios": (824, 742, 145, 152, 1024),
    "play": (400, 400, 65, 68, 512),
    "legacy": (124, 151, 23, 24, 192),
    "adaptive": (300, 310, 40, 42, 432),
}


def scaled_placement(kind: str, size: int) -> tuple[int, int, int, int]:
    x, y, w, h, reference = PLACEMENTS[kind]
    return tuple(round(value * size / reference) for value in (x, y, w, h))


def brand(original: Image.Image, watermark: Image.Image, kind: str) -> Image.Image:
    x, y, w, h = scaled_placement(kind, original.width)
    result = original.convert("RGBA")
    patch = watermark.resize((w, h), Image.Resampling.LANCZOS)
    result.alpha_composite(patch, (x, y))
    return result


def check_outside(original: Image.Image, branded: Image.Image, kind: str) -> None:
    x, y, w, h = scaled_placement(kind, original.width)
    delta = ImageChops.difference(original.convert("RGBA"), branded.convert("RGBA"))
    delta.paste((0, 0, 0, 0), (x, y, x + w, y + h))
    if delta.getbbox():
        raise ValueError(f"Pixels outside H placement changed: {kind} {original.size}")


def write_or_check(result: Image.Image, path: Path, check: bool) -> None:
    if check:
        existing = Image.open(path).convert(result.mode)
        if existing.size != result.size or ImageChops.difference(existing, result).getbbox():
            raise ValueError(f"Branded icon is out of date: {path}")
    else:
        result.save(path, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify generated icons without writing")
    args = parser.parse_args()
    watermark = Image.open(WATERMARK).convert("RGBA")

    ios_original = Image.open(IOS_ICON)
    ios_result = brand(ios_original, watermark, "ios").convert("RGB")
    check_outside(ios_original, ios_result, "ios")
    write_or_check(ios_result, IOS_BRANDED, args.check)

    play_original = Image.open(PLAY_ICON)
    play_result = brand(play_original, watermark, "play").convert("RGB")
    check_outside(play_original, play_result, "play")
    write_or_check(play_result, PLAY_BRANDED, args.check)

    for density in DENSITIES:
        folder = f"mipmap-{density}"
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            source = SOURCE / "android" / folder / name
            original = Image.open(source)
            result = brand(original, watermark, "legacy")
            check_outside(original, result, "legacy")
            write_or_check(result, RES / folder / name, args.check)

        source = SOURCE / "android" / folder / "ic_launcher_foreground.png"
        original = Image.open(source)
        result = brand(original, watermark, "adaptive")
        check_outside(original, result, "adaptive")
        write_or_check(result, RES / folder / "ic_launcher_foreground.png", args.check)

    print("Branded mobile and Play icons verified; unchanged pixels preserved.")


if __name__ == "__main__":
    main()
