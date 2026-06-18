# EClaw Desktop Icons

This directory must contain the following icon files before building:

| File | Format | Size | Description |
|------|--------|-------|-------------|
| `32x32.png` | PNG | 32×32 | Taskbar icon |
| `128x128.png` | PNG | 128×128 | App icon |
| `128x128@2x.png` | PNG | 256×256 | Retina app icon |
| `icon.icns` | ICNS | — | macOS app icon |
| `icon.ico` | ICO | — | Windows app icon |

## Generating icons

```bash
# Using tauri icon generator (once you have a source image):
cd ../..
npx tauri icon path/to/source-image.png

# Or generate manually with ImageMagick:
convert source.png -resize 32x32 icons/32x32.png
convert source.png -resize 128x128 icons/128x128.png
convert source.png -resize 256x256 icons/128x128@2x.png
```

The `icon.icns` and `icon.ico` files can be generated from the 256×256 PNG using:
- macOS: `png2icns icon.icns 128x128@2x.png`
- Windows: `png2ico icon.ico 128x128@2x.png`
