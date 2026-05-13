#!/usr/bin/env node
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync('backend/public/shared/kanban-sort.js', 'utf8');
const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);
const { KanbanSort } = ctx;

const statuses = ['todo', 'in_progress', 'review', 'done'];
const sortCases = {
  created_desc: { field: 'created', dir: 'desc' },
  created_asc: { field: 'created', dir: 'asc' },
  updated_desc: { field: 'updated', dir: 'desc' },
  updated_asc: { field: 'updated', dir: 'asc' },
  priority_asc: { field: 'priority', dir: 'asc' },
};

function makeCards(status) {
  // Input order is deliberately entity-id order (#1, #2, #3, #4). Correct
  // sorting must override this order for timestamp/priority sorts, including
  // done cards and snake_case timestamp payloads.
  return [
    { id: `card_${status}_a`, status, assignedBots: [1], createdAt: 1000, updatedAt: 4000, priority: 'P2' },
    { id: `card_${status}_b`, status, assignedBots: [2], created_at: 4000, updated_at: 1000, priority: 'P0' },
    { id: `card_${status}_c`, status, assignedBots: [3], createdAt: 3000, updated_at: 3000, priority: 'P3' },
    { id: `card_${status}_d`, status, assignedBots: [4], created_at: 2000, updatedAt: 2000, priority: 'P1' },
  ];
}

function values(cards, field) {
  if (field === 'created') return cards.map(KanbanSort.cardCreatedAt);
  if (field === 'updated') return cards.map(KanbanSort.cardUpdatedAt);
  if (field === 'priority') return cards.map(KanbanSort.priorityRank);
  throw new Error(field);
}

function assertMonotonic(vals, dir, label) {
  for (let i = 1; i < vals.length; i++) {
    if (dir === 'asc') assert(vals[i - 1] <= vals[i], `${label}: ${vals.join(',')}`);
    else assert(vals[i - 1] >= vals[i], `${label}: ${vals.join(',')}`);
  }
}

let assertions = 0;
for (const status of statuses) {
  for (const [sortType, spec] of Object.entries(sortCases)) {
    const sorted = KanbanSort.apply(makeCards(status), sortType);
    assert.strictEqual(sorted.length, 4, `${status}/${sortType} length`);
    assertMonotonic(values(sorted, spec.field), spec.dir, `${status}/${sortType}`);
    if (sortType === 'updated_desc') {
      assert.deepStrictEqual(sorted.map(c => c.assignedBots[0]), [1, 3, 4, 2], `${status}/${sortType} must not remain entity-id order`);
    }
    assertions++;
  }
}

console.log(`kanban sort regression passed: ${assertions} status/sort assertions`);
