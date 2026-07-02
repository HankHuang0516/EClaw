'use strict';

/**
 * Kanban dispatcher routing hint (card_e9379868).
 *
 * A kanban notification is a SYSTEM event with no sender entity. When an
 * assigned bot replies "task done" in chat, the central router finds no
 * speakTo / @mention / senderHint and fail-safes the reply to a human — the
 * DISPATCHER (the commander who assigned the card) never receives it and
 * cannot verify/close the card (Hank 2026-07-02: a #6 completion report
 * routed to the human instead of #2). This builds an explicit routing
 * directive that tells the bot exactly who to address so its report reaches
 * the dispatcher.
 *
 * Pure + side-effect-free so it is unit-testable without a live pg pool
 * (the kanban module otherwise requires one).
 *
 * @param {object} p
 * @param {{entityId:number, publicCode:(string|null)}|null} p.dispatcherMeta
 *        The card dispatcher, resolved on the card's own device. null when
 *        unknown (system/cron-spawned cards with created_by=0).
 * @param {number} p.recipientEntityId  The entity being notified.
 * @param {string} [p.cardId]           Card id, for the comment instruction.
 * @returns {string} The directive block (leading with \n\n) or '' when no
 *        directive should be emitted.
 */
function buildDispatcherRoutingDirective({ dispatcherMeta, recipientEntityId, cardId } = {}) {
    if (!dispatcherMeta) return '';
    const dispId = Number(dispatcherMeta.entityId);
    if (!Number.isFinite(dispId) || dispId <= 0) return '';
    // A card creator assigned to their own card needs no self-routing.
    if (dispId === Number(recipientEntityId)) return '';

    const tokens = [`@#${dispId}`];
    if (dispatcherMeta.publicCode) tokens.push(`@${dispatcherMeta.publicCode}`);

    return (
        `\n\n[ROUTING — WHERE YOUR REPLY GOES]\n` +
        `This task was dispatched by #${dispId}. A plain chat reply to a kanban ` +
        `notification has NO sender to route back to and fail-safes to a human — the ` +
        `dispatcher never sees it. To report progress/completion so #${dispId} actually ` +
        `receives it, do EITHER:\n` +
        `• PREFERRED: POST a comment on card ${cardId || 'this card'} + move its status ` +
        `(the dispatcher is notified automatically), or\n` +
        `• if you must reply in chat, START the message with ${tokens.join(' or ')} ` +
        `so it routes to the dispatcher.`
    );
}

module.exports = { buildDispatcherRoutingDirective };
