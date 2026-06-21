const fs = require('fs');
const path = require('path');

describe('files page self-improvement UI', () => {
    const filesPath = path.join(__dirname, '../../public/portal/files.html');
    const html = fs.readFileSync(filesPath, 'utf8');

    test('renders a live result context strip with a clear-filters action', () => {
        expect(html).toContain('class="file-result-panel" id="fileResultPanel" role="status" aria-live="polite"');
        expect(html).toContain('id="fileResultSummary"');
        expect(html).toContain('id="fileActiveFilters"');
        expect(html).toContain('id="clearFileFilters" type="button" onclick="clearFileFilters()" data-i18n="community_result_clear_filters" disabled');
        expect(html).toContain('function updateFileResultContext(displayFiles = getDisplayFiles())');
    });

    test('shows filtered empty context and resets every narrowing control', () => {
        expect(html).toContain('id="emptyTitle"');
        expect(html).toContain('id="emptyDesc"');
        expect(html).toContain('id="emptyClearFileFilters" type="button" onclick="clearFileFilters()"');
        expect(html).toContain("tr('faq_no_results', 'No matching results found.')");
        expect(html).toContain('function clearFileFilters()');
        expect(html).toContain("currentTypeFilter = 'all'");
        expect(html).toContain('currentEntityFilter = null');
        expect(html).toContain("currentTimeFilter = 'all'");
        expect(html).toContain('currentFolderFilter = null');
        expect(html).toContain('syncFilterControls()');
    });

    test('delete uses the shared apiCall signature with current user credentials', () => {
        expect(html).toContain("const resp = await apiCall(\n                    'DELETE',");
        expect(html).toContain("'/api/device/files/' + encodeURIComponent(file.id)");
        expect(html).toContain("encodeURIComponent(currentUser.deviceId)");
        expect(html).toContain("encodeURIComponent(currentUser.deviceSecret)");
        expect(html).not.toContain("encodeURIComponent(deviceId)");
        expect(html).not.toContain("encodeURIComponent(deviceSecret)");
    });
});
