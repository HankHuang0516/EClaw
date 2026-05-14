// ============================================
// Organization Hierarchy Chart Module
// Per-device org chart stored in PostgreSQL
// Manages entity hierarchy + behavior options
// ============================================

const DEFAULT_OPTIONS = {
    kanbanReviewer: false,
    taskForward: false,
    allForward: false
};

let pool = null;

// In-memory cache: deviceId -> { data, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

async function initTable(chatPool) {
    pool = chatPool;
    await pool.query(`
        ALTER TABLE device_preferences
        ADD COLUMN IF NOT EXISTS org_chart JSONB DEFAULT '{}'
    `);
    // Periodic cache sweep to prevent unbounded memory growth
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of cache) {
            if (entry.expiresAt < now) cache.delete(key);
        }
    }, 5 * 60 * 1000); // every 5 minutes
}

// --- Helpers ---

/**
 * Find the direct superior of an entity in the hierarchy.
 * Returns entity ID (number) or "USER" or null if not found.
 */
function getSuperior(hierarchy, entityId) {
    if (!hierarchy || typeof hierarchy !== 'object') return null;
    const eid = Number(entityId);
    for (const [parentKey, children] of Object.entries(hierarchy)) {
        if (Array.isArray(children) && children.includes(eid)) {
            return parentKey === 'USER' ? 'USER' : Number(parentKey);
        }
    }
    return null; // not in hierarchy — treat as orphan (under USER)
}

/**
 * Get direct subordinates of an entity (or "USER").
 */
function getSubordinates(hierarchy, parentId) {
    if (!hierarchy || typeof hierarchy !== 'object') return [];
    const key = parentId === 'USER' ? 'USER' : String(parentId);
    const children = hierarchy[key];
    return Array.isArray(children) ? [...children] : [];
}

/**
 * Build default hierarchy: all entities directly under USER.
 */
function buildDefault(entityIds) {
    return { USER: entityIds.map(Number).sort((a, b) => a - b) };
}

/**
 * Validate hierarchy for cycles using BFS. Returns true if valid.
 */
function hasCycle(hierarchy) {
    // Build adjacency list
    const adj = {};
    for (const [parent, children] of Object.entries(hierarchy)) {
        if (!Array.isArray(children)) continue;
        adj[parent] = children.map(String);
    }
    // BFS from USER — detect if any node is visited twice
    const visited = new Set();
    const queue = ['USER'];
    visited.add('USER');
    while (queue.length > 0) {
        const node = queue.shift();
        const kids = adj[node] || [];
        for (const kid of kids) {
            if (visited.has(kid)) return true; // cycle detected
            visited.add(kid);
            queue.push(kid);
        }
    }
    return false;
}

/**
 * Compute max depth of hierarchy tree. Returns depth (USER = 0).
 */
function getMaxDepth(hierarchy) {
    function dfs(node, depth) {
        const key = String(node);
        const children = hierarchy[key];
        if (!Array.isArray(children) || children.length === 0) return depth;
        let max = depth;
        for (const child of children) {
            max = Math.max(max, dfs(child, depth + 1));
        }
        return max;
    }
    return dfs('USER', 0);
}

/**
 * Prune hierarchy: remove invalid entity IDs, promote orphaned children to parent.
 */
