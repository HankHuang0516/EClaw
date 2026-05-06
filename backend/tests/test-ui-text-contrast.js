#!/usr/bin/env node
/**
 * UI Text Contrast — Static Analysis Test
 *
 * Scans Android XML layouts for text input fields (EditText, TextInputEditText)
 * that might have invisible text due to poor contrast between text color and
 * background color.
 *
 * Detects:
 *   1. Input fields with light background but no explicit dark textColor
 *   2. Input fields with dark background but no explicit light textColor
 *   3. Input fields missing textColor entirely (relies on theme default which
 *      may conflict with a custom background)
 *
 * Regression for: chat input white-on-white text bug (2026-03-16)
 *
 * No credentials needed.
 *
 * Usage:
 *   node backend/tests/test-ui-text-contrast.js
 */

const fs = require('fs');
const path = require('path');

// ── Test Result Tracking ────────────────────────────────────
const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '✅' : '❌';
    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

// ── Color Definitions ───────────────────────────────────────

// Parse colors.xml to build a name→hex map
const COLORS_XML = path.resolve(__dirname, '../../app/src/main/res/values/colors.xml');
const ANDROID_COLORS = { 'white': '#FFFFFFFF', 'black': '#FF000000' };

function parseColorsXml(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const map = {};
    const re = /<color name="([^"]+)">([^<]+)<\/color>/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        map[m[1]] = m[2].toUpperCase();
    }
    return map;
}

const colorMap = { ...ANDROID_COLORS, ...parseColorsXml(COLORS_XML) };

// Resolve a color reference to a hex value
function resolveColor(ref) {
    if (!ref) return null;
    // Direct hex
    if (ref.startsWith('#')) return ref.toUpperCase();
    // @color/name
    const colorMatch = ref.match(/@color\/(.+)/);
    if (colorMatch && colorMap[colorMatch[1]]) return colorMap[colorMatch[1]];
    // @android:color/name
    const androidMatch = ref.match(/@android:color\/(.+)/);
    if (androidMatch && ANDROID_COLORS[androidMatch[1]]) return ANDROID_COLORS[androidMatch[1]];
    return null;
}

// Parse hex color to RGB (handles #AARRGGBB and #RRGGBB)
function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 8) hex = hex.substring(2); // Strip alpha
    if (hex.length === 6) {
        return {
            r: parseInt(hex.substring(0, 2), 16),
            g: parseInt(hex.substring(2, 4), 16),
            b: parseInt(hex.substring(4, 6), 16),
        };
    }
    return null;
}

