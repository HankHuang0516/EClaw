/**
 * EClaw Forms — Client-side form handler for Note Pages
 * Usage: Add <form data-eclaw-form> to your Note Page HTML/Markdown
 * 
 * Example:
 * <form data-eclaw-form>
 *   <input name="name" placeholder="Your name" required>
 *   <input name="email" type="email" placeholder="Email" required>
 *   <select name="plan"><option>Basic</option><option>Pro</option></select>
 *   <textarea name="message" placeholder="Message"></textarea>
 *   <button type="submit">Submit</button>
 * </form>
 */
(function() {
    'use strict';

    // Extract publicCode and noteId from URL path /p/:code/:noteId
    const pathParts = window.location.pathname.split('/');
    let publicCode = null, noteId = null;
    for (let i = 0; i < pathParts.length; i++) {
        if (pathParts[i] === 'p' && pathParts[i + 1]) {
            publicCode = pathParts[i + 1];
            noteId = pathParts[i + 2] || null;
            break;
        }
    }

    if (!publicCode) {
        console.warn('[EClaw Forms] Could not detect publicCode from URL');
        return;
    }

    // Style forms
    const style = document.createElement('style');
    style.textContent = `
        [data-eclaw-form] input, [data-eclaw-form] select, [data-eclaw-form] textarea {
            display: block; width: 100%; padding: 10px 14px; margin: 8px 0;
            background: var(--card-bg, #1a1d27); color: var(--text, #e0e0e0);
            border: 1px solid var(--border, #2a2d3a); border-radius: 8px;
            font-size: 14px; font-family: inherit;
        }
        [data-eclaw-form] input:focus, [data-eclaw-form] select:focus, [data-eclaw-form] textarea:focus {
            outline: none; border-color: var(--accent, #7c6aef);
        }
        [data-eclaw-form] button[type="submit"] {
            background: var(--accent, #7c6aef); color: white; border: none;
            padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600;
            cursor: pointer; margin-top: 12px; width: 100%; transition: opacity 0.2s;
        }
        [data-eclaw-form] button[type="submit"]:hover { opacity: 0.9; }
        [data-eclaw-form] button[type="submit"]:disabled { opacity: 0.5; cursor: not-allowed; }
        .eclaw-form-success { background: #065f46; color: #6ee7b7; padding: 16px; border-radius: 8px; text-align: center; margin-top: 12px; }
        .eclaw-form-error { background: #7f1d1d; color: #fca5a5; padding: 12px; border-radius: 8px; text-align: center; margin-top: 8px; }
        [data-eclaw-form] label { display: block; font-size: 13px; color: var(--text-muted, #8a8f98); margin-top: 12px; margin-bottom: 2px; }
    `;
    document.head.appendChild(style);

    // Handle all eclaw forms
    document.querySelectorAll('[data-eclaw-form]').forEach(form => {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = form.querySelector('button[type="submit"]');
            const origText = btn ? btn.textContent : '';
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Submitting...'; }

            // Remove old messages
            form.querySelectorAll('.eclaw-form-success, .eclaw-form-error').forEach(el => el.remove());

            // Collect form data
            const formData = {};
            new FormData(form).forEach((v, k) => { formData[k] = v; });

            try {
                const resp = await fetch('/api/mission/note/page/form-submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ publicCode, noteId, formData })
                });
                const result = await resp.json();
                if (result.success) {
                    const msg = document.createElement('div');
                    msg.className = 'eclaw-form-success';
                    msg.textContent = '✅ ' + (form.dataset.successMsg || 'Submitted successfully!');
                    form.appendChild(msg);
                    form.reset();
                } else {
                    throw new Error(result.error || 'Submission failed');
                }
            } catch (err) {
                const msg = document.createElement('div');
                msg.className = 'eclaw-form-error';
                msg.textContent = '❌ ' + (err.message || 'Something went wrong');
                form.appendChild(msg);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = origText; }
            }
        });
    });
})();
