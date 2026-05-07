/**
 * kanban-events.js - Event emitter for kanban card lifecycle events.
 * Exports: kanbanEvents (EventEmitter) + emit(name, payload).
 * All emit() calls are no-ops when idleDispatch.enabled === false.
 * No listeners are registered here (PR-B adds them).
 */
const { EventEmitter } = require('events');
const { idleDispatch } = require('./idle-dispatch-config');

const kanbanEvents = new EventEmitter();
kanbanEvents.setMaxListeners(10);

/**
 * Emit a kanban event. Silently ignored when idleDispatch.enabled === false.
 * @param {string} name - Event name
 * @param {object} payload - Event payload (JSON-serializable)
 */
function emit(name, payload) {
    if (!idleDispatch.enabled) return;
    const evt = { name: name, payload: payload, ts: new Date().toISOString() };
    try {
        kanbanEvents.emit(name, evt);
        console.log(JSON.stringify({ ev: 'idle_dispatch.card_status_changed', name: name, payload: payload, ts: evt.ts }));
    } catch (err) {
        console.log(JSON.stringify({ ev: 'idle_dispatch.emit_error', name: name, error: err.message, ts: new Date().toISOString() }));
    }
}

module.exports = { kanbanEvents, emit };
