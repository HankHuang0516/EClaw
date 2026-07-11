#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageColor, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "google_play/play_store_icon_512.png"
DEFAULT_RES_DIR = ROOT / "app/src/main/res"
DEFAULT_PLAY_ICON = ROOT / "google_play/play_store_icon_512.png"
EMOJI_FONT = Path("/System/Library/Fonts/Apple Color Emoji.ttc")
TEXT_FONTS = (
    Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
    Path("/System/Library/Fonts/STHeiti Medium.ttc"),
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
)

LEGACY_DENSITIES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

ADAPTIVE_DENSITIES = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}


def parse_color(value: str) -> tuple[int, int, int, int]:
    try:
        rgb = ImageColor.getrgb(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc
    if len(rgb) == 3:
        return (rgb[0], rgb[1], rgb[2], 255)
    return rgb


def resolve(path: str | Path) -> Path:
    p = Path(path)
    return p if p.is_absolute() else ROOT / p


def contain(source: Image.Image, size: int, scale: float, bg: tuple[int, int, int, int]) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), bg)
    target = max(1, int(size * scale))
    fitted = source.copy()
    fitted.thumbnail((target, target), Image.Resampling.LANCZOS)
    x = (size - fitted.width) // 2
    y = (size - fitted.height) // 2
    canvas.alpha_composite(fitted, (x, y))
    return canvas


def mix_rgb(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))


def load_font(candidates: Iterable[Path], size: int) -> ImageFont.ImageFont:
    for candidate in candidates:
        if not candidate.exists():
            continue
        try:
            return ImageFont.truetype(str(candidate), size)
        except OSError:
            continue
    return ImageFont.load_default()


def load_emoji_font(max_size: int) -> ImageFont.ImageFont:
    if EMOJI_FONT.exists():
        for size in (160, 96, 64, 52, 48, 40, 32, 26, 20):
            if size <= max_size:
                try:
                    return ImageFont.truetype(str(EMOJI_FONT), size)
                except OSError:
                    continue
    return load_font(TEXT_FONTS, max_size)


def is_text_icon(value: str) -> bool:
    return value.isascii() and any(ch.isalnum() for ch in value)


def load_icon_font(value: str, max_size: int, max_width: int, max_height: int) -> ImageFont.ImageFont:
    if not is_text_icon(value):
        return load_emoji_font(max_size)

    probe = Image.new("RGBA", (10, 10))
    draw = ImageDraw.Draw(probe)
    for size in range(max_size, 20, -4):
        font = load_font(TEXT_FONTS, size)
        left, top, right, bottom = text_bbox(draw, value, font)
        if right - left <= max_width and bottom - top <= max_height:
            return font
    return load_font(TEXT_FONTS, 20)


def text_bbox(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int, int, int]:
    return draw.textbbox((0, 0), text, font=font, stroke_width=0, embedded_color=True)


def centered_text_position(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    box: tuple[int, int, int, int],
) -> tuple[int, int]:
    left, top, right, bottom = text_bbox(draw, text, font)
    width = right - left
    height = bottom - top
    x = box[0] + (box[2] - box[0] - width) // 2 - left
    y = box[1] + (box[3] - box[1] - height) // 2 - top
    return x, y


def persona_icon(persona: dict[str, object], size: int = 512) -> tuple[Image.Image, tuple[int, int, int, int]]:
    emoji = str(persona.get("iconEmoji") or "").strip()
    if not emoji:
        raise SystemExit("persona JSON must include a non-empty iconEmoji")

    tint_raw = str(persona.get("tint") or "").strip()
    if not tint_raw:
        raise SystemExit("persona JSON must include a non-empty tint")
    tint = parse_color(tint_raw)
    tint_rgb = tint[:3]

    canvas = Image.new("RGBA", (size, size), tint)
    pix = canvas.load()
    top = mix_rgb(tint_rgb, (255, 255, 255), 0.22)
    bottom = mix_rgb(tint_rgb, (0, 0, 0), 0.28)
    for y in range(size):
        row = mix_rgb(top, bottom, y / max(1, size - 1))
        for x in range(size):
            pix[x, y] = (*row, 255)

    draw = ImageDraw.Draw(canvas, "RGBA")
    pad = round(size * 0.16)
    draw.ellipse((pad, pad, size - pad, size - pad), fill=(255, 255, 255, 46), outline=(255, 255, 255, 130), width=4)

    emoji_box = (round(size * 0.18), round(size * 0.12), round(size * 0.82), round(size * 0.76))
    emoji_font = load_icon_font(
        emoji,
        max_size=round(size * 0.58),
        max_width=emoji_box[2] - emoji_box[0],
        max_height=emoji_box[3] - emoji_box[1],
    )
    draw.text(
        centered_text_position(draw, emoji, emoji_font, emoji_box),
        emoji,
        font=emoji_font,
        fill=(255, 255, 255, 255),
        embedded_color=True,
    )

    return canvas, tint


def load_persona(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid persona JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"persona JSON must be an object: {path}")
    return data


def save_png(img: Image.Image, path: Path, dry_run: bool) -> None:
    path = resolve(path)
    if dry_run:
        print(f"would write {path}")
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    data = buf.getvalue()
    if path.exists() and path.read_bytes() == data:
        print(f"unchanged {path}")
        return
    path.write_bytes(data)
    print(f"wrote {path}")


