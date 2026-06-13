/**
 * Unified 400-error response helpers
 *
 * Goal: replace scattered `res.status(400).json({ success: false, error: '...' })`
 * with a single helper that emits a stable shape:
 *
 *   {
 *     success: false,
 *     error: "Email and password required",   // human-readable EN (backward-compat)
 *     code: "MISSING_REQUIRED_FIELD",         // machine-readable SCREAMING_SNAKE
 *     errorI18nKey: "err_missing_required_field",
 *     missingFields: ["email", "password"],   // only when applicable
 *     hint: "Provide the missing fields and try again"
 *   }
 *
 * Backward compat: every callsite that previously sent `{ success:false, error:'...' }`
 * keeps emitting an `error` string of the same shape, so existing Jest tests that
 * `toMatch(/email/i)` against `res.body.error` continue to pass.
 *
 * New fields (`code`, `errorI18nKey`, `missingFields`, `hint`) are additive and
 * opt-in for clients.
 */

const ERROR_CATALOG = {
    MISSING_REQUIRED_FIELD: {
        defaultError: 'Missing required field(s)',
        i18nKey: 'err_missing_required_field',
        hint: 'Provide the missing fields and try again',
    },
    INVALID_FORMAT: {
        defaultError: 'Invalid input format',
        i18nKey: 'err_invalid_format',
        hint: 'Check the field format and try again',
    },
    INVALID_EMAIL: {
        defaultError: 'Invalid email format',
        i18nKey: 'err_invalid_email',
        hint: 'Use a valid email address (example@domain.com)',
    },
    INVALID_PASSWORD: {
        defaultError: 'Invalid password',
        i18nKey: 'err_invalid_password',
        hint: 'Password must meet the strength requirements',
    },
    INVALID_TOKEN: {
        defaultError: 'Invalid token',
        i18nKey: 'err_invalid_token',
        hint: 'Request a fresh token and try again',
    },
    EXPIRED_TOKEN: {
        defaultError: 'Token expired',
        i18nKey: 'err_expired_token',
        hint: 'Token expired — request a new one',
    },
    INVALID_ID: {
        defaultError: 'Invalid id',
        i18nKey: 'err_invalid_id',
        hint: 'Check the id and try again',
    },
    INVALID_URL: {
        defaultError: 'Invalid URL',
        i18nKey: 'err_invalid_url',
        hint: 'Provide an absolute http(s) URL',
    },
    INVALID_LANGUAGE: {
        defaultError: 'Invalid language',
        i18nKey: 'err_invalid_language',
        hint: 'Use a supported BCP-47 language code',
    },
    AGENT_CARD_INCOMPLETE: {
        defaultError: 'Agent card is missing required fields',
        i18nKey: 'err_agent_card_incomplete',
        hint: 'Fill in the missing agent card fields, then try again',
    },
    BUSINESS_RULE_VIOLATION: {
        defaultError: 'Operation not allowed by business rules',
        i18nKey: 'err_business_rule_violation',
        hint: 'Review the operation constraints',
    },
};

/**
 * Send a structured 400 (or other status) error response.
 *
 * @param {import('express').Response} res
 * @param {string} code   SCREAMING_SNAKE_CASE code from ERROR_CATALOG or a custom one.
 * @param {object} [opts]
 * @param {string[]} [opts.missingFields]  list of missing/invalid field names.
 * @param {string}   [opts.error]          override the human-readable EN message.
 * @param {string}   [opts.hint]           override the human-readable hint.
 * @param {string}   [opts.i18nKey]        override the i18n key.
 * @param {number}   [opts.status=400]     HTTP status (default 400).
 * @param {object}   [opts.extra]          extra fields to splice into payload.
 * @returns {import('express').Response}
 */
function apiError(res, code, opts = {}) {
    const cat = ERROR_CATALOG[code] || {};
    const {
        missingFields,
        error,
        hint,
        i18nKey,
        status = 400,
        extra,
    } = opts;
    const payload = {
        success: false,
        code,
        error: error || cat.defaultError || code,
        errorI18nKey: i18nKey || cat.i18nKey || null,
        hint: hint || cat.hint || null,
    };
    if (Array.isArray(missingFields) && missingFields.length) {
        payload.missingFields = missingFields;
    }
    if (extra && typeof extra === 'object') {
        for (const k of Object.keys(extra)) {
            if (!(k in payload)) payload[k] = extra[k];
        }
    }
    return res.status(status).json(payload);
}

/**
 * Guard a route on a required-field whitelist.
 *
 * Treats `undefined`, `null`, and empty/whitespace-only strings as missing.
 * (Falsy numbers like `0` and the boolean `false` are NOT treated as missing —
 * they are legitimate values for many fields.)
 *
 * If any field is missing it sends a 400 with code=MISSING_REQUIRED_FIELD
 * (preserving an EN error message close to the legacy "X, Y and Z required"
 * format when an override is provided) and returns `false`. The caller should
 * `return` immediately when this returns `false`.
 *
 * @param {import('express').Response} res
 * @param {object} body  request body / params / query bag
 * @param {string[]} fields  required field names
 * @param {object} [opts]
 * @param {string} [opts.error]    override the EN message (else autogenerated).
 * @param {string} [opts.i18nKey]  override the i18n key.
 * @param {string} [opts.hint]     override the hint.
 * @returns {boolean}  true if all fields present; false (and 400 already sent) otherwise.
 */
function requireFields(res, body, fields, opts = {}) {
    const missing = [];
    const src = body && typeof body === 'object' ? body : {};
    for (const f of fields) {
        const v = src[f];
        if (
            v === undefined ||
            v === null ||
            (typeof v === 'string' && v.trim() === '')
        ) {
            missing.push(f);
        }
    }
    if (missing.length === 0) return true;
    const fallbackError = `Missing required field(s): ${missing.join(', ')}`;
    apiError(res, 'MISSING_REQUIRED_FIELD', {
        missingFields: missing,
        error: opts.error || fallbackError,
        i18nKey: opts.i18nKey,
        hint: opts.hint,
    });
    return false;
}

module.exports = {
    apiError,
    requireFields,
    ERROR_CATALOG,
};
