# Contribution Guide

## 新增 settings 欄位的 3-piece 義務

Every new labeled settings field must ship three linked pieces in the same PR:

1. `<field>_label` in `backend/public/shared/i18n.js`.
2. `<field>_help` in `backend/public/shared/i18n.js`.
3. A nearby `HELP-KEY` annotation at the render or binding site.

Example:

```html
<!-- HELP-KEY: kanban_nudge_batch_help -->
<label for="kanban_nudge_batch_size">
  <span data-i18n="kanban_nudge_batch_label">Cards per cycle</span>
  <span class="help-icon" data-help-content="{{ i18n.get('kanban_nudge_batch_help') }}"></span>
</label>
```

The canonical locales for this PR are `en` and `zh`. Fanout locales can land later, but the PR gate blocks if either canonical locale is missing the label or help key.

Note: `TRANSLATIONS["zh-TW"]` is an intentionally thin override stub (publisher-guide-only); the Traditional Chinese canonical dict lives in `TRANSLATIONS.zh`, with `zh-TW` falling back through `zh` at runtime. The invariant gate checks `zh`, not `zh-TW`.

For JS-rendered fields, keep the annotation next to the binding call:

```js
// HELP-KEY: kanban_nudge_batch_help
HelpPopover.bindByKey(iconEl, 'kanban_nudge_batch_help');
```

When `backend/settings-help-keys.json` exists, regenerate it with:

```bash
node backend/scripts/generate-settings-help-keys.js
```

Then run the local gate before opening the PR:

```bash
node backend/scripts/check-settings-help-invariant.js --base origin/main --head HEAD
```

The gate prevents these regressions:

- A settings field is added or modified without the matching `<field>_help`.
- A `HELP-KEY` annotation points to a missing dictionary key.
- A help key listed in `backend/settings-help-keys.json` has no code-side annotation.
- A help key is removed while a `HELP-KEY` annotation still references it.