def save_xml(path: Path, content: str, dry_run: bool) -> None:
    path = resolve(path)
    if dry_run:
        print(f"would write {path}")
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    data = content.encode("utf-8")
    if path.exists() and path.read_bytes() == data:
        print(f"unchanged {path}")
        return
    path.write_bytes(data)
    print(f"wrote {path}")


def launcher_xml() -> str:
    return """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""


def generate_icon_assets(
    src: Image.Image,
    res_dir: Path,
    play_store_icon: Path | None,
    background: tuple[int, int, int, int],
    legacy_scale: float,
    adaptive_foreground_scale: float,
    dry_run: bool,
    play_store_icon_matches_source: bool = False,
) -> None:
    for folder, size in LEGACY_DENSITIES.items():
        folder_path = res_dir / folder
        square = contain(src, size, legacy_scale, background)
        save_png(square, folder_path / "ic_launcher.png", dry_run)

        mask = Image.new("L", (size, size), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse((0, 0, size - 1, size - 1), fill=255)
        round_icon = square.copy()
        round_icon.putalpha(mask)
        save_png(round_icon, folder_path / "ic_launcher_round.png", dry_run)

    for folder, size in ADAPTIVE_DENSITIES.items():
        folder_path = res_dir / folder
        bg = Image.new("RGBA", (size, size), background)
        fg = contain(src, size, adaptive_foreground_scale, (0, 0, 0, 0))
        save_png(bg, folder_path / "ic_launcher_background.png", dry_run)
        save_png(fg, folder_path / "ic_launcher_foreground.png", dry_run)

    anydpi = res_dir / "mipmap-anydpi-v26"
    save_xml(anydpi / "ic_launcher.xml", launcher_xml(), dry_run)
    save_xml(anydpi / "ic_launcher_round.xml", launcher_xml(), dry_run)

    if play_store_icon is not None and not play_store_icon_matches_source:
        play = contain(src, 512, legacy_scale, background).convert("RGB")
        save_png(play, play_store_icon, dry_run)
    elif play_store_icon is not None:
        print(f"play store icon source already matches output: {play_store_icon}")


def generate_icons(
    source: Path,
    res_dir: Path,
    play_store_icon: Path | None,
    background: tuple[int, int, int, int],
    legacy_scale: float,
    adaptive_foreground_scale: float,
    dry_run: bool,
) -> None:
    if not source.exists():
        raise SystemExit(f"source image not found: {source}")

    generate_icon_assets(
        src=Image.open(source).convert("RGBA"),
        res_dir=res_dir,
        play_store_icon=play_store_icon,
        background=background,
        legacy_scale=legacy_scale,
        adaptive_foreground_scale=adaptive_foreground_scale,
        dry_run=dry_run,
        play_store_icon_matches_source=play_store_icon is not None and source.resolve() == play_store_icon.resolve(),
    )


def scale_arg(value: str) -> float:
    parsed = float(value)
    if parsed <= 0 or parsed > 1:
        raise argparse.ArgumentTypeError("scale must be > 0 and <= 1")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate Android launcher icon resources from a repo-local source image. "
            "Pass an Image2 output with --source to update launcher assets and the Play icon together."
        )
    )
    parser.add_argument(
        "--source",
        default=DEFAULT_SOURCE,
        type=resolve,
        help=f"source PNG/JPG, default: {DEFAULT_SOURCE.relative_to(ROOT)}",
    )
    parser.add_argument(
        "--persona",
        type=resolve,
        help="persona.json input; reads iconEmoji and tint, then generates launcher and Play icons",
    )
    parser.add_argument(
        "--res-dir",
        default=DEFAULT_RES_DIR,
        type=resolve,
        help=f"Android res directory, default: {DEFAULT_RES_DIR.relative_to(ROOT)}",
    )
    parser.add_argument(
        "--play-store-icon",
        default=DEFAULT_PLAY_ICON,
        type=resolve,
        help=(
            "optional 512x512 Play icon output; skipped automatically when it is also --source. "
            f"default: {DEFAULT_PLAY_ICON.relative_to(ROOT)}"
        ),
    )
    parser.add_argument(
        "--skip-play-store-icon",
        action="store_true",
        help="only update app launcher resources",
    )
    parser.add_argument(
        "--background",
        default="#111827",
        type=parse_color,
        help="solid icon background color, default: #111827",
    )
    parser.add_argument(
        "--legacy-scale",
        default=0.82,
        type=scale_arg,
        help="source image scale inside legacy and Play icons, default: 0.82",
    )
    parser.add_argument(
        "--adaptive-foreground-scale",
        default=0.68,
        type=scale_arg,
        help="source image scale inside adaptive foreground layer, default: 0.68",
    )
    parser.add_argument("--dry-run", action="store_true", help="print outputs without writing files")
    return parser


def main(argv: Iterable[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    play_store_icon = None if args.skip_play_store_icon else args.play_store_icon
    if args.persona:
        src, background = persona_icon(load_persona(args.persona))
        generate_icon_assets(
            src=src,
            res_dir=args.res_dir,
            play_store_icon=play_store_icon,
            background=background,
            legacy_scale=1.0 if args.legacy_scale == 0.82 else args.legacy_scale,
            adaptive_foreground_scale=args.adaptive_foreground_scale,
            dry_run=args.dry_run,
        )
    else:
        generate_icons(
            source=args.source,
            res_dir=args.res_dir,
            play_store_icon=play_store_icon,
            background=args.background,
            legacy_scale=args.legacy_scale,
            adaptive_foreground_scale=args.adaptive_foreground_scale,
            dry_run=args.dry_run,
        )


if __name__ == "__main__":
    main()
