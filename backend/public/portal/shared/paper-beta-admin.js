/* Private data is fetched only after the existing admin page's account gate. */
const PaperBetaAdmin = (() => {
    let generation = 0;
    let timer;
    let currentRoot;
    function section() {
        return '<section class="section-card" id="paperBetaFeedback"></section>';
    }
    function mount() {
        clearInterval(timer);
        const root = document.getElementById('paperBetaFeedback');
        if (!root) return;
        currentRoot = root;
        let cursor = null;
        const t = key => i18n.t(key);
        function action(name) {
            if (window.telemetry) window.telemetry.trackAction(name);
        }
        function node(tag, text, parent) {
            const el = document.createElement(tag);
            if (text !== undefined) el.textContent = text;
            parent.appendChild(el);
            return el;
        }
        async function load(before = null) {
            const requestGeneration = ++generation;
            root.replaceChildren(); // No stale private records on errors or revoked access.
            node('div', '紙上彈兵 · BETA · ' + t('paper_beta_title'), root).className = 'section-title';
            const status = node('p', t('common_loading'), root);
            status.setAttribute('role', 'status');
            try {
                const data = await apiCall('GET', '/api/admin/paper-beta-feedback' +
                    (before ? '?before=' + encodeURIComponent(before) : ''), null, { skip401Redirect: true });
                if (requestGeneration !== generation || !root.isConnected) return;
                status.textContent = t('paper_beta_summary') + ': ' + data.summary.total +
                    ' · ' + t('paper_beta_average') + ': ' + (data.summary.averageRating ?? '—') + '/5';
                const counts = data.summary.continuation;
                node('p', t('paper_beta_continuation') + ': ' + ['yes', 'maybe', 'no']
                    .map(key => t('paper_beta_' + key) + ' ' + counts[key]).join(' · '), root);
                if (!data.items.length) node('p', t('feedback_empty'), root);
                else {
                    const scroll = node('div', undefined, root);
                    scroll.className = 'table-scroll';
                    const table = node('table', undefined, scroll);
                    table.className = 'data-table';
                    table.style.minWidth = '720px';
                    const header = node('tr', undefined, node('thead', undefined, table));
                    ['mp_d_rating', 'paper_beta_continuation', 'paper_beta_comment', 'settings_version',
                        'guide_pub_col_platform', 'feedback_submitted_at'].forEach(key => node('th', t(key), header));
                    const body = node('tbody', undefined, table);
                    data.items.forEach(item => {
                        const row = node('tr', undefined, body);
                        [item.rating + '/5', t('paper_beta_' + item.continuation), item.comment || '—',
                            item.version, item.platform, new Date(item.createdAt).toLocaleString()]
                            .forEach((value, index) => {
                                const cell = node('td', value, row);
                                cell.style.whiteSpace = 'pre-wrap';
                                cell.style.overflowWrap = 'anywhere';
                                if (index === 2) cell.style.minWidth = '220px';
                            });
                    });
                }
                cursor = data.nextCursor;
                const refresh = node('button', t('admin_refresh'), root);
                refresh.type = 'button'; refresh.className = 'refresh-btn'; refresh.style.marginRight = '8px';
                refresh.addEventListener('click', () => { action('paper_beta_refresh'); load(); });
                const older = node('button', t('paper_beta_older'), root);
                older.type = 'button'; older.className = 'refresh-btn'; older.disabled = !cursor;
                older.addEventListener('click', () => { action('paper_beta_older'); load(cursor); });
            } catch (error) {
                if (requestGeneration !== generation || !root.isConnected) return;
                // Never send player comments, receipt IDs or response payloads to telemetry.
                if (window.telemetry) window.telemetry.trackError('paper_beta_read_failed', { status: error.status || 0 });
                root.replaceChildren();
                node('p', t(error.status === 401 || error.status === 403 ? 'paper_beta_denied' : 'paper_beta_unavailable'), root);
                // A visible retry is useful for temporary storage/network errors.
                if (error.status !== 401 && error.status !== 403) {
                    const retry = node('button', t('admin_refresh'), root);
                    retry.type = 'button'; retry.className = 'refresh-btn'; retry.addEventListener('click', () => { action('paper_beta_retry'); load(); });
                } else clearInterval(timer);
            }
        }
        load();
        // Refresh the latest page only while visible; bounded to fifty records.
        timer = setInterval(() => { if (!document.hidden) load(); }, 60000);
    }
    window.addEventListener('pagehide', () => {
        clearInterval(timer); generation++;
        if (currentRoot) currentRoot.replaceChildren();
    });
    // A bfcache return must fetch afresh rather than restoring private rows.
    window.addEventListener('pageshow', event => { if (event.persisted) mount(); });
    return { section, mount };
})();
