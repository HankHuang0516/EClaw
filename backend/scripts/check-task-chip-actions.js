#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const kanban = fs.readFileSync(path.join(root, 'backend/public/portal/kanban.html'), 'utf8');

function assertIncludes(needle, label) {
  if (!kanban.includes(needle)) throw new Error(`kanban.html missing ${label || needle}`);
}

assertIncludes('kb-task-action-shell', 'task action shell');
assertIncludes('kb-task-primary-btn', 'single primary action button styling/rendering');
assertIncludes('kb-task-secondary-row', 'secondary horizontal row');
assertIncludes('overflow-x:auto', 'secondary horizontal scroll');
assertIncludes('flex-wrap:nowrap', 'mobile no-wrap behavior');
assertIncludes('kb-task-overflow-panel', 'overflow menu panel');
assertIncludes('card.parentCardId', 'strict parentCardId parent chip');
assertIncludes('card.linkedPrevCardId', 'linkedPrevCardId chip');
assertIncludes('card.linkedNextCardId', 'linkedNextCardId chip');
assertIncludes('refreshTaskRelationBanner(card)', 'parent/current archived banner hook');
assertIncludes("archived: ${escapeHtml(parent.title || parent.id)}", 'archived-parent banner text');
assertIncludes('actions.slice(0, 5)', 'max five visible secondary chips');
assertIncludes('quoteKanbanCardToChat()', 'chat secondary chip');
assertIncludes('getTaskPrUrl(card)', 'PR secondary chip');
assertIncludes('archiveTaskCard', 'overflow archive action');

console.log('task chip action/layout static checks passed');
