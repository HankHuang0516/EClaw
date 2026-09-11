const path = require('path');

function setAiHankAppsCacheHeaders(res, filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();

    // These files are replaced in place by the daily publication pipeline.
    // They must revalidate so a new release manifest can never point at stale data.
    if (extension === '.html' || extension === '.json' || basename === 'data.js') {
        res.set('Cache-Control', 'no-cache');
        return;
    }

    // Shared scripts and styles also change in place, but a short browser cache is safe.
    if (extension === '.js' || extension === '.css') {
        res.set('Cache-Control', 'public, max-age=600, must-revalidate');
        return;
    }

    // Promotional media uses stable filenames and can keep the existing long cache.
    res.set('Cache-Control', 'public, max-age=604800, immutable');
}

module.exports = { setAiHankAppsCacheHeaders };
