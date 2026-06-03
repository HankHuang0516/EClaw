/**
 * diff-format.js — unified diff + semantic patch JSON producer
 * Spec: docs/specs/a-hover-click-dom-interaction.md §6
 *
 * Inputs: a mutation log (array of { type, target, ...details }) produced by
 * the toolbar primitive. Output: { unified, semantic } pair.
 *
 * Mutation log shape:
 *   { type: 'style', target, property, from, to }
 *   { type: 'geometry', target, from: {x,y,w,h}, to: {x,y,w,h} }
 *   { type: 'duplicate', target, newNode }
 *   { type: 'remove', target, parent, beforeSibling }
 *
 * Per #6 review decision (spec §6.1.1): synthetic-source paths are allowed as
 * intermediate/preview only. Before send-to-Agent, source-map must resolve to
 * a real target file, OR the Quote is tagged `semantic-only: true`.
 */
(function (root) {
  'use strict';

  function describeSelector(el) {
    if (!el || el.nodeType !== 1) return '*';
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return `${tag}${cls}`;
  }

  function shortHandSummary(change) {
    switch (change.property) {
      case 'geometry': return 'position';
      default: return change.property.replace(/^style\./, '');
    }
  }

  function buildSemantic(mutations, sourceContext) {
    const changes = mutations.map((m) => {
      const base = { selector: describeSelector(m.target) };
      switch (m.type) {
        case 'style':
          return { ...base, property: `style.${m.property}`, from: m.from, to: m.to };
        case 'geometry':
          return { ...base, property: 'geometry', from: m.from, to: m.to };
        case 'duplicate':
          return { ...base, property: 'duplicate', from: null, to: 'cloned-as-next-sibling' };
        case 'remove':
          return { ...base, property: 'remove', from: 'present', to: 'removed' };
        default:
          return { ...base, property: m.type, from: m.from, to: m.to };
      }
    });
    return {
      patchId: `p_${root.eclawNowIso ? root.eclawNowIso() : Date.now()}`,
      sourceContext: sourceContext || { kind: 'unknown' },
      changes,
    };
  }

  function summaryLine(semantic) {
    if (!semantic.changes.length) return '0 elements changed';
    const grouped = {};
    semantic.changes.forEach((c) => {
      if (!grouped[c.selector]) grouped[c.selector] = [];
      grouped[c.selector].push(shortHandSummary(c));
    });
    const selectors = Object.keys(grouped);
    const headline = `${semantic.changes.length} change${semantic.changes.length === 1 ? '' : 's'}`;
    const detail = selectors.slice(0, 3).map((s) => `${s} (${grouped[s].join(', ')})`).join(', ');
    return `${headline}: ${detail}${selectors.length > 3 ? `, +${selectors.length - 3} more` : ''}`;
  }

  // Synthetic source path — used only as a draft placeholder per spec §6.1.1.
  function isSyntheticPath(path) {
    return /^<synthetic:user-edit-/.test(path);
  }

  // Build a single unified-diff hunk for a style add (the common case).
  function unifiedHunkForStyleAdd(file, line, before, after) {
    return [
      `--- a/${file}`,
      `+++ b/${file}`,
      `@@ -${line},${before.length} +${line},${after.length} @@`,
      ...before.map((l) => `-${l}`),
      ...after.map((l) => `+${l}`),
    ].join('\n');
  }

  // Default unified-diff producer: best-effort textual representation of each
  // mutation. Real impl will swap this for a sourceMap-driven producer in v1.1;
  // v1 ships this approximate version so downstream wiring (chat Quote, Agent
  // dispatch) can be exercised end-to-end.
  // v1.1: prefer real outerHTML before/after pairs when the toolbar
  // captures them. Falls back to property-level diff if the mutation
  // wasn't tagged with _beforeHTML / target.outerHTML (e.g. for canvas-
  // collage mode where there is no DOM source).
  function buildUnified(mutations, sourceContext, sourceMap) {
    const file = (sourceContext && sourceContext.url) || '<synthetic:user-edit-now>';
    const hunks = [];
    mutations.forEach((m) => {
      const sel = describeSelector(m.target);
      const beforeHTML = m._beforeHTML;
      const afterHTML = m.target && m.target.outerHTML ? m.target.outerHTML : null;
      if (beforeHTML && afterHTML && beforeHTML !== afterHTML) {
        // Emit a real before-vs-after outerHTML hunk that an Agent can
        // pattern-match against the source file. Lines are split so the
        // unified-diff format is well-formed.
        const beforeLines = beforeHTML.split(/\r?\n/);
        const afterLines = afterHTML.split(/\r?\n/);
        hunks.push([
          `--- a/${file}`,
          `+++ b/${file}`,
          `@@ ${sel} @@`,
          ...beforeLines.map((l) => `-${l}`),
          ...afterLines.map((l) => `+${l}`),
        ].join('\n'));
        return;
      }
      // Fallback: property-level diff (geometry / canvas / no-source mode).
      if (m.type === 'style') {
        hunks.push([
          `--- a/${file}`,
          `+++ b/${file}`,
          `@@ ${sel} @@`,
          `-/* ${m.property}=${JSON.stringify(m.from)} */`,
          `+/* ${m.property}=${JSON.stringify(m.to)} */`,
        ].join('\n'));
      } else if (m.type === 'geometry') {
        hunks.push([
          `--- a/${file}`,
          `+++ b/${file}`,
          `@@ ${sel} (geometry) @@`,
          `-/* ${JSON.stringify(m.from)} */`,
          `+/* ${JSON.stringify(m.to)} */`,
        ].join('\n'));
      } else if (m.type === 'remove') {
        if (beforeHTML) {
          const beforeLines = beforeHTML.split(/\r?\n/);
          hunks.push([
            `--- a/${file}`,
            `+++ b/${file}`,
            `@@ ${sel} (removed) @@`,
            ...beforeLines.map((l) => `-${l}`),
          ].join('\n'));
        } else {
          hunks.push([`--- a/${file}`, `+++ b/${file}`, `@@ ${sel} @@`, `-/* removed: ${sel} */`].join('\n'));
        }
      } else if (m.type === 'duplicate') {
        if (afterHTML) {
          const afterLines = afterHTML.split(/\r?\n/);
          hunks.push([
            `--- a/${file}`,
            `+++ b/${file}`,
            `@@ ${sel} (duplicated) @@`,
            ...afterLines.map((l) => `+${l}`),
          ].join('\n'));
        } else {
          hunks.push([`--- a/${file}`, `+++ b/${file}`, `@@ ${sel} @@`, `+/* duplicated: clone of ${sel} appended */`].join('\n'));
        }
      }
    });
    return hunks.join('\n\n');
  }

  function produce(mutations, sourceContext, sourceMap) {
    const semantic = buildSemantic(mutations, sourceContext);
    const unified = buildUnified(mutations, sourceContext, sourceMap);
    return {
      semantic,
      unified,
      summary: summaryLine(semantic),
      syntheticPath: !sourceContext || !sourceContext.url || isSyntheticPath(sourceContext.url),
    };
  }

  // Helper for the chat Quote layer: enforce #6's send-to-Agent gate.
  function isSendToAgentBlocked(diffResult, opts) {
    if (!diffResult) return { blocked: true, reason: 'no-diff' };
    if (diffResult.syntheticPath && !(opts && opts.semanticOnly)) {
      return {
        blocked: true,
        reason: 'synthetic-path-requires-real-source-or-semantic-only-opt-in',
      };
    }
    return { blocked: false };
  }

  root.EClawDiffFormat = {
    produce,
    isSendToAgentBlocked,
    describeSelector,
    summaryLine,
    isSyntheticPath,
    unifiedHunkForStyleAdd,
  };
})(typeof window !== 'undefined' ? window : this);
