# EClawbot mobile installation icons

The H-free iOS App Store icon is `ios-app/assets/icon.png`. Its artwork was
visually matched to the public 1.0.1 App Store icon on 2026-10-07. The H-free
Android launcher and adaptive foreground images are preserved under
`branding/eclawbot/original/android/`. The Android adaptive backgrounds remain
unchanged in `app/src/main/res/mipmap-*/ic_launcher_background.png`.

`h-watermark-general-italic.png` is an exact copy of the selected general H
from `app-showcase-site/public/brand/` (SHA-256:
`29bb4c6f54024441b675d9f04233dc3dff2b78fbb08cd61581d61b9fa`).
Do not use a previously branded icon as an input.

Run `python3 scripts/brand_mobile_icons.py` to rebuild installation assets and
`python3 scripts/brand_mobile_icons.py --check` to verify the committed pixels.
The script checks that pixels outside each H placement match the original.
The iOS install icon is `ios-app/assets/icon-branded.png`, selected by
`ios-app/app.json`. Its login and notification artwork remain on the original.
Android launcher and round icons are generated at each resource density from
their own H-free original. The adaptive foreground receives the H over its
unchanged artwork background. Preview both Android circle and rounded masks
before release.

The H-free current Play listing icon was obtained from the official `zh-TW`
Google Play listing on 2026-10-07 and preserved as
`branding/eclawbot/original/play_store_icon_512.png`. The older
`google_play/play_store_icon_512.png` is different from that live icon. The
generated `google_play/play_store_icon_512-branded.png` is the listing asset
to upload with the Android release; preparing it does not change the store.

Hank's 2026-10-07 correction places the H in the lower-right safe area. These
reference coordinates describe the H image box `(x, y, width, height)`;
the transparent margin within the H asset makes its visible mark smaller:

| Asset | Canvas | H box | Right / bottom inset |
|---|---:|---:|---:|
| iOS AppIcon | 1024 | `(824, 742, 145, 152)` | 55 / 130 |
| Android legacy and round | 192 | `(124, 151, 23, 24)` | 45 / 17 |
| Android adaptive foreground | 432 | `(296, 194, 46, 48)` | 90 / 190 |
| Play listing | 512 | `(400, 400, 65, 68)` | 47 / 44 |

The Android boxes scale separately for each resource density. Their sizes
are smaller than 16% of the full canvas where the original lettering and
launcher masks leave less usable space. An adaptive layer is 108 dp; the
launcher exposes its central 72 dp, with an inner 66 dp safe region. The
adaptive H now sits to the right of the phone, below the right mascot, and
above the lettering. The rebuild script rejects any nontransparent H pixel
outside the conservative 66 dp safe circle at every resource density. The
previous `(292, 309, 50, 53)` candidate was clipped by the actual Android
launcher; its whole-canvas circle preview was invalid.

Release stages as of 2026-10-07: originals confirmed; source icons updated;
Android release AAB rebuilt and the corrected Android icon installed on an
emulator; the app also stayed on its dashboard for 10 seconds after dismissing
the emulator's notification prompt. The iOS production build 1.0.2 (14) and
installed iOS icon are unchanged. Android round PNG package bytes differ only
in fully transparent RGB and render identically. The iOS package export differs
from a Pillow resize; a matched H-free EAS simulator build shows that both
package sizes differ only inside the scaled H region, and production/simulator
candidate exports match each other. The main session's new icon evidence review
is pending. The Play listing asset is prepared but has not been uploaded. No
store submission or public release has occurred.
