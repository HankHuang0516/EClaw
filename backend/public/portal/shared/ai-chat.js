// ============================================
// E-Claw AI Chat Widget
// Floating chat button + expandable panel
// Loaded on all authenticated portal pages
// ============================================
(function () {
    'use strict';

    const STORAGE_KEY = 'eclaw_ai_chat_history';
    const MAX_HISTORY = 20;
    const MAX_IMAGES = 3;
    const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB after compression
    const MAX_IMAGE_DIM = 1024; // max width/height for compression

    let chatHistory = [];
    let isOpen = false;
    let isLoading = false;
    let pendingImages = []; // { data: base64, mimeType: string }

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

    // ── Send ──────────────────────────────────
    const MAX_RETRY = 3;

    async function sendMessage() {
        const input = document.getElementById('aiChatInput');
        const text = input.value.trim();
        if ((!text && pendingImages.length === 0) || isLoading) return;

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

        const body = {
            message: text || '(user attached image(s) — please analyze them)',
            history: chatHistory.slice(-MAX_HISTORY).map(m => ({
                role: m.role,
                content: m.content
            })),
            page: getCurrentPage()
        };
        if (images) {
            body.images = images;
        }

        await callWithRetry(body, 0);
    }

    async function callWithRetry(body, attempt) {
        try {
            const data = await apiCall('POST', '/api/ai-support/chat', body);

            // Handle busy response — auto-retry with countdown
            if (data.busy && attempt < MAX_RETRY) {
                const waitSec = data.retry_after || 15;
                updateTypingText(`AI is busy, retrying in ${waitSec}s... (${attempt + 1}/${MAX_RETRY})`);
                await countdown(waitSec);
                return callWithRetry(body, attempt + 1);
            }

            hideTyping();

            if (data.busy) {
                // Exhausted retries
                chatHistory.push({ role: 'assistant', content: 'AI is currently busy with other requests. Please try again in a moment.' });
            } else if (data.response) {
                chatHistory.push({ role: 'assistant', content: data.response });
            }
            saveHistory();
            renderMessages();
            scrollToBottom();

            if (data.actions && data.actions.length > 0) {
                showActionBar(data.actions);
            }
        } catch (err) {
            hideTyping();
            chatHistory.push({ role: 'assistant', content: 'Sorry, something went wrong. Please try again.' });
            saveHistory();
            renderMessages();
            scrollToBottom();
        } finally {
            isLoading = false;
            document.getElementById('aiChatInput').focus();
        }
    }

    function updateTypingText(text) {
        const el = document.getElementById('aiChatTyping');
        if (el) {
            el.innerHTML = '<span class="ai-chat-busy-text">' + escapeHtml(text) + '</span>';
        }
    }

    function countdown(seconds) {
        return new Promise(resolve => {
            let remaining = seconds;
            const interval = setInterval(() => {
                remaining--;
                if (remaining <= 0) {
                    clearInterval(interval);
                    showTyping(); // restore dots
                    resolve();
                } else {
                    updateTypingText(`AI is busy, retrying in ${remaining}s...`);
                }
            }, 1000);
        });
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

    // ── Init ──────────────────────────────────
    function init() {
        const check = setInterval(() => {
            if (window.currentUser) {
                clearInterval(check);
                loadHistory();
                createWidget();
            }
        }, 200);
        setTimeout(() => clearInterval(check), 10000);
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
