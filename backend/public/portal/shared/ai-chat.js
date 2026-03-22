// ============================================
// E-Claw AI Chat Widget
// Floating chat button + expandable panel
// Loaded on all authenticated portal pages
// ============================================
(function () {
    'use strict';

    // ── Debug helper: logs to console + AndroidBridge.log + collects for API report ──
    const _debugLogs = [];
    function dbg(msg) {
        const line = '[AI Chat DBG] ' + msg;
        console.log(line);
        _debugLogs.push({ t: Date.now(), m: msg });
        try { if (typeof AndroidBridge !== 'undefined') AndroidBridge.log('DEBUG', line); } catch (_) {}
    }
    // Send collected debug logs silently to telemetry API (no visible UI)
    function flushDebugToServer() {
        if (_debugLogs.length === 0) return;
        const report = _debugLogs.map(l => '[' + new Date(l.t).toISOString() + '] ' + l.m).join('\n');
        // Collect comprehensive environment snapshot for remote diagnosis
        var scriptTags = [];
        try { document.querySelectorAll('script[src]').forEach(function(s) { scriptTags.push(s.src); }); } catch (_) {}
        const payload = {
            type: 'ai_chat_debug',
            data: {
                report: report,
                userAgent: navigator.userAgent,
                url: window.location.href,
                referrer: document.referrer || '',
                hasBridge: typeof AndroidBridge !== 'undefined',
                hasBlockFlag: !!window.__blockAiChatWidget,
                fabExists: !!document.getElementById('aiChatFab'),
                panelExists: !!document.getElementById('aiChatPanel'),
                debugMarkerExists: !!document.getElementById('aiChatDebugMarker'),
                readyState: document.readyState,
                scriptTags: scriptTags,
                cookieLen: (document.cookie || '').length,
                timestamp: new Date().toISOString()
            }
        };
        // Send via telemetry API (needs deviceId/deviceSecret from currentUser or AndroidBridge)
        let deviceId, deviceSecret;
        try {
            if (typeof AndroidBridge !== 'undefined') {
                deviceId = AndroidBridge.getDeviceId();
                deviceSecret = AndroidBridge.getDeviceSecret();
            } else if (window.currentUser) {
                deviceId = window.currentUser.deviceId;
                deviceSecret = window.currentUser.deviceSecret;
            }
        } catch (_) {}
        if (deviceId && deviceSecret) {
            fetch('/api/device-telemetry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId, deviceSecret, entries: [payload] })
            }).catch(() => {});
        }
        // Silent debug — no visible UI elements (telemetry only)
    }

    // Early exit if inline guard already detected Android WebView
    if (window.__blockAiChatWidget) {
        dbg('=== ai-chat.js BLOCKED by inline guard ===');
        flushDebugToServer();
        return;
    }

    dbg('=== ai-chat.js IIFE executing ===');
    dbg('typeof AndroidBridge: ' + (typeof AndroidBridge));
    dbg('UA: ' + (navigator.userAgent || '').substring(0, 250));
    dbg('Location: ' + window.location.href);
    dbg('typeof currentUser: ' + (typeof window.currentUser));

    const STORAGE_KEY = 'eclaw_ai_chat_history';
    const PENDING_KEY = 'eclaw_ai_chat_pending';
    const MAX_HISTORY = 20;
    const MAX_IMAGES = 3;
    const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB after compression
    const MAX_IMAGE_DIM = 1024; // max width/height for compression
    const POLL_INTERVAL = 3000; // 3 seconds
    const POLL_MAX_DURATION = 150000; // 2.5 minutes

    let chatHistory = [];
    let isOpen = false;
    let isLoading = false;
    let pendingImages = []; // { data: base64, mimeType: string }
    let pollTimer = null;

    // ── localStorage ──────────────────────────
    function loadHistory() {
        try {
            chatHistory = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
        } catch (_) { chatHistory = []; }
    }

    function saveHistory() {
        // Don't persist image data in localStorage (too large)
        const slim = chatHistory.slice(-MAX_HISTORY).map(m => ({
            role: m.role,
            content: m.content,
            imageCount: m.images ? m.images.length : undefined
        }));
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(slim)); }
        catch (_) {}
    }

    function getCurrentPage() {
        const m = window.location.pathname.match(/\/([^/]+)\.html/);
        return m ? m[1] : 'unknown';
    }

    // ── Image Utilities ──────────────────────
    function compressImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let { width, height } = img;
                    // Scale down if needed
                    if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
                        const ratio = Math.min(MAX_IMAGE_DIM / width, MAX_IMAGE_DIM / height);
                        width = Math.round(width * ratio);
                        height = Math.round(height * ratio);
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    // Use JPEG for photos, PNG for screenshots with transparency
                    const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                    const quality = mimeType === 'image/jpeg' ? 0.85 : undefined;
                    const dataUrl = canvas.toDataURL(mimeType, quality);
                    const base64 = dataUrl.split(',')[1];
                    // Check size
                    const byteSize = atob(base64).length;
                    if (byteSize > MAX_IMAGE_SIZE) {
                        // Retry with lower quality JPEG
                        const jpegUrl = canvas.toDataURL('image/jpeg', 0.6);
                        const jpegBase64 = jpegUrl.split(',')[1];
                        resolve({ data: jpegBase64, mimeType: 'image/jpeg' });
                    } else {
                        resolve({ data: base64, mimeType });
                    }
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    async function addImage(file) {
        if (pendingImages.length >= MAX_IMAGES) {
            if (typeof showToast === 'function') showToast(`Maximum ${MAX_IMAGES} images`, 'warn');
            return;
        }
        if (!file.type.startsWith('image/')) return;
        try {
            const compressed = await compressImage(file);
            pendingImages.push(compressed);
            renderImagePreview();
            updateSendButton();
        } catch (err) {
            console.error('[AI Chat] Image compression failed:', err);
        }
    }

    function removeImage(index) {
        pendingImages.splice(index, 1);
        renderImagePreview();
        updateSendButton();
    }

    function renderImagePreview() {
        const strip = document.getElementById('aiChatImagePreview');
        if (!strip) return;
        if (pendingImages.length === 0) {
            strip.style.display = 'none';
            strip.innerHTML = '';
            return;
        }
        strip.style.display = 'flex';
        strip.innerHTML = pendingImages.map((img, i) =>
            `<div class="ai-chat-img-thumb">
                <img src="data:${img.mimeType};base64,${img.data}" alt="Image ${i + 1}">
                <button class="ai-chat-img-remove" onclick="window._aiChatRemoveImage(${i})">&times;</button>
            </div>`
        ).join('');
    }

    function updateSendButton() {
        const input = document.getElementById('aiChatInput');
        const sendBtn = document.getElementById('aiChatSend');
        if (!input || !sendBtn) return;
        sendBtn.disabled = (!input.value.trim() && pendingImages.length === 0) || isLoading;
    }

    // ── Build DOM ─────────────────────────────
    function createWidget() {
        dbg('createWidget() called');
        // FAB
        const fab = document.createElement('button');
        fab.id = 'aiChatFab';
        fab.className = 'ai-chat-fab';
        fab.innerHTML = '<span class="ai-chat-fab-icon">\u{1F916}</span>';
        fab.title = 'AI Assistant';
        fab.addEventListener('click', toggleChat);

        // Panel
        const panel = document.createElement('div');
        panel.id = 'aiChatPanel';
        panel.className = 'ai-chat-panel';
        panel.style.display = 'none';
        panel.innerHTML = `
            <div class="ai-chat-header">
                <div class="ai-chat-header-left">
                    <span class="ai-chat-header-icon">\u{1F916}</span>
                    <span class="ai-chat-header-title">E-Claw AI</span>
                </div>
                <div class="ai-chat-header-right">
                    <button class="ai-chat-clear-btn" title="Clear history">\u{1F5D1}\uFE0F</button>
                    <button class="ai-chat-close-btn" title="Close">&times;</button>
                </div>
            </div>
            <div class="ai-chat-messages" id="aiChatMessages"></div>
            <div class="ai-chat-action-bar" id="aiChatActionBar" style="display:none"></div>
            <div class="ai-chat-img-preview" id="aiChatImagePreview" style="display:none"></div>
            <div class="ai-chat-input-area">
                <input type="file" id="aiChatFileInput" accept="image/*" multiple style="display:none">
                <button class="ai-chat-attach-btn" id="aiChatAttach" title="Attach image">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                    </svg>
                </button>
                <textarea id="aiChatInput" class="ai-chat-input" rows="1"
                          placeholder="Ask a question..." maxlength="2000"></textarea>
                <button id="aiChatSend" class="ai-chat-send-btn" disabled>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                    </svg>
                </button>
            </div>`;

        // Inject CSS for image features
        const style = document.createElement('style');
        style.textContent = `
            .ai-chat-attach-btn {
                background: none;
                border: none;
                color: var(--text-secondary, #888);
                cursor: pointer;
                padding: 4px;
                flex-shrink: 0;
                border-radius: 4px;
                transition: color 0.2s;
            }
            .ai-chat-attach-btn:hover { color: var(--primary, #7C4DFF); }
            .ai-chat-img-preview {
                display: flex;
                gap: 8px;
                padding: 8px 12px 0;
                flex-wrap: wrap;
            }
            .ai-chat-img-thumb {
                position: relative;
                width: 56px;
                height: 56px;
                border-radius: 8px;
                overflow: hidden;
                border: 1px solid var(--card-border, #333);
            }
            .ai-chat-img-thumb img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            .ai-chat-img-remove {
                position: absolute;
                top: 0;
                right: 0;
                background: rgba(0,0,0,0.7);
                color: #fff;
                border: none;
                width: 18px;
                height: 18px;
                font-size: 12px;
                line-height: 18px;
                text-align: center;
                cursor: pointer;
                border-radius: 0 0 0 6px;
                padding: 0;
            }
            .ai-chat-msg-images {
                display: flex;
                gap: 6px;
                margin-top: 6px;
                flex-wrap: wrap;
            }
            .ai-chat-msg-img {
                width: 80px;
                height: 80px;
                object-fit: cover;
                border-radius: 6px;
                border: 1px solid var(--card-border, #333);
                cursor: pointer;
            }
            .ai-chat-img-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.85);
                z-index: 100001;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
            }
            .ai-chat-img-overlay img {
                max-width: 90%;
                max-height: 90%;
                border-radius: 8px;
            }
            .ai-chat-busy-text {
                font-size: 12px;
                color: var(--text-secondary, #888);
                animation: ai-chat-pulse 1.5s ease-in-out infinite;
            }
            @keyframes ai-chat-pulse {
                0%, 100% { opacity: 0.6; }
                50% { opacity: 1; }
            }
        `;
        document.head.appendChild(style);

        document.body.appendChild(fab);
        document.body.appendChild(panel);

        // Events
        panel.querySelector('.ai-chat-close-btn').addEventListener('click', toggleChat);
        panel.querySelector('.ai-chat-clear-btn').addEventListener('click', () => {
            chatHistory = [];
            pendingImages = [];
            localStorage.removeItem(STORAGE_KEY);
            clearPending();
            isLoading = false;
            hideTyping();
            renderMessages();
            renderImagePreview();
        });

        const input = document.getElementById('aiChatInput');
        const sendBtn = document.getElementById('aiChatSend');
        const fileInput = document.getElementById('aiChatFileInput');
        const attachBtn = document.getElementById('aiChatAttach');

        input.addEventListener('input', () => {
            updateSendButton();
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 100) + 'px';
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!isLoading && (input.value.trim() || pendingImages.length > 0)) sendMessage();
            }
        });

        // Paste image from clipboard
        input.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) addImage(file);
                    return;
                }
            }
        });

        // File input change
        fileInput.addEventListener('change', () => {
            for (const file of fileInput.files) {
                addImage(file);
            }
            fileInput.value = '';
        });

        // Attach button
        attachBtn.addEventListener('click', () => fileInput.click());

        sendBtn.addEventListener('click', sendMessage);

        // Expose remove helper for inline onclick
        window._aiChatRemoveImage = removeImage;

        renderMessages();
    }

    // ── Toggle ────────────────────────────────
    function toggleChat() {
        isOpen = !isOpen;
        const panel = document.getElementById('aiChatPanel');
        const fab = document.getElementById('aiChatFab');
        if (isOpen) {
            panel.style.display = 'flex';
            fab.classList.add('ai-chat-fab-hidden');
            document.getElementById('aiChatInput').focus();
            scrollToBottom();
        } else {
            panel.style.display = 'none';
            fab.classList.remove('ai-chat-fab-hidden');
        }
    }

    // ── Render ─────────────────────────────────
    function renderMessages() {
        const container = document.getElementById('aiChatMessages');
        if (!container) return;
        container.innerHTML = '';

        if (chatHistory.length === 0) {
            container.innerHTML = `
                <div class="ai-chat-welcome">
                    <div class="ai-chat-welcome-icon">\u{1F99E}</div>
                    <div class="ai-chat-welcome-text">Hi! I'm E-Claw AI. Ask me anything about the platform.</div>
                </div>`;
            return;
        }

        for (const msg of chatHistory) {
            const div = document.createElement('div');
            div.className = 'ai-chat-msg ai-chat-msg-' + msg.role;

            if (msg.role === 'user') {
                let html = escapeHtml(msg.content);
                // Show image thumbnails if this message had images
                if (msg.images && msg.images.length > 0) {
                    html += '<div class="ai-chat-msg-images">';
                    for (const img of msg.images) {
                        html += `<img class="ai-chat-msg-img" src="data:${img.mimeType};base64,${img.data}" onclick="window._aiChatZoomImage(this.src)">`;
                    }
                    html += '</div>';
                } else if (msg.imageCount) {
                    html += `<div class="ai-chat-msg-images" style="color:var(--text-secondary,#888);font-size:12px;">[${msg.imageCount} image(s) attached]</div>`;
                }
                div.innerHTML = html;
            } else {
                div.innerHTML = renderMarkdown(msg.content);
            }
            container.appendChild(div);
        }
    }

    // Image zoom overlay
    window._aiChatZoomImage = function (src) {
        const overlay = document.createElement('div');
        overlay.className = 'ai-chat-img-overlay';
        overlay.innerHTML = `<img src="${src}">`;
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    };

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function renderMarkdown(text) {
        if (!text) return '';
        let h = escapeHtml(text);
        h = h.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        h = h.replace(/`([^`]+)`/g, '<code class="ai-chat-inline-code">$1</code>');
        h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        h = h.replace(/\n/g, '<br>');
        return h;
    }

    function scrollToBottom() {
        const c = document.getElementById('aiChatMessages');
        if (c) setTimeout(() => { c.scrollTop = c.scrollHeight; }, 50);
    }

    function showTyping() {
        const c = document.getElementById('aiChatMessages');
        const d = document.createElement('div');
        d.className = 'ai-chat-msg ai-chat-msg-assistant ai-chat-typing';
        d.id = 'aiChatTyping';
        d.innerHTML = '<span class="ai-chat-dot"></span><span class="ai-chat-dot"></span><span class="ai-chat-dot"></span>';
        c.appendChild(d);
        scrollToBottom();
    }

    function hideTyping() {
        const el = document.getElementById('aiChatTyping');
        if (el) el.remove();
    }

    // ── Send (async submit + polling) ─────────

    async function sendMessage() {
        const input = document.getElementById('aiChatInput');
        const text = input.value.trim();
        if ((!text && pendingImages.length === 0) || isLoading) return;
        console.log('[AI Chat] sendMessage() called, text:', text, 'images:', pendingImages.length);

        // Capture images before clearing
        const images = pendingImages.length > 0 ? [...pendingImages] : undefined;

        chatHistory.push({ role: 'user', content: text || '(image)', images });
        saveHistory();
        renderMessages();
        scrollToBottom();

        // Clear input
        input.value = '';
        input.style.height = 'auto';
        pendingImages = [];
        renderImagePreview();
        updateSendButton();
        isLoading = true;
        showTyping();

        if (images) {
            updateTypingText(i18n.t('ai_chat_uploading') || 'Uploading image(s)...');
        }

        // Generate requestId before fetch (survives page refresh)
        const requestId = crypto.randomUUID();
        try {
            localStorage.setItem(PENDING_KEY, JSON.stringify({ requestId, sentAt: Date.now() }));
        } catch (_) {}

        // Auto-inject device context on first message (empty history) so AI knows who the user is
        let messageForApi = text || '(user attached image(s) \u2014 please analyze them)';
        const historyForApi = chatHistory.slice(-MAX_HISTORY).map(m => ({
            role: m.role,
            content: m.content
        }));
        if (historyForApi.length <= 1 && window.currentUser) {
            const u = window.currentUser;
            const ctxParts = [];
            if (u.deviceId) ctxParts.push('Device ID: ' + u.deviceId);
            if (u.deviceSecret) ctxParts.push('Device Secret: ' + u.deviceSecret);
            if (u.email) ctxParts.push('Email: ' + u.email);
            if (ctxParts.length > 0) {
                messageForApi = '[Auto-injected device context]\n' + ctxParts.join('\n') + '\n\n' + messageForApi;
            }
        }

        const body = {
            requestId,
            message: messageForApi,
            history: historyForApi,
            page: getCurrentPage()
        };
        if (images) {
            body.images = images;
        }

        try {
            console.log('[AI Chat] Submitting request:', requestId, 'page:', body.page);
            const submitResult = await apiCall('POST', '/api/ai-support/chat/submit', body);
            console.log('[AI Chat] Submit response:', JSON.stringify(submitResult));
            // Submit accepted, start polling for the response
            startPolling(requestId);
        } catch (err) {
            console.error('[AI Chat] Submit FAILED:', err.message || err, err);
            clearPending();
            hideTyping();
            // Show server error message if available (e.g. image too large, auth failure)
            const errMsg = (err.data && (err.data.message || err.data.error))
                || err.message
                || 'Sorry, something went wrong. Please try again.';
            chatHistory.push({ role: 'assistant', content: errMsg });
            saveHistory();
            renderMessages();
            scrollToBottom();
            isLoading = false;
        }
    }

    // ── Progress label mapping ────────────────────
    const TOOL_PROGRESS = {
        Read:  { key: 'ai_progress_read',  fallback: 'Reading file' },
        Grep:  { key: 'ai_progress_grep',  fallback: 'Searching code' },
        Glob:  { key: 'ai_progress_glob',  fallback: 'Finding files' },
        Bash:  { key: 'ai_progress_bash',  fallback: 'Running analysis' },
        Edit:  { key: 'ai_progress_edit',  fallback: 'Editing file' },
        Write: { key: 'ai_progress_write', fallback: 'Writing file' },
    };
    const MAX_TURNS = 15; // must match proxy's --max-turns

    function progressToText(progress) {
        if (!progress) return null;
        const turn = progress.turn || 0;
        const suffix = turn > 0 ? ' (' + (i18n.t('ai_progress_step') || 'Step') + ' ' + turn + '/' + MAX_TURNS + ')' : '';
        if (progress.event === 'tool_use' && progress.tool) {
            const info = TOOL_PROGRESS[progress.tool];
            const label = info ? (i18n.t(info.key) || info.fallback) : progress.tool;
            return label + '...' + suffix;
        }
        if (progress.event === 'thinking') {
            return (i18n.t('ai_progress_thinking') || 'Analyzing') + '...' + suffix;
        }
        if (progress.event === 'tool_result') {
            return (i18n.t('ai_progress_processing') || 'Processing result') + '...' + suffix;
        }
        return null;
    }

    // ── Polling ──────────────────────────────────

    function startPolling(requestId) {
        const startedAt = Date.now();
        let pollAttemptErrors = 0;
        let lastProgressAt = Date.now(); // track when we last received a progress update
        console.log('[AI Chat] startPolling() requestId:', requestId);

        async function poll() {
            const elapsed = Date.now() - startedAt;
            console.log('[AI Chat] poll() elapsed:', Math.round(elapsed / 1000) + 's', 'errors:', pollAttemptErrors);

            // Timeout guard: only fire if BOTH total time exceeded AND no recent progress
            if (elapsed > POLL_MAX_DURATION && Date.now() - lastProgressAt > 60000) {
                clearPending();
                hideTyping();
                chatHistory.push({ role: 'assistant', content: 'Request timed out. Please try again.' });
                saveHistory();
                renderMessages();
                scrollToBottom();
                isLoading = false;
                return;
            }

            try {
                const data = await apiCall('GET', '/api/ai-support/chat/poll/' + requestId);

                // Update typing text: prefer real-time progress over time-based fallback
                if (data.progress) {
                    lastProgressAt = Date.now();
                    const text = progressToText(data.progress);
                    if (text) updateTypingText(text);
                } else if (elapsed > 60000) {
                    updateTypingText(i18n.t('ai_chat_still_working') || 'This is taking a while, still working...');
                } else if (elapsed > 15000) {
                    updateTypingText(i18n.t('ai_chat_thinking') || 'Still working on it...');
                } else if (elapsed > 5000) {
                    updateTypingText(i18n.t('ai_chat_analyzing') || 'AI is analyzing...');
                }
                console.log('[AI Chat] poll response:', JSON.stringify({ status: data.status, busy: data.busy, hasResponse: !!data.response, error: data.error, latency_ms: data.latency_ms }));
                pollAttemptErrors = 0;

                if (data.status === 'completed') {
                    console.log('[AI Chat] ✅ completed! response length:', data.response?.length, 'busy:', data.busy);
                    clearPending();
                    hideTyping();

                    if (data.busy) {
                        chatHistory.push({ role: 'assistant', content: 'AI is currently busy. Please try again in a moment.' });
                    } else if (data.response) {
                        chatHistory.push({ role: 'assistant', content: data.response });
                    }
                    saveHistory();
                    renderMessages();
                    scrollToBottom();

                    if (data.actions && data.actions.length > 0) {
                        showActionBar(data.actions);
                    }

                    // Show feedback navigation if an issue + feedback was created
                    if (data.response && data.response.includes('Feedback #') && data.response.includes('recorded')) {
                        showFeedbackLink();
                    }

                    isLoading = false;
                    document.getElementById('aiChatInput')?.focus();
                    return;
                }

                if (data.status === 'failed' || data.status === 'expired') {
                    console.error('[AI Chat] ❌ status:', data.status, 'error:', data.error);
                    clearPending();
                    hideTyping();
                    chatHistory.push({ role: 'assistant', content: data.error || 'Something went wrong. Please try again.' });
                    saveHistory();
                    renderMessages();
                    scrollToBottom();
                    isLoading = false;
                    return;
                }

                // Still pending/processing — continue polling
                console.log('[AI Chat] status:', data.status, '— will poll again in', POLL_INTERVAL + 'ms');
                pollTimer = setTimeout(poll, POLL_INTERVAL);
            } catch (err) {
                pollAttemptErrors++;
                console.error('[AI Chat] poll error #' + pollAttemptErrors + ':', err.message || err);
                if (pollAttemptErrors < 5) {
                    pollTimer = setTimeout(poll, POLL_INTERVAL * 2);
                } else {
                    clearPending();
                    hideTyping();
                    chatHistory.push({ role: 'assistant', content: 'Lost connection. Please try again.' });
                    saveHistory();
                    renderMessages();
                    scrollToBottom();
                    isLoading = false;
                }
            }
        }

        pollTimer = setTimeout(poll, POLL_INTERVAL);
    }

    function clearPending() {
        try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    function resumePendingRequest() {
        try {
            const raw = localStorage.getItem(PENDING_KEY);
            if (!raw) { console.log('[AI Chat] No pending request to resume'); return; }
            const pending = JSON.parse(raw);
            if (!pending.requestId) return;
            const ageMs = Date.now() - pending.sentAt;
            console.log('[AI Chat] Found pending request:', pending.requestId, 'age:', Math.round(ageMs / 1000) + 's');
            // Discard if older than 3 minutes
            if (ageMs > 180000) {
                console.log('[AI Chat] Pending request too old, discarding');
                localStorage.removeItem(PENDING_KEY);
                return;
            }
            // Resume: show typing and start polling
            console.log('[AI Chat] Resuming pending request');
            isLoading = true;
            showTyping();
            updateTypingText(i18n.t('ai_chat_thinking') || 'Retrieving AI response...');
            startPolling(pending.requestId);
        } catch (err) {
            console.error('[AI Chat] resumePendingRequest error:', err);
            localStorage.removeItem(PENDING_KEY);
        }
    }

    function updateTypingText(text) {
        const el = document.getElementById('aiChatTyping');
        if (el) {
            el.innerHTML = '<span class="ai-chat-busy-text">' + escapeHtml(text) + '</span>';
        }
    }

    // ── Admin Actions ─────────────────────────
    function showActionBar(actions) {
        const bar = document.getElementById('aiChatActionBar');
        bar.style.display = 'block';
        bar.innerHTML = '';
        for (const action of actions) {
            if (action.type === 'create_issue') {
                const btn = document.createElement('button');
                btn.className = 'ai-chat-action-btn';
                btn.textContent = '\u{1F4CB} Create Issue: "' + (action.title || '').substring(0, 50) + '"';
                btn.addEventListener('click', () => confirmCreateIssue(action));
                bar.appendChild(btn);
            }
        }
    }

    function confirmCreateIssue(action) {
        if (!confirm('Create GitHub issue?\n\nTitle: ' + action.title + '\n\nBody:\n' + (action.body || '').substring(0, 300) + '...')) return;

        apiCall('POST', '/api/ai-support/create-issue', {
            title: action.title,
            body: action.body,
            labels: action.labels
        }).then(data => {
            if (data.success) {
                chatHistory.push({ role: 'assistant', content: 'GitHub issue #' + data.number + ' created: ' + data.url });
                saveHistory();
                renderMessages();
                scrollToBottom();
                if (typeof showToast === 'function') showToast('Issue #' + data.number + ' created!', 'success');
            }
        }).catch(err => {
            if (typeof showToast === 'function') showToast('Failed to create issue', 'error');
        });

        document.getElementById('aiChatActionBar').style.display = 'none';
    }

    // ── Feedback Navigation ─────────────────────
    function showFeedbackLink() {
        const bar = document.getElementById('aiChatActionBar');
        bar.style.display = 'block';
        const btn = document.createElement('button');
        btn.className = 'ai-chat-action-btn';
        btn.textContent = '\u{1F4CB} ' + (typeof i18n !== 'undefined' && i18n.t ? i18n.t('ai_chat_view_feedback', 'View Feedback History') : 'View Feedback History');
        btn.addEventListener('click', () => {
            window.location.href = 'feedback.html';
        });
        bar.appendChild(btn);
    }

    // ── Init ──────────────────────────────────
    function isAndroidWebView() {
        const hasBridge = typeof AndroidBridge !== 'undefined';
        const ua = navigator.userAgent || '';
        const hasUaTag = /EClawAndroid/i.test(ua);
        const hasWv = /\bwv\b/.test(ua);
        const hasAndroid = /Android/i.test(ua);
        const result = hasBridge || hasUaTag;
        dbg('isAndroidWebView()=' + result + ' | bridge=' + hasBridge + ' uaTag=' + hasUaTag + ' wv=' + hasWv + ' android=' + hasAndroid);
        return result;
    }

    function init() {
        dbg('init() called readyState=' + document.readyState);
        dbg('typeof AndroidBridge=' + (typeof AndroidBridge));

        // Skip AI chat widget in Android WebView — the app has its own AI chat
        if (isAndroidWebView()) {
            dbg('BLOCKED at init() — WebView detected');
            flushDebugToServer();
            return;
        }
        dbg('NOT blocked at init() — waiting for currentUser');

        let checkCount = 0;
        const check = setInterval(() => {
            checkCount++;
            if (window.currentUser) {
                clearInterval(check);
                dbg('currentUser found after ' + checkCount + ' checks (' + (checkCount * 200) + 'ms)');
                dbg('Re-checking isAndroidWebView...');
                if (isAndroidWebView()) {
                    dbg('BLOCKED at currentUser check — late WebView detect');
                    flushDebugToServer();
                    return;
                }
                dbg('NOT blocked — creating widget. Existing fab=' + !!document.getElementById('aiChatFab'));
                loadHistory();
                createWidget();
                dbg('Widget created. fab=' + !!document.getElementById('aiChatFab'));
                // Flush debug report so we can see it even when widget IS created (the problem case)
                flushDebugToServer();
                resumePendingRequest();
            }
            if (checkCount % 25 === 0) {
                dbg('Still waiting for currentUser... check #' + checkCount);
            }
        }, 200);
        setTimeout(() => {
            clearInterval(check);
            if (checkCount > 0 && !window.currentUser) {
                dbg('Gave up waiting for currentUser after 10s');
                flushDebugToServer();
            }
        }, 10000);
    }

    // ── Public API ────────────────────────────
    window.openAiChat = function () {
        if (!isOpen) toggleChat();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