function pruneHierarchy(hierarchy, validEntityIds) {
    if (!hierarchy || typeof hierarchy !== 'object') {
        // No hierarchy — all valid entities go under USER
        return { USER: validEntityIds.map(Number).sort((a, b) => a - b) };
    }

    const validSet = new Set(validEntityIds.map(Number));
    const result = {};

    // First pass: collect all parent->children relationships
    for (const [parentKey, children] of Object.entries(hierarchy)) {
        if (!Array.isArray(children)) continue;
        const parentId = parentKey === 'USER' ? 'USER' : Number(parentKey);
        // Skip non-USER parents that are invalid
        if (parentId !== 'USER' && !validSet.has(parentId)) continue;
        result[String(parentId)] = children.filter(c => validSet.has(Number(c))).map(Number);
    }

    // Second pass: find entities under invalid parents and promote them
    for (const [parentKey, children] of Object.entries(hierarchy)) {
        if (!Array.isArray(children)) continue;
        const parentId = parentKey === 'USER' ? 'USER' : Number(parentKey);
        if (parentId === 'USER' || validSet.has(parentId)) continue;
        // This parent is invalid — find its parent (grandparent) and adopt children
        const grandparent = getSuperior(hierarchy, parentId);
        const gpKey = grandparent != null ? String(grandparent) : 'USER';
        if (!result[gpKey]) result[gpKey] = [];
        for (const child of children) {
            if (validSet.has(Number(child)) && !result[gpKey].includes(Number(child))) {
                result[gpKey].push(Number(child));
            }
        }
    }

    // Ensure USER key exists
    if (!result.USER) result.USER = [];

    // Find orphans (valid entities not in any children array) and add to USER
    const allChildren = new Set();
    for (const children of Object.values(result)) {
        for (const c of children) allChildren.add(Number(c));
    }
    for (const eid of validSet) {
        if (!allChildren.has(eid)) {
            result.USER.push(eid);
        }
    }

    // Sort children arrays for consistency
    for (const key of Object.keys(result)) {
        result[key].sort((a, b) => a - b);
    }

    // Remove empty non-USER entries
    for (const key of Object.keys(result)) {
        if (key !== 'USER' && result[key].length === 0) {
            delete result[key];
        }
    }

    return result;
}

/**
 * Validate hierarchy structure.
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateHierarchy(hierarchy, _validEntityIds) {
    if (!hierarchy || typeof hierarchy !== 'object' || Array.isArray(hierarchy)) {
        return { valid: false, error: 'hierarchy must be an object' };
    }

    // Check USER key exists
    if (!Array.isArray(hierarchy.USER)) {
        return { valid: false, error: 'hierarchy.USER must be an array' };
    }

    // Check all keys are "USER" or integer strings
    for (const key of Object.keys(hierarchy)) {
        if (key !== 'USER' && (isNaN(Number(key)) || !Number.isInteger(Number(key)))) {
            return { valid: false, error: `Invalid hierarchy key: ${key}` };
        }
    }

    // Check all children are integer arrays
    for (const [key, children] of Object.entries(hierarchy)) {
        if (!Array.isArray(children)) {
            return { valid: false, error: `hierarchy["${key}"] must be an array` };
        }
        for (const c of children) {
            if (!Number.isInteger(c)) {
                return { valid: false, error: `hierarchy["${key}"] contains non-integer: ${c}` };
            }
        }
    }

    // Check no entity appears in multiple parent arrays (before cycle check — duplicates cause false cycle detection)
    const seen = new Set();
    for (const children of Object.values(hierarchy)) {
        for (const c of children) {
            if (seen.has(c)) {
                return { valid: false, error: `Entity ${c} appears under multiple parents` };
            }
            seen.add(c);
        }
    }

    // Check for cycles
    if (hasCycle(hierarchy)) {
        return { valid: false, error: 'Hierarchy contains a cycle' };
    }

    // Check max depth
    if (getMaxDepth(hierarchy) > 5) {
        return { valid: false, error: 'Hierarchy exceeds maximum depth of 5' };
    }

    return { valid: true };
}

/**
 * Validate options object. Returns cleaned options.
 */
function validateOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
    const clean = {};
    for (const key of Object.keys(DEFAULT_OPTIONS)) {
        if (key in options) {
            clean[key] = !!options[key]; // coerce to boolean
        }
    }
    return clean;
}

// --- CRUD ---

