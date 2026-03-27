// E-Claw Portal - Shared API Helper

const API_BASE = window.location.origin;

async function apiCall(method, path, body = null) {
    const options = {
        method: method,
        credentials: 'include', // Send cookies
        headers: {}
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const response = await fetch(url, options);

    // Guard against non-JSON responses (e.g. HTML error pages)
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(`Server returned non-JSON response (HTTP ${response.status})`);
    }
    const data = await response.json();

    if (response.status === 401) {
        console.error('[API 401]', method, path, '→', JSON.stringify(data));
        console.error('[API 401] cookies:', document.cookie ? 'present' : 'EMPTY');
        console.error('[API 401] page:', window.location.href);
        // Pause here so devtools console can be read before redirect
        debugger; // Open DevTools BEFORE loading the page to catch this
        // Not authenticated - redirect to login (skip public pages, info page, and Android WebView)
        const isAndroidWebView = typeof AndroidBridge !== 'undefined';
        if (!isAndroidWebView && !window.location.pathname.includes('index.html') && !window.location.pathname.endsWith('/portal/') && !window.location.pathname.includes('info.html')) {
            window.location.href = 'index.html';
        }
        throw new Error(data.error || 'Not authenticated');
    }

    if (!response.ok) {
        const err = new Error(data.error || data.message || `HTTP ${response.status}`);
        err.status = response.status;
        err.data = data;
        throw err;
    }

    return data;
}

// Toast notifications
function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

// Format timestamp
function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// State badge color
function getStateBadgeClass(state) {
    const s = (state || '').toLowerCase();
    if (s === 'idle') return 'badge-idle';
    if (s === 'busy' || s === 'active') return 'badge-busy';
    if (s === 'sleeping') return 'badge-sleeping';
    if (s === 'excited' || s === 'eating') return 'badge-excited';
    return 'badge-idle';
}
