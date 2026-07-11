#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RAW_DIR = Path(os.environ.get("ECLAW_ANDROID_STORE_RAW_DIR", "/tmp/eclaw-android-store/raw"))
DEFAULT_OUT_DIR = Path(os.environ.get("ECLAW_ANDROID_STORE_OUT_DIR", "/tmp/eclaw-android-store/final-play-1080x1920"))
DEFAULT_BACKGROUND_DIR = ROOT / "docs/android-play-screenshots/image2-backgrounds"

W, H = 1080, 1920
PHONE_W, PHONE_H = 560, 1210

FONT_LATIN_BOLD = Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf")
FONT_LATIN = Path("/System/Library/Fonts/Supplemental/Arial.ttf")
FONT_CJK = Path("/System/Library/Fonts/STHeiti Medium.ttc")


@dataclass(frozen=True)
class Slide:
    slug: str
    sources: tuple[str, ...]
    title: str
    subtitle: str
    callouts: tuple[str, ...]
    accent: tuple[int, int, int]
    bg: tuple[str, ...] = ()
    phone_y: int = 520


SLIDES: tuple[Slide, ...] = (
    Slide(
        slug="live-usage-monitor",
        sources=("01-live-usage-monitor.png", "01-home-dashboard.png", "01-home.png"),
        title="Live Usage Monitor\n即時用量監控",
        subtitle="Track, optimize, and keep every agent in sync.",
        callouts=("Codex usage", "Project tokens", "Weekly totals", "Realtime sync"),
        accent=(31, 229, 255),
        bg=("01-live-usage-monitor.png", "01-command-center.png"),
    ),
    Slide(
        slug="companion-appearance",
        sources=(
            "02-companion-appearance.png",
            "current-wallpaper-preview-after-scale-pref-collapsed.png",
            "02-companion-appearance-settings.png",
        ),
        title="Companion Appearance\n夥伴外觀系統",
        subtitle="Tune size, style, and wallpaper presence from the app.",
        callouts=("Pinch resize", "Wallpaper settings", "Usage overlay", "Personalized"),
        accent=(188, 90, 255),
        bg=("02-companion-appearance.png", "05-companion-appearance.png"),
    ),
    Slide(
        slug="permanent-memory-mindmap",
        sources=("03-permanent-memory-mindmap.png", "03-permanent-memory-mindmap-expanded.png", "mission-top-before-mind.png"),
        title="Permanent Memory Map\n永久記憶心智圖",
        subtitle="Organize, remember, and evolve long-running work.",
        callouts=("Layered context", "Long recall", "Memory graph", "Knowledge trails"),
        accent=(42, 246, 255),
        bg=("03-permanent-memory-mindmap.png", "02-org-hierarchy.png"),
    ),
    Slide(
        slug="agent-organization",
        sources=("04-agent-organization.png", "04-org-right-half-pan-left.png", "04-org-before-right-pan.png"),
        title="Agent Organization\nAgent 組織互動",
        subtitle="Build the hierarchy for routing and collaboration.",
        callouts=("Hierarchy", "Team routing", "Supervisor flow", "Autonomy"),
        accent=(119, 126, 255),
        bg=("04-agent-organization.png", "02-org-hierarchy.png"),
    ),
    Slide(
        slug="live-agent-chat",
        sources=("05-live-agent-chat.png", "05-live-agent-chat-with-dialog.png", "05-chat-companions-1-6-selected-bottom.png"),
        title="Live Agent Chat\n即時 Agent 對話",
        subtitle="One place for human and multi-agent coordination.",
        callouts=("1-1 or group chat", "Team replies", "Agent routing", "Recipients"),
        accent=(174, 100, 255),
        bg=("05-live-agent-chat.png", "04-chat-workflow.png"),
    ),
    Slide(
        slug="automated-kanban",
        sources=("06-automated-kanban.png",),
        title="Automated Kanban\n自動化看板任務",
        subtitle="Plan, automate, hand off, and review execution.",
        callouts=("Recurring tasks", "Timeline", "Agent handoff", "Review flow"),
        accent=(143, 90, 255),
        bg=("06-automated-kanban.png", "01-command-center.png"),
    ),
    Slide(
        slug="agent-hub-cards",
        sources=("07-agent-hub-cards.png",),
        title="Agent Hub & Cards\nAgent 名片與租借入口",
        subtitle="Build your agent network. Connect, share, collaborate.",
        callouts=("My agents", "Bot Plaza", "Agent cards", "Quick connect"),
        accent=(36, 224, 255),
        bg=("07-agent-hub-cards.png", "03-agent-cards.png"),
    ),
    Slide(
        slug="live-agent-wallpaper",
        sources=(
            "08-live-wallpaper-agents-real-bubble.png",
            "08-live-wallpaper-agents-real-broadcast-151-visible.png",
            "home-after-free-lobster-scale-half.png",
        ),
        title="Live Agent Wallpaper\n即時 Agent 桌布",
        subtitle="Real-time agents, broadcast state, and smart automation on the home screen.",
        callouts=("Broadcasts", "Home agents", "Task boards", "Usage monitor"),
        accent=(69, 234, 255),
        bg=("08-live-agent-wallpaper.png", "05-companion-appearance.png"),
        phone_y=520,
    ),
)


