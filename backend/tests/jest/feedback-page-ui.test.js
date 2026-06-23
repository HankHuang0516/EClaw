const fs = require('fs');
const path = require('path');

describe('feedback page UI affordances', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../../public/portal/feedback.html'),
    'utf8'
  );

  test('category selector is keyboard accessible and keeps pressed state in sync', () => {
    expect(html).toContain('<button type="button" class="cat-card selected-bug" data-cat="bug" onclick="selectCategory(\'bug\')" aria-pressed="true">');
    expect(html).toContain('<button type="button" class="cat-card" data-cat="feature" onclick="selectCategory(\'feature\')" aria-pressed="false">');
    expect(html).toContain('<button type="button" class="cat-card" data-cat="question" onclick="selectCategory(\'question\')" aria-pressed="false">');
    expect(html).toContain("card.setAttribute('aria-pressed', card.dataset.cat === cat ? 'true' : 'false')");
  });

  test('composer exposes guidance, readiness state, and bounded input length', () => {
    expect(html).toContain('id="feedbackCategoryHelp" data-i18n="feedback_category_help"');
    expect(html).toContain('id="submitText" class="submit-textarea" maxlength="2000"');
    expect(html).toContain('aria-describedby="feedbackCategoryHelp feedbackComposerState feedbackTextCount"');
    expect(html).toContain('id="feedbackComposerState" data-i18n="feedback_hint"');
    expect(html).toContain('id="feedbackTextCount">0/2000</span>');
    expect(html).toContain('const MAX_FEEDBACK_TEXT_LENGTH = 2000');
    expect(html).toContain('function updateSubmitReadiness()');
    expect(html).toContain('btn.disabled = feedbackSubmitting || !ready');
  });

  test('history filters report counts and explain filtered empty states', () => {
    expect(html).toContain('class="history-controls"');
    expect(html).toContain('id="feedbackSummary" role="status" aria-live="polite"');
    expect(html).toContain('function updateFeedbackSummary(total, filtered)');
    expect(html).toContain('function setFeedbackEmptyState(filter = currentFilter)');
    expect(html).toContain("btn.setAttribute('aria-pressed', btn.dataset.filter === filter ? 'true' : 'false')");
    expect(html).toContain('updateFeedbackSummary(allFeedback.length, filtered.length)');
  });

  test('photo guidance includes the existing privacy helper copy', () => {
    expect(html).toContain('id="feedbackPhotoHint" data-i18n="feedback_photo_hint"');
    expect(html).toContain('class="photo-hint photo-safety" data-i18n="feedback_photo_help"');
  });
});
