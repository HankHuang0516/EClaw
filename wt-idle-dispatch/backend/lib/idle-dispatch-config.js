/**
 * idle-dispatch-config.js - Feature flag for idle dispatch hooks.
 * IDLE_DISPATCH_HOOKS_ENABLED env var (unset = OFF in production).
 */
const FLAG = process.env.IDLE_DISPATCH_HOOKS_ENABLED === 'true';
const idleDispatch = { enabled: FLAG };
module.exports = { idleDispatch };