// Relative luminance (WCAG 2.0)
function luminance(rgb) {
    const [rs, gs, bs] = [rgb.r, rgb.g, rgb.b].map(c => {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

// Contrast ratio (WCAG 2.0)
function contrastRatio(rgb1, rgb2) {
    const l1 = luminance(rgb1);
    const l2 = luminance(rgb2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

// Classify a color as light or dark based on luminance
function isLightColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    return luminance(rgb) > 0.4;
}

// ── Drawable Background Color Resolution ────────────────────

const DRAWABLE_DIR = path.resolve(__dirname, '../../app/src/main/res/drawable');

function resolveDrawableColor(bgRef) {
    // Direct color reference
    const resolved = resolveColor(bgRef);
    if (resolved) return resolved;

    // @drawable/name → look up the drawable XML for <solid> color
    const drawMatch = bgRef.match(/@drawable\/(.+)/);
    if (drawMatch) {
        const drawFile = path.join(DRAWABLE_DIR, `${drawMatch[1]}.xml`);
        if (fs.existsSync(drawFile)) {
            const content = fs.readFileSync(drawFile, 'utf8');
            const solidMatch = content.match(/android:color="([^"]+)"/);
            if (solidMatch) return resolveColor(solidMatch[1]) || solidMatch[1].toUpperCase();
        }
    }
    return null;
}

// ── Layout Scanner ──────────────────────────────────────────

const LAYOUT_DIR = path.resolve(__dirname, '../../app/src/main/res/layout');

// Dark theme default text color is white
const DARK_THEME_DEFAULT_TEXT = '#FFFFFFFF';

function scanLayouts() {
    if (!fs.existsSync(LAYOUT_DIR)) {
        console.log('⚠️  Layout directory not found, skipping scan');
        return;
    }

    const files = fs.readdirSync(LAYOUT_DIR).filter(f => f.endsWith('.xml'));
    const issues = [];

    for (const file of files) {
        const filePath = path.join(LAYOUT_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');

        // Find all EditText / TextInputEditText blocks
        // Match the opening tag and its attributes until />
        const editTextRe = /<(?:EditText|com\.google\.android\.material\.textfield\.TextInputEditText|com\.google\.android\.material\.textfield\.TextInputLayout)\b([^>]*?)\/>/gs;
        let match;

        while ((match = editTextRe.exec(content)) !== null) {
            const attrs = match[0];
            const id = (attrs.match(/android:id="@\+id\/([^"]+)"/) || [])[1] || 'unknown';

            // Extract attributes
            const bgRef = (attrs.match(/android:background="([^"]+)"/) || [])[1];
            const textColorRef = (attrs.match(/android:textColor="([^"]+)"/) || [])[1];
            const hintColorRef = (attrs.match(/android:textColorHint="([^"]+)"/) || [])[1];

            // Skip if no custom background (theme default handles it)
            if (!bgRef || bgRef.startsWith('?attr/')) continue;

            const bgHex = resolveDrawableColor(bgRef);
            if (!bgHex) continue; // Can't resolve, skip

            const bgIsLight = isLightColor(bgHex);
            if (bgIsLight === null) continue;

            // Determine effective text color
            const textHex = textColorRef ? resolveColor(textColorRef) : DARK_THEME_DEFAULT_TEXT;
            if (!textHex) continue;

            const textIsLight = isLightColor(textHex);
            if (textIsLight === null) continue;

            // Check contrast
            const bgRgb = hexToRgb(bgHex);
            const textRgb = hexToRgb(textHex);
            if (!bgRgb || !textRgb) continue;

            const ratio = contrastRatio(bgRgb, textRgb);

            // WCAG AA requires 4.5:1 for normal text, 3:1 for large text
            // We use 3:1 as minimum since input text can be large
            if (ratio < 3.0) {
                issues.push({
                    file,
                    id,
                    bgColor: bgHex,
                    textColor: textHex,
                    textColorExplicit: !!textColorRef,
                    ratio: ratio.toFixed(2),
                });
            }
        }
    }

    return issues;
}

// ── Specific Regression Check ───────────────────────────────

function checkChatInputFixed() {
    const chatLayout = path.join(LAYOUT_DIR, 'activity_chat.xml');
    if (!fs.existsSync(chatLayout)) {
        check('activity_chat.xml exists', false, 'File not found');
        return;
    }

    const content = fs.readFileSync(chatLayout, 'utf8');

    // The Android ChatActivity now hosts the canonical web chat UI in a WebView.
    // Older native layouts had @+id/editMessage; if that view is gone, verify the
    // WebView exists and let the full layout scanner cover all remaining native inputs.
    const editMsgMatch = content.match(/<(?:EditText|com\.google\.android\.material\.textfield\.TextInputEditText)\b[^>]*android:id="@\+id\/editMessage"[^>]*\/>/s);
    if (!editMsgMatch) {
        const hasWebChat = /<WebView\b[^>]*android:id="@\+id\/webViewChat"/s.test(content);
        check('chat input hosted by canonical WebView', hasWebChat,
            hasWebChat ? 'activity_chat.xml uses webViewChat; no native editMessage expected' : 'No editMessage or webViewChat found');
        return;
    }
    check('editMessage input found', true);

    const attrs = editMsgMatch[0];

    // Check it does NOT use bubble_received background
    const usesBubbleReceived = attrs.includes('bubble_received');
    check('editMessage does not use bubble_received bg', !usesBubbleReceived,
        usesBubbleReceived ? 'Still uses light bubble_received drawable' : 'Uses proper dark bg');

    // Check explicit textColor is set
    const hasTextColor = /android:textColor="/.test(attrs);
    check('editMessage has explicit textColor', hasTextColor,
        hasTextColor ? 'textColor is set' : 'Missing textColor — relies on theme default');

    // Check textColorHint is set
    const hasHintColor = /android:textColorHint="/.test(attrs);
    check('editMessage has explicit textColorHint', hasHintColor,
        hasHintColor ? 'textColorHint is set' : 'Missing textColorHint');

    // If we can resolve colors, check contrast
    const bgRef = (attrs.match(/android:background="([^"]+)"/) || [])[1];
    const textColorRef = (attrs.match(/android:textColor="([^"]+)"/) || [])[1];
    if (bgRef && textColorRef) {
        const bgHex = resolveDrawableColor(bgRef);
        const textHex = resolveColor(textColorRef);
        if (bgHex && textHex) {
            const bgRgb = hexToRgb(bgHex);
            const textRgb = hexToRgb(textHex);
            if (bgRgb && textRgb) {
                const ratio = contrastRatio(bgRgb, textRgb);
                check('editMessage contrast ratio >= 4.5:1', ratio >= 4.5,
                    `Ratio: ${ratio.toFixed(2)}:1 (bg: ${bgHex}, text: ${textHex})`);
            }
        }
    }
}

// ── Main ────────────────────────────────────────────────────

console.log('\n🎨 UI Text Contrast — Static Analysis\n');

console.log('1️⃣  Chat input regression check (activity_chat.xml):');
checkChatInputFixed();

console.log('\n2️⃣  Full layout scan for input contrast issues:');
const issues = scanLayouts();
if (issues && issues.length > 0) {
    for (const issue of issues) {
        check(
            `${issue.file} #${issue.id} contrast`,
            false,
            `Ratio ${issue.ratio}:1 (bg: ${issue.bgColor}, text: ${issue.textColor}${issue.textColorExplicit ? '' : ' [theme default]'})`
        );
    }
} else {
    check('No input contrast issues found', true, `Scanned ${fs.readdirSync(LAYOUT_DIR).filter(f => f.endsWith('.xml')).length} layout files`);
}

// ── Summary ─────────────────────────────────────────────────
console.log('\n──────────────────────────────────');
const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
console.log(`  Total: ${results.length}  |  ✅ ${passed}  |  ❌ ${failed}`);
if (failed > 0) {
    console.log('\n  Failed checks:');
    results.filter(r => !r.passed).forEach(r => console.log(`    - ${r.name}: ${r.detail}`));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