async function getOrgChart(deviceId) {
    // Check cache
    const cached = cache.get(deviceId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }

    if (!pool) return { hierarchy: {}, options: { ...DEFAULT_OPTIONS } };

    try {
        const result = await pool.query(
            'SELECT org_chart FROM device_preferences WHERE device_id = $1',
            [deviceId]
        );
        if (result.rows.length === 0 || !result.rows[0].org_chart) {
            return { hierarchy: {}, options: { ...DEFAULT_OPTIONS } };
        }

        let stored = result.rows[0].org_chart;
        if (typeof stored === 'string') {
            try { stored = JSON.parse(stored); } catch { stored = {}; }
        }

        const data = {
            hierarchy: stored.hierarchy || {},
            options: { ...DEFAULT_OPTIONS, ...(stored.options || {}) }
        };

        // Update cache
        cache.set(deviceId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
        return data;
    } catch (err) {
        console.error('[OrgChart] getOrgChart error:', err.message);
        return { hierarchy: {}, options: { ...DEFAULT_OPTIONS } };
    }
}

async function updateOrgChart(deviceId, updates) {
    if (!pool) return { success: false, error: 'Database not initialized' };

    // Fetch current data
    const current = await getOrgChart(deviceId);

    // Apply partial updates
    let newHierarchy = current.hierarchy;
    let newOptions = current.options;

    if (updates.hierarchy !== undefined) {
        const validation = validateHierarchy(updates.hierarchy);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        newHierarchy = updates.hierarchy;
    }

    if (updates.options !== undefined) {
        const cleanOpts = validateOptions(updates.options);
        if (cleanOpts === null) {
            return { success: false, error: 'options must be an object with boolean values' };
        }
        newOptions = { ...newOptions, ...cleanOpts };
    }

    const orgChart = { hierarchy: newHierarchy, options: newOptions };

    try {
        await pool.query(`
            INSERT INTO device_preferences (device_id, org_chart, updated_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (device_id) DO UPDATE
            SET org_chart = $2::jsonb,
                updated_at = $3
        `, [deviceId, JSON.stringify(orgChart), Date.now()]);

        // Invalidate cache
        cache.delete(deviceId);

        return { success: true, orgChart };
    } catch (err) {
        console.error('[OrgChart] updateOrgChart error:', err.message);
        return { success: false, error: 'Database error' };
    }
}

/**
 * Handle entity deletion: prune hierarchy and persist.
 */
async function onEntityDeleted(deviceId, validEntityIds) {
    try {
        const current = await getOrgChart(deviceId);
        if (!current.hierarchy || Object.keys(current.hierarchy).length === 0) return;

        const pruned = pruneHierarchy(current.hierarchy, validEntityIds);
        await updateOrgChart(deviceId, { hierarchy: pruned });
    } catch (err) {
        console.error('[OrgChart] onEntityDeleted error:', err.message);
    }
}

/**
 * Clear cache for a device (call on PUT).
 */
function invalidateCache(deviceId) {
    cache.delete(deviceId);
}

/**
 * Diff two hierarchy snapshots and return the set of entity IDs whose
 * position in the chart changed: either their superior moved, or their
 * direct subordinate set changed. The USER root sentinel is never
 * included (it's not an entity). Used to decide which polling bots
 * need an `org_chart_changed` queue message after a PUT.
 */
function computeAffectedEntities(oldH, newH) {
    const childToParent = (h) => {
        const m = {};
        for (const [p, kids] of Object.entries(h || {})) {
            if (!Array.isArray(kids)) continue;
            for (const k of kids) m[String(k)] = p;
        }
        return m;
    };
    const oldSup = childToParent(oldH);
    const newSup = childToParent(newH);
    const affected = new Set();
    const allKids = new Set([...Object.keys(oldSup), ...Object.keys(newSup)]);
    for (const childKey of allKids) {
        if (oldSup[childKey] === newSup[childKey]) continue;
        const childId = parseInt(childKey, 10);
        if (!isNaN(childId)) affected.add(childId);
        for (const parentKey of [oldSup[childKey], newSup[childKey]]) {
            if (!parentKey || parentKey === 'USER') continue;
            const parentId = parseInt(parentKey, 10);
            if (!isNaN(parentId)) affected.add(parentId);
        }
    }
    return affected;
}

module.exports = {
    DEFAULT_OPTIONS,
    initTable,
    getOrgChart,
    updateOrgChart,
    getSuperior,
    getSubordinates,
    buildDefault,
    pruneHierarchy,
    validateHierarchy,
    validateOptions,
    onEntityDeleted,
    invalidateCache,
    computeAffectedEntities
};