def font(path: Path, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [path, FONT_CJK, FONT_LATIN_BOLD, FONT_LATIN]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def text_size(draw: ImageDraw.ImageDraw, text: str, fnt: ImageFont.ImageFont, spacing: int = 8) -> tuple[int, int]:
    box = draw.multiline_textbbox((0, 0), text, font=fnt, spacing=spacing, stroke_width=2)
    return box[2] - box[0], box[3] - box[1]


def fit_font(text: str, max_width: int, start: int, minimum: int, preferred: Path) -> ImageFont.ImageFont:
    probe = Image.new("RGB", (10, 10))
    draw = ImageDraw.Draw(probe)
    for size in range(start, minimum - 1, -2):
        fnt = font(preferred, size)
        if text_size(draw, text, fnt)[0] <= max_width:
            return fnt
    return font(preferred, minimum)


def cover_resize(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_w, target_h = size
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    resized = img.resize((math.ceil(src_w * scale), math.ceil(src_h * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - target_w) // 2
    top = (resized.height - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


def generated_background(accent: tuple[int, int, int]) -> Image.Image:
    base_a = (6, 10, 22)
    base_b = (18, 20, 46)
    bg = Image.new("RGB", (W, H), base_a)
    pix = bg.load()
    for y in range(H):
        for x in range(W):
            t = (x / W * 0.28) + (y / H * 0.72)
            pix[x, y] = mix(base_a, base_b, t)

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")
    for x in range(0, W, 96):
        draw.line((x, 0, x - 360, H), fill=(*accent, 28), width=2)
    for y in range(120, H, 180):
        draw.line((0, y, W, y + 80), fill=(*accent, 20), width=2)
    for x in range(50, W, 170):
        for y in range(180, H, 260):
            draw.rounded_rectangle((x, y, x + 28, y + 28), radius=7, outline=(*accent, 45), width=2)
    layer = layer.filter(ImageFilter.GaussianBlur(0.2))
    bg = bg.convert("RGBA")
    bg.alpha_composite(layer)
    return bg.convert("RGB")


def background_for(slide: Slide, background_dir: Path | None) -> Image.Image:
    if background_dir is not None:
        for name in slide.bg:
            path = background_dir / name
            if path.exists():
                return cover_resize(Image.open(path).convert("RGB"), (W, H))
    return generated_background(slide.accent)


def find_source(slide: Slide, raw_dir: Path) -> Path:
    for name in slide.sources:
        path = raw_dir / name
        if path.exists():
            return path
    expected = ", ".join(slide.sources)
    raise FileNotFoundError(f"{slide.slug}: none of these raw screenshots exist in {raw_dir}: {expected}")


def draw_phone(base: Image.Image, screenshot: Image.Image, x: int, y: int) -> tuple[int, int, int, int]:
    outer_w = PHONE_W + 52
    outer_h = PHONE_H + 72
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow, "RGBA")
    sd.rounded_rectangle((x + 10, y + 18, x + outer_w + 10, y + outer_h + 18), radius=54, fill=(0, 0, 0, 170))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    base.alpha_composite(shadow)

    draw = ImageDraw.Draw(base, "RGBA")
    draw.rounded_rectangle((x, y, x + outer_w, y + outer_h), radius=56, fill=(5, 8, 18, 255), outline=(255, 255, 255, 100), width=3)
    screen_box = (x + 26, y + 36, x + 26 + PHONE_W, y + 36 + PHONE_H)
    mask = Image.new("L", (PHONE_W, PHONE_H), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, PHONE_W, PHONE_H), radius=34, fill=255)
    screen = cover_resize(screenshot.convert("RGB"), (PHONE_W, PHONE_H)).convert("RGBA")
    base.paste(screen, screen_box[:2], mask)

    notch_w, notch_h = 150, 28
    notch_x = x + outer_w // 2 - notch_w // 2
    draw.rounded_rectangle((notch_x, y + 43, notch_x + notch_w, y + 43 + notch_h), radius=14, fill=(0, 0, 0, 210))
    draw.rounded_rectangle(screen_box, radius=34, outline=(255, 255, 255, 55), width=2)
    return (x, y, x + outer_w, y + outer_h)


def draw_title(base: Image.Image, slide: Slide) -> None:
    draw = ImageDraw.Draw(base, "RGBA")
    title_font = fit_font(slide.title, 980, 68, 44, FONT_CJK)
    subtitle_font = font(FONT_LATIN, 28)

    tw, th = text_size(draw, slide.title, title_font, spacing=8)
    tx = (W - tw) // 2
    ty = 86
    draw.multiline_text(
        (tx, ty),
        slide.title,
        font=title_font,
        fill=(245, 250, 255, 255),
        spacing=8,
        align="center",
        stroke_width=2,
        stroke_fill=(*slide.accent, 160),
    )
    sw, _ = text_size(draw, slide.subtitle, subtitle_font, spacing=4)
    draw.text(((W - sw) // 2, ty + th + 18), slide.subtitle, font=subtitle_font, fill=(211, 220, 240, 235))

    draw.line((260, ty + th + 60, W - 260, ty + th + 60), fill=(*slide.accent, 220), width=3)


def draw_callouts(base: Image.Image, slide: Slide, phone_box: tuple[int, int, int, int]) -> None:
    draw = ImageDraw.Draw(base, "RGBA")
    small_font = font(FONT_LATIN, 18)
    left = slide.callouts[:2]
    right = slide.callouts[2:]
    rows = ((left, 36, phone_box[0], "left"), (right, W - 256, phone_box[2], "right"))

    for labels, x, phone_x, side in rows:
        for idx, label in enumerate(labels):
            y = 700 + idx * 280
            box = (x, y, x + 220, y + 94)
            draw.rounded_rectangle(box, radius=16, fill=(10, 16, 34, 218), outline=(*slide.accent, 210), width=2)
            dot = (x + 20, y + 28, x + 50, y + 58)
            draw.rounded_rectangle(dot, radius=8, fill=(*slide.accent, 200))
            label_font = fit_font(label, 142, 22, 15, FONT_CJK)
            label_w, label_h = text_size(draw, label, label_font, spacing=3)
            draw.multiline_text(
                (x + 64, y + 19 + max(0, 28 - label_h // 2)),
                label,
                font=label_font,
                fill=(240, 247, 255, 255),
                spacing=3,
                align="left",
            )
            draw.text((x + 64, y + 56), "EClawbot", font=small_font, fill=(*slide.accent, 230))
            if side == "left":
                draw.line((x + 220, y + 47, phone_x, y + 92), fill=(*slide.accent, 120), width=2)
            else:
                draw.line((x, y + 47, phone_x, y + 92), fill=(*slide.accent, 120), width=2)


def draw_footer(base: Image.Image, slide: Slide) -> None:
    draw = ImageDraw.Draw(base, "RGBA")
    font_small = font(FONT_LATIN_BOLD, 22)
    draw.rounded_rectangle((44, H - 112, W - 44, H - 42), radius=14, fill=(8, 14, 29, 215), outline=(*slide.accent, 120), width=1)
    draw.text((72, H - 88), "Always in sync. Always in control.", font=font_small, fill=(239, 244, 255, 245))
    draw.text((W - 220, H - 88), "SYNCED", font=font_small, fill=(*slide.accent, 255))
    draw.ellipse((W - 106, H - 90, W - 86, H - 70), fill=(*slide.accent, 255))


def render_slide(slide: Slide, raw_dir: Path, background_dir: Path | None, out_dir: Path, index: int) -> Path:
    raw = Image.open(find_source(slide, raw_dir)).convert("RGB")
    base = background_for(slide, background_dir).convert("RGBA")
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay, "RGBA")
    od.rectangle((0, 0, W, 430), fill=(0, 0, 0, 112))
    od.rectangle((0, 430, W, H), fill=(0, 0, 0, 42))
    base.alpha_composite(overlay)

    draw_title(base, slide)
    phone_x = (W - (PHONE_W + 52)) // 2
    phone_box = draw_phone(base, raw, phone_x, slide.phone_y)
    draw_callouts(base, slide, phone_box)
    draw_footer(base, slide)

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{index:02d}-{slide.slug}.png"
    base.convert("RGB").save(out, "PNG", optimize=True)
    return out


def contact_sheet(paths: list[Path], out: Path) -> None:
    thumb_w, thumb_h = 262, 466
    cols = 4
    label_h = 42
    gap = 14
    rows = math.ceil(len(paths) / cols)
    sheet = Image.new("RGB", (cols * thumb_w + (cols + 1) * gap, rows * (thumb_h + label_h) + (rows + 1) * gap), (16, 18, 28))
    draw = ImageDraw.Draw(sheet)
    label_font = font(FONT_LATIN, 16)
    for idx, path in enumerate(paths):
        row, col = divmod(idx, cols)
        x = gap + col * (thumb_w + gap)
        y = gap + row * (thumb_h + label_h + gap)
        draw.rounded_rectangle((x, y, x + thumb_w, y + label_h), radius=8, fill=(28, 32, 48))
        draw.text((x + 10, y + 13), path.stem, font=label_font, fill=(235, 240, 250))
        thumb = cover_resize(Image.open(path).convert("RGB"), (thumb_w, thumb_h))
        sheet.paste(thumb, (x, y + label_h))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, "PNG", optimize=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Build 1080x1920 Android Play Store screenshots from real emulator captures. "
            "Place Image2 background outputs in --background-dir using the slide slug names to use them."
        )
    )
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR, help=f"default: {DEFAULT_RAW_DIR}")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help=f"default: {DEFAULT_OUT_DIR}")
    parser.add_argument(
        "--background-dir",
        type=Path,
        default=DEFAULT_BACKGROUND_DIR,
        help=f"optional Image2 background directory, default: {DEFAULT_BACKGROUND_DIR.relative_to(ROOT)}",
    )
    parser.add_argument(
        "--no-background-dir",
        action="store_true",
        help="ignore Image2 backgrounds and use deterministic generated backgrounds",
    )
    parser.add_argument(
        "--contact-sheet",
        type=Path,
        help="contact sheet output; default is <out-dir>/../final-play-contact-sheet.png",
    )
    parser.add_argument("--only", action="append", help="render only a slide slug; may be passed more than once")
    return parser


def resolve(path: Path) -> Path:
    return path if path.is_absolute() else ROOT / path


def main(argv: Iterable[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    raw_dir = resolve(args.raw_dir)
    out_dir = resolve(args.out_dir)
    background_dir = None if args.no_background_dir else resolve(args.background_dir)
    if background_dir is not None and not background_dir.exists():
        background_dir = None

    wanted = set(args.only or [])
    slides = [slide for slide in SLIDES if not wanted or slide.slug in wanted]
    missing = wanted - {slide.slug for slide in SLIDES}
    if missing:
        raise SystemExit(f"unknown slide slug(s): {', '.join(sorted(missing))}")

    outputs: list[Path] = []
    for index, slide in enumerate(slides, start=1):
        outputs.append(render_slide(slide, raw_dir, background_dir, out_dir, index))
        print(f"wrote {outputs[-1]}")

    contact = resolve(args.contact_sheet) if args.contact_sheet else out_dir.parent / "final-play-contact-sheet.png"
    contact_sheet(outputs, contact)
    print(f"wrote {contact}")


if __name__ == "__main__":
    main()
