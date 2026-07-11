# Android Play Screenshot Pipeline

This pipeline stages Android Play listing assets from real emulator captures and optional Image2 artwork.
It does not upload or edit Play Console state.

## 1. Capture real emulator screens

Navigate the Pixel emulator to the screen you want, then capture both the PNG and UIAutomator XML sidecar:

```bash
python3 scripts/capture_android_play_screenshot.py 01-live-usage-monitor --skip-launch
```

Useful variants:

```bash
python3 scripts/capture_android_play_screenshot.py 01-live-usage-monitor
python3 scripts/capture_android_play_screenshot.py 03-permanent-memory-mindmap --open-url 'eclawbot://mission/mindmap'
python3 scripts/capture_android_play_screenshot.py 08-live-wallpaper-agents-real-bubble --skip-launch
```

By default raw captures go to `/tmp/eclaw-android-store/raw`.

## 2. Add Image2 backgrounds

Use Image2 for decorative backgrounds only; keep the phone screenshots as real emulator captures.
Save selected Image2 outputs under:

```text
docs/android-play-screenshots/image2-backgrounds/
```

Name backgrounds after a slide slug when possible, for example:

```text
01-live-usage-monitor.png
02-companion-appearance.png
03-permanent-memory-mindmap.png
04-agent-organization.png
05-live-agent-chat.png
06-automated-kanban.png
07-agent-hub-cards.png
08-live-agent-wallpaper.png
```

Prompt pattern:

```text
Create a vertical 1080x1920 cybernetic app-store background for EClawbot.
Dark command-center interface mood, cyan and violet accent lighting, subtle circuit traces,
room for a centered phone screenshot, no text, no logos, no phone mockup, no UI labels.
```

## 3. Build Play screenshots

```bash
python3 scripts/create_android_play_assets.py \
  --raw-dir /tmp/eclaw-android-store/raw \
  --background-dir docs/android-play-screenshots/image2-backgrounds \
  --out-dir /tmp/eclaw-android-store/final-play-1080x1920
```

Outputs:

```text
/tmp/eclaw-android-store/final-play-1080x1920/*.png
/tmp/eclaw-android-store/final-play-contact-sheet.png
```

For deterministic backgrounds without Image2:

```bash
python3 scripts/create_android_play_assets.py --no-background-dir
```

## 4. Build Android icons

To regenerate launcher resources from the current Play icon:

```bash
python3 scripts/update_icons.py
```

To use a selected Image2 icon source:

```bash
python3 scripts/update_icons.py \
  --source docs/android-play-screenshots/image2-icon/icon-source.png
```

To generate icons from an I1 Expo persona export:

```bash
python3 scripts/update_icons.py \
  --persona path/to/persona.json
```

The persona input is a JSON object with `iconEmoji` and `tint` fields, for example
`{"name":"Codex","tint":"#22d3ee","iconEmoji":"C","systemPrompt":"..."}`.

The icon script writes Android launcher resources under `app/src/main/res/` and writes `google_play/play_store_icon_512.png` only when the source is a different file.

## Sample artifacts

Repo-visible samples are stored in:

```text
docs/android-play-screenshots/samples/
```

The samples include two 1080x1920 generated Play screenshots plus a contact sheet for visual review. They are examples of the deterministic pipeline output; fresh release screenshots should still be regenerated from current emulator raw captures.

## Validation

```bash
python3 -m py_compile \
  scripts/capture_android_play_screenshot.py \
  scripts/create_android_play_assets.py \
  scripts/update_icons.py

python3 scripts/create_android_play_assets.py \
  --raw-dir /tmp/eclaw-android-store/raw \
  --out-dir /tmp/eclaw-android-store/final-play-1080x1920
```
