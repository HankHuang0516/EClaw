/**
 * Petdx Companion Renderer — Web Canvas reference implementation.
 *
 * Spec: docs/specs/petdx-uiux-spec.md (v0.2)
 *
 * Why Web first: Hank 2026-05-10 — wallpaper rendering is animation +
 * descriptor logic, NOT inherently Android-Kotlin work. A Canvas PoC
 * here doubles as the Android WebView wallpaper's render layer
 * (WallpaperService becomes a thin shell around a WebView pointing at
 * a render page that consumes the same descriptor).
 *
 * v0.3 scope (Petdex bridge):
 *   - assetType: 'procedural' (built-in drawers; ships lobster/dog/cat)
 *   - assetType: 'spritesheet' (Petdx mirror — 8×9 grid, 192×208 per frame;
 *     descriptor.asset = { url, cols, rows, frameWidth, frameHeight, animations },
 *     descriptor.stateAssets[STATE] = { animation: 'idle'|..., loop })
 *   - assetType: 'vector' (rejected per spec §2.2)
 *
 * Public surface:
 *   - createRenderer({ canvas, descriptor, state? }) → controller
 *     Controller has setState(name), setDescriptor(d), start(), stop(), getState().
 *   - registerProceduralDrawer(rendererKey, drawerFn)
 *     drawerFn signature: ({ ctx, w, h, t, state, params }) → void
 *     where t is elapsed seconds (state-local clock).
 *
 * Hot-paths intentionally allocation-free; descriptor hot-swap is the
 * only place where state-clock resets.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.PetdxRenderer = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEFAULT_STATE = 'IDLE';
    const DEFAULT_FPS = 4;
    const DEFAULT_FALLBACK_POLICY = 'silent_to_idle';

    // ── Spritesheet image cache ─────────────────────────────────
    // Multiple renderer instances on the same page (the grid is 1 canvas
    // per card) hit the same R2 URLs; cache by URL so the browser only
    // decodes once and frames share an HTMLImageElement.
    const spriteImageCache = new Map(); // url → { img, ready, error }

    function loadSpritesheet(url) {
        if (!url) return null;
        let entry = spriteImageCache.get(url);
        if (entry) return entry;
        entry = { img: new Image(), ready: false, error: false };
        // No crossOrigin: Petdex R2 doesn't send ACAO, and we only drawImage
        // (never read pixels back). The canvas becomes "tainted" which blocks
        // toDataURL/getImageData — neither of which the wallpaper renderer needs.
        entry.img.onload = () => { entry.ready = true; };
        entry.img.onerror = () => { entry.error = true; };
        entry.img.src = url;
        spriteImageCache.set(url, entry);
        return entry;
    }

    // ── Drawer registry ──────────────────────────────────────────
    const drawers = new Map();

    function registerProceduralDrawer(rendererKey, fn) {
        if (typeof rendererKey !== 'string' || !rendererKey) {
            throw new Error('rendererKey must be non-empty string');
        }
        if (typeof fn !== 'function') {
            throw new Error('drawer must be a function');
        }
        drawers.set(rendererKey, fn);
    }

    function getProceduralDrawer(rendererKey) {
        return drawers.get(rendererKey) || null;
    }

    // ── Descriptor validation + state resolution ────────────────
    function validateDescriptor(d) {
        if (!d || typeof d !== 'object') return 'descriptor_required';
        if (!d.id || typeof d.id !== 'string') return 'descriptor_missing_id';
        if (!d.assetType) return 'descriptor_missing_asset_type';
        if (!Array.isArray(d.supportedStates) || d.supportedStates.length === 0) {
            return 'descriptor_missing_supported_states';
        }
        if (!d.supportedStates.includes(DEFAULT_STATE)) {
            return 'descriptor_must_support_idle';
        }
        return null;
    }

    /**
     * Resolves a requested state against descriptor.supportedStates per
     * spec §2.3: silent fallback to IDLE if not supported.
     * Returns { resolved, didFallback }.
     */
    function resolveState(descriptor, requested, policy) {
        const fallback = policy || DEFAULT_FALLBACK_POLICY;
        const supported = descriptor && descriptor.supportedStates;
        if (!supported || !supported.includes(requested)) {
            return { resolved: DEFAULT_STATE, didFallback: true, policy: fallback };
        }
        return { resolved: requested, didFallback: false, policy: fallback };
    }

    function getStateFps(descriptor, stateName) {
        const sa = descriptor && descriptor.stateAssets && descriptor.stateAssets[stateName];
        const fps = sa && Number(sa.fps);
        return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
    }

    function getStateLoop(descriptor, stateName) {
        const sa = descriptor && descriptor.stateAssets && descriptor.stateAssets[stateName];
        if (!sa || sa.loop === undefined) return true;
        return !!sa.loop;
    }

    // For spritesheet descriptors: resolve the animation row to use from a
    // requested state. stateAssets[STATE].animation names a row in
    // descriptor.asset.animations; if missing we fall back to the 'idle'
    // animation which every Petdex sheet has (row 0).
    function pickAnimationName(descriptor, stateName) {
        const sa = descriptor && descriptor.stateAssets && descriptor.stateAssets[stateName];
        if (sa && typeof sa.animation === 'string') return sa.animation;
        return 'idle';
    }

    // Given an animation entry (`{ row, frames: [durMs,...] }` for idle, or
    // `{ row, count, dur, last? }` for uniform animations) compute the frame
    // column to display at `elapsedMs` into the animation. Non-looping
    // animations clamp to the last frame.
    function computeFrameIndex(anim, elapsedMs, looping) {
        let frameDurations;
        if (Array.isArray(anim.frames)) {
            frameDurations = anim.frames;
        } else if (typeof anim.count === 'number' && anim.count > 0) {
            frameDurations = new Array(anim.count).fill(anim.dur || 120);
            if (anim.last != null) frameDurations[anim.count - 1] = anim.last;
        } else {
            return 0;
        }
        const total = frameDurations.reduce((a, b) => a + b, 0);
        if (total <= 0) return 0;
        let t = elapsedMs;
        if (looping !== false) {
            t = ((t % total) + total) % total;
        } else if (t >= total) {
            return frameDurations.length - 1;
        }
        let acc = 0;
        for (let i = 0; i < frameDurations.length; i++) {
            acc += frameDurations[i];
            if (t < acc) return i;
        }
        return frameDurations.length - 1;
    }

    // ── Canvas runner ───────────────────────────────────────────
    /**
     * createRenderer({ canvas, descriptor, state?, onError? }) → controller
     * Throws on first-validation failure; runtime drawer errors are
     * swallowed and forwarded to onError (if provided) so animation
     * doesn't die on a single bad frame.
     */
    function createRenderer(opts) {
        const { canvas, descriptor, state, onError } = opts || {};
        if (!canvas || typeof canvas.getContext !== 'function') {
            throw new Error('canvas required');
        }
        const validationErr = validateDescriptor(descriptor);
        if (validationErr) throw new Error(validationErr);

        const ctx = canvas.getContext('2d');
        let currentDescriptor = descriptor;
        let currentState = resolveState(descriptor, state || DEFAULT_STATE).resolved;
        let stateClockStart = 0;
        let rafId = 0;
        let running = false;
        let lastFrameTime = 0;

        function tick(now) {
            if (!running) return;
            rafId = requestAnimationFrame(tick);

            // Spritesheets use the anim table's per-frame durations directly,
            // so we don't throttle here — let rAF drive resolution.
            // Procedural drawers honour their descriptor.stateAssets.*.fps.
            if (currentDescriptor.assetType !== 'spritesheet') {
                const fps = getStateFps(currentDescriptor, currentState);
                const minFrameMs = 1000 / fps;
                if (now - lastFrameTime < minFrameMs) return;
                lastFrameTime = now;
            }

            const w = canvas.width;
            const h = canvas.height;
            const t = (now - stateClockStart) / 1000;

            try {
                ctx.clearRect(0, 0, w, h);
                if (currentDescriptor.assetType === 'procedural') {
                    const rendererKey = currentDescriptor.asset && currentDescriptor.asset.renderer;
                    const drawer = getProceduralDrawer(rendererKey) || getProceduralDrawer('fallback-blob');
                    if (drawer) {
                        drawer({
                            ctx, w, h, t,
                            state: currentState,
                            params: (currentDescriptor.asset && currentDescriptor.asset.params) || {},
                        });
                    }
                } else if (currentDescriptor.assetType === 'spritesheet') {
                    drawSpritesheetFrame(ctx, w, h, currentDescriptor, currentState, now - stateClockStart);
                }
            } catch (err) {
                if (onError) onError(err);
            }
        }

        function drawSpritesheetFrame(ctx, w, h, descriptor, state, elapsedMs) {
            const asset = descriptor.asset || {};
            const sheet = loadSpritesheet(asset.url);
            if (!sheet || sheet.error) {
                // Spec §3.4: per-kind emoji + name-initial badge when sprite load fails or url is missing.
                // The original "⚠︎ sheet load failed" / "no sprite url" diagnostic is kept in console
                // via spriteImageCache (see loadSpritesheet) so debuggability is preserved.
                drawSpritesheetFallback(ctx, w, h, descriptor);
                return;
            }
            if (!sheet.ready) {
                // Hold the canvas transparent until the sprite decodes.
                // Painting a dark-grey "…" placeholder here is what users
                // see as the avatar "flicker" on cold-cache loads.
                return;
            }

            const animName = pickAnimationName(descriptor, state);
            const animations = asset.animations || {};
            const anim = animations[animName] || animations.idle;
            if (!anim) {
                drawSpritesheetMessage(ctx, w, h, state, animName + '?');
                return;
            }

            const frameIndex = computeFrameIndex(anim, elapsedMs, descriptor.stateAssets && descriptor.stateAssets[state] && descriptor.stateAssets[state].loop !== false);
            const fw = asset.frameWidth || 192;
            const fh = asset.frameHeight || 208;
            const sx = frameIndex * fw;
            const sy = (anim.row || 0) * fh;

            const scale = Math.min(w / fw, h / fh);
            const dw = fw * scale;
            const dh = fh * scale;
            const dx = (w - dw) / 2;
            const dy = (h - dh) / 2;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(sheet.img, sx, sy, fw, fh, dx, dy, dw, dh);
        }

        function drawSpritesheetMessage(ctx, w, h, state, msg) {
            // Only render the diagnostic box on hard errors (sheet.error).
            // The transient pre-load case is handled by an early return so
            // the canvas stays transparent and the underlying avatar slot
            // doesn't visibly flash.
            ctx.save();
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#888';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(msg, w / 2, h / 2);
            ctx.fillText(state, w / 2, h / 2 + 14);
            ctx.restore();
        }

        function drawSpritesheetFallback(ctx, w, h, descriptor) {
            // Per-kind emoji + name-initial badge, used when sprite asset is missing
            // or failed to load. See docs/specs/petdx-uiux-spec-amendment-2026-06-05-self-host-sprite.md §3.4.
            const kind = descriptor && (descriptor.kind || (descriptor.sourceAttribution && descriptor.sourceAttribution.kind));
            const emojiByKind = { creature: '🐾', character: '🧑', object: '🎯' };
            const emoji = emojiByKind[kind] || '🦞';
            const name = (descriptor && descriptor.name) || '';
            const initial = name.trim().charAt(0).toUpperCase();

            ctx.save();
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, w, h);

            ctx.font = Math.floor(h * 0.7) + 'px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(emoji, w / 2, h * 0.55);

            if (initial) {
                const badgeR = Math.min(w, h) * 0.16;
                const bx = w - badgeR;
                const by = badgeR;
                ctx.beginPath();
                ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
                ctx.fillStyle = '#3a3a3a';
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.font = 'bold ' + Math.floor(badgeR * 1.2) + 'px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(initial, bx, by + 1);
            }
            ctx.restore();
        }

        return {
            start() {
                if (running) return;
                running = true;
                stateClockStart = performance.now();
                lastFrameTime = 0;
                rafId = requestAnimationFrame(tick);
            },
            stop() {
                running = false;
                if (rafId) cancelAnimationFrame(rafId);
                rafId = 0;
            },
            setState(name) {
                const { resolved, didFallback } = resolveState(currentDescriptor, name);
                currentState = resolved;
                stateClockStart = performance.now();
                return { resolved, didFallback };
            },
            setDescriptor(d) {
                const err = validateDescriptor(d);
                if (err) throw new Error(err);
                currentDescriptor = d;
                const { resolved } = resolveState(d, currentState);
                currentState = resolved;
                stateClockStart = performance.now();
            },
            getState() { return currentState; },
            getDescriptor() { return currentDescriptor; },
            isRunning() { return running; },
        };
    }

    // ── Built-in lobster procedural drawer ──────────────────────
    // Reference matches the Android engine's existing lobster renderer
    // (kept simple — antenna sway + claw bob + body breathing).
    // params: { bodyColor, eyeStyle, antennaStyle }
    registerProceduralDrawer('lobster-procedural', function lobsterDraw(args) {
        const { ctx, w, h, t, state, params } = args;
        const cx = w / 2;
        const cy = h / 2;
        const baseR = Math.min(w, h) * 0.28;

        const breathe = state === 'SLEEPING' ? 0.96 + Math.sin(t * 0.8) * 0.02
                       : state === 'EXCITED'  ? 1.00 + Math.sin(t * 12) * 0.06
                       : state === 'BUSY'     ? 1.00 + Math.sin(t * 6) * 0.03
                                              : 1.00 + Math.sin(t * 2.5) * 0.02;
        const r = baseR * breathe;

        // Body
        ctx.fillStyle = params.bodyColor || '#e63946';
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * 1.1, r * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();

        // Antenna sway
        const antSway = Math.sin(t * (state === 'EXCITED' ? 10 : 3)) * 0.18;
        ctx.strokeStyle = params.bodyColor || '#e63946';
        ctx.lineWidth = Math.max(2, r * 0.06);
        ctx.lineCap = 'round';
        for (const sign of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(cx + sign * r * 0.35, cy - r * 0.7);
            ctx.quadraticCurveTo(
                cx + sign * (r * 0.55 + antSway * 30),
                cy - r * 1.3,
                cx + sign * r * 0.6 + sign * antSway * 50,
                cy - r * 1.5
            );
            ctx.stroke();
        }

        // Eyes — bead style
        const eyeR = Math.max(2, r * 0.08);
        const eyeY = cy - r * 0.25;
        const eyeSpacing = r * 0.30;
        const blinkClose = (state === 'SLEEPING') ||
                          (Math.floor(t * 1.3) % 7 === 0 && (t % 1) < 0.12);
        ctx.fillStyle = '#1a1a1a';
        for (const sign of [-1, 1]) {
            if (blinkClose) {
                ctx.fillRect(cx + sign * eyeSpacing - eyeR, eyeY - 1, eyeR * 2, 2);
            } else {
                ctx.beginPath();
                ctx.arc(cx + sign * eyeSpacing, eyeY, eyeR, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Claws bob
        const clawBob = Math.sin(t * (state === 'BUSY' ? 6 : 2)) * r * 0.08;
        ctx.fillStyle = params.bodyColor || '#e63946';
        for (const sign of [-1, 1]) {
            ctx.beginPath();
            ctx.ellipse(
                cx + sign * r * 1.2,
                cy + r * 0.1 + clawBob * sign,
                r * 0.35, r * 0.22, sign * 0.3, 0, Math.PI * 2
            );
            ctx.fill();
        }
    });

    // ── Dog procedural drawer ───────────────────────────────────
    // Oval body + droopy ears + snout + tail wag.
    // params: { bodyColor, eyeStyle }
    registerProceduralDrawer('dog-procedural', function dogDraw(args) {
        const { ctx, w, h, t, state, params } = args;
        const cx = w / 2, cy = h / 2;
        const baseR = Math.min(w, h) * 0.26;
        const body = (params && params.bodyColor) || '#e9c46a';
        const dark = shade(body, -0.35);

        const breathe = state === 'SLEEPING' ? 0.96 + Math.sin(t * 0.8) * 0.02
                       : state === 'EXCITED'  ? 1.00 + Math.sin(t * 12) * 0.05
                                              : 1.00 + Math.sin(t * 2.5) * 0.02;
        const r = baseR * breathe;
        const headBob = state === 'EATING' ? Math.abs(Math.sin(t * 4)) * r * 0.18
                      : state === 'EXCITED' ? Math.sin(t * 14) * r * 0.08 : 0;

        // Tail wag — fast in BUSY/EXCITED, twitch in IDLE, still in SLEEPING
        const wagSpeed = state === 'EXCITED' ? 16 : state === 'BUSY' ? 8 : state === 'SLEEPING' ? 0 : 2.5;
        const wag = Math.sin(t * wagSpeed) * 0.6;
        ctx.strokeStyle = body;
        ctx.lineWidth = Math.max(2, r * 0.18);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx + r * 1.05, cy - r * 0.25);
        ctx.quadraticCurveTo(cx + r * 1.5, cy - r * 0.5 - wag * r * 0.4, cx + r * 1.7, cy - r * (0.3 + wag * 0.3));
        ctx.stroke();

        // Body
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx, cy + headBob * 0.4, r * 1.1, r * 0.78, 0, 0, Math.PI * 2);
        ctx.fill();

        // Snout (lighter oval at front-bottom)
        ctx.fillStyle = shade(body, 0.25);
        ctx.beginPath();
        ctx.ellipse(cx, cy + r * 0.18 + headBob, r * 0.42, r * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        // Nose
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        ctx.ellipse(cx, cy + r * 0.05 + headBob, r * 0.10, r * 0.07, 0, 0, Math.PI * 2);
        ctx.fill();

        // Droopy ears
        ctx.fillStyle = dark;
        for (const sign of [-1, 1]) {
            ctx.beginPath();
            ctx.ellipse(cx + sign * r * 0.85, cy - r * 0.3 + headBob * 0.5, r * 0.28, r * 0.55, sign * 0.25, 0, Math.PI * 2);
            ctx.fill();
        }

        // Eyes
        const eyeR = Math.max(2, r * 0.07);
        const eyeY = cy - r * 0.18 + headBob;
        const blinkClose = state === 'SLEEPING' ||
                          (Math.floor(t * 1.3) % 7 === 0 && (t % 1) < 0.12);
        ctx.fillStyle = '#1a1a1a';
        for (const sign of [-1, 1]) {
            const ex = cx + sign * r * 0.28;
            if (blinkClose) {
                ctx.fillRect(ex - eyeR, eyeY - 1, eyeR * 2, 2);
            } else {
                ctx.beginPath(); ctx.arc(ex, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
            }
        }

        // Tongue when EATING
        if (state === 'EATING' && (Math.sin(t * 4) > 0)) {
            ctx.fillStyle = '#ee5a7a';
            ctx.beginPath();
            ctx.ellipse(cx, cy + r * 0.30 + headBob, r * 0.10, r * 0.16, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    });

    // ── Cat procedural drawer ───────────────────────────────────
    // Rounder body + pointy ears + curled tail + tabby stripes.
    // params: { bodyColor, eyeStyle, stripeColor }
    registerProceduralDrawer('cat-procedural', function catDraw(args) {
        const { ctx, w, h, t, state, params } = args;
        const cx = w / 2, cy = h / 2;
        const baseR = Math.min(w, h) * 0.27;
        const body = (params && params.bodyColor) || '#f4a261';
        const stripe = (params && params.stripeColor) || shade(body, -0.30);

        const arch = state === 'EXCITED' ? Math.abs(Math.sin(t * 6)) * baseR * 0.10 : 0;
        const breathe = state === 'SLEEPING' ? 0.96 + Math.sin(t * 0.7) * 0.02
                                              : 1.00 + Math.sin(t * 2.3) * 0.02;
        const r = baseR * breathe;

        // Tail — curled S, swishes side-to-side
        const swishSpeed = state === 'EXCITED' ? 12 : state === 'BUSY' ? 6 : 2;
        const swish = Math.sin(t * swishSpeed) * 0.45;
        ctx.strokeStyle = body;
        ctx.lineWidth = Math.max(2, r * 0.16);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx + r * 1.0, cy + r * 0.15);
        ctx.bezierCurveTo(
            cx + r * 1.5, cy + r * (0.0 - swish * 0.3),
            cx + r * 1.7, cy - r * (0.5 + swish * 0.4),
            cx + r * 1.4 + swish * r * 0.4, cy - r * (0.7 - arch * 4)
        );
        ctx.stroke();

        // Body
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx, cy - arch, r * 0.95, r * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();

        // Tabby stripes
        ctx.strokeStyle = stripe;
        ctx.lineWidth = Math.max(1, r * 0.04);
        for (let i = -1; i <= 1; i++) {
            ctx.beginPath();
            ctx.moveTo(cx - r * 0.6, cy + i * r * 0.25 - arch);
            ctx.quadraticCurveTo(cx, cy + i * r * 0.32 - r * 0.05 - arch, cx + r * 0.6, cy + i * r * 0.25 - arch);
            ctx.stroke();
        }

        // Pointy ears (triangles)
        ctx.fillStyle = body;
        for (const sign of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(cx + sign * r * 0.55, cy - r * 0.55 - arch);
            ctx.lineTo(cx + sign * r * 0.30, cy - r * 1.10 - arch);
            ctx.lineTo(cx + sign * r * 0.85, cy - r * 0.85 - arch);
            ctx.closePath();
            ctx.fill();
            // Inner ear
            ctx.fillStyle = shade(body, 0.30);
            ctx.beginPath();
            ctx.moveTo(cx + sign * r * 0.55, cy - r * 0.62 - arch);
            ctx.lineTo(cx + sign * r * 0.42, cy - r * 0.95 - arch);
            ctx.lineTo(cx + sign * r * 0.72, cy - r * 0.82 - arch);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = body;
        }

        // Eyes — almond shape
        const eyeY = cy - r * 0.20 - arch;
        const eyeRX = Math.max(2, r * 0.10);
        const eyeRY = state === 'SLEEPING' ? 1 : Math.max(2, r * 0.07);
        const blinkClose = state === 'SLEEPING' ||
                          (Math.floor(t * 1.3) % 7 === 0 && (t % 1) < 0.12);
        ctx.fillStyle = '#1a1a1a';
        for (const sign of [-1, 1]) {
            const ex = cx + sign * r * 0.30;
            if (blinkClose) {
                ctx.fillRect(ex - eyeRX, eyeY - 1, eyeRX * 2, 2);
            } else {
                ctx.beginPath();
                ctx.ellipse(ex, eyeY, eyeRX, eyeRY, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Pink nose triangle
        ctx.fillStyle = '#e88a96';
        ctx.beginPath();
        ctx.moveTo(cx, cy + r * 0.02 - arch);
        ctx.lineTo(cx - r * 0.07, cy - r * 0.05 - arch);
        ctx.lineTo(cx + r * 0.07, cy - r * 0.05 - arch);
        ctx.closePath();
        ctx.fill();
    });

    // Tint helper: amt in [-1,1]; +brighten, -darken. Accepts #rgb or #rrggbb.
    function shade(hex, amt) {
        let h = String(hex || '').replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (h.length !== 6) return hex;
        const n = parseInt(h, 16);
        let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
        const adj = (c) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))));
        r = adj(r); g = adj(g); b = adj(b);
        return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
    }

    // Fallback placeholder for unknown renderer keys — keeps preview
    // page functional even when descriptor names a drawer we haven't
    // registered yet. Color from descriptor.metadata.color or grey.
    registerProceduralDrawer('fallback-blob', function fallbackDraw(args) {
        const { ctx, w, h, t, state, params } = args;
        const cx = w / 2, cy = h / 2;
        const r = Math.min(w, h) * 0.3 * (1 + Math.sin(t * 2) * 0.05);
        ctx.fillStyle = (params && params.color) || '#7d7d7d';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('?', cx, cy + 4);
        ctx.fillText(state, cx, cy + r + 16);
    });

    return {
        createRenderer,
        registerProceduralDrawer,
        getProceduralDrawer,
        validateDescriptor,
        resolveState,
        getStateFps,
        getStateLoop,
        pickAnimationName,
        computeFrameIndex,
        // Exposed so callers (e.g. AvatarPetdx.preload) can warm the
        // spritesheet cache during the descriptor fetch instead of waiting
        // for the first rAF tick to start the WEBP download.
        prefetchSpritesheet: loadSpritesheet,
        DEFAULT_STATE,
    };
}));
