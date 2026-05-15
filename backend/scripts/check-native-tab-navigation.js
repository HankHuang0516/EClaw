#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function assertIncludes(file, needle, label) {
  const body = read(file);
  if (!body.includes(needle)) throw new Error(`${file} missing ${label || needle}`);
}

assertIncludes('ios-app/components/WebViewScreen.tsx', "type: 'eclaw:navigate-tab'", 'native navigate bridge message');
assertIncludes('ios-app/components/WebViewScreen.tsx', 'pendingIntent = intent; // last navigation wins', 'last-intent-wins race handling');
assertIncludes('ios-app/components/WebViewScreen.tsx', '15000', 'pending intent timeout');
assertIncludes('ios-app/components/WebViewScreen.tsx', "router.navigate(routeForTab", 'native bottom-tab route dispatch');
assertIncludes('ios-app/app/(tabs)/chat.tsx', 'tabId="chat"', 'chat tab registration');
assertIncludes('ios-app/app/(tabs)/mission.tsx', 'tabId="mission"', 'mission tab registration');

assertIncludes('backend/public/portal/chat.html', "params.get('msg') || params.get('his')", 'chat ?his compatibility alias');
assertIncludes('backend/public/portal/chat.html', 'window.eclawHandleNativeNavigateIntent', 'chat native intent consumer');
assertIncludes('backend/public/portal/chat.html', 'eclawNavigateMissionCard(cardId)', 'chat-to-mission native card open');

assertIncludes('backend/public/portal/kanban.html', 'eclawNavigateChat({ target: \'message\'', 'kanban history native message navigation');
assertIncludes('backend/public/portal/kanban.html', "'/portal/chat.html?msg='", 'kanban ?msg fallback, not ?his');
assertIncludes('backend/public/portal/kanban.html', 'window.eclawHandleNativeNavigateIntent', 'kanban native card intent consumer');

assertIncludes('backend/kanban_schema.sql', 'linked_prev_card_id', 'linked prev schema');
assertIncludes('backend/kanban_schema.sql', 'linked_next_card_id', 'linked next schema');
assertIncludes('backend/kanban.js', 'linkedPrevCardId', 'linked prev API serialization/write');
assertIncludes('backend/kanban.js', 'linkedNextCardId', 'linked next API serialization/write');
assertIncludes('backend/kanban.js', 'cannot point to the same card', 'self-link validation');
assertIncludes('backend/kanban.js', 'target card not found', 'target existence validation');

console.log('native tab navigation static checks passed');
