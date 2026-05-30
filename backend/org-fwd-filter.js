/**
 * Org-chart forward noise filter.
 *
 * orgChartForward() in index.js silently routes any bot message up the org
 * chart to the user's superior. Sibling bots whose webhook handler crashes
 * (JSON parse errors), or that send bare "[<name> 回應超時]" status markers,
 * or that ack-the-ack with one-word replies, were flooding the user's
 * channel with low-signal noise. This filter drops those before the silent
 * push happens.
 */

const ORG_FWD_NOISE_PATTERNS = [
    /^\s*Unexpected (non-whitespace character after JSON|token .* in JSON|end of JSON)/i,
    /^\s*SyntaxError: Unexpected/i,
    /^\s*at position \d+/i,
    /^\s*line \d+ column \d+/i,
    /^\s*\[[^\]]{1,40}回應超時\]\s*$/,
    /^\s*\[[^\]]{1,40}response timeout\]\s*$/i,
    /^\s*\[SILENT\]\s*#?\d+\s+sign[- ]off\s+FWD\s+echo\b/i,
    /^\s*(ping|pong|ack|ok|received|noted)\s*[.!]*\s*$/i,
];

const ORG_FWD_MIN_BODY_LEN = 12;

function isLowSignalFwd(message) {
    if (!message) return true;
    const trimmed = String(message).trim();
    if (trimmed.length < ORG_FWD_MIN_BODY_LEN) return true;
    return ORG_FWD_NOISE_PATTERNS.some(re => re.test(trimmed));
}

module.exports = {
    isLowSignalFwd,
    ORG_FWD_NOISE_PATTERNS,
    ORG_FWD_MIN_BODY_LEN,
};
