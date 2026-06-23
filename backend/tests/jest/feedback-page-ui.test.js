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
    expect(html).toContain("i18n.t('feedback_filter_empty_sub', { label: allLabel, count: allFeedback.length })");
    expect(html).not.toContain('shows ${allFeedback.length} submitted feedback item');
  });

  test('photo guidance avoids unsupported EXIF helper copy', () => {
    expect(html).toContain('id="feedbackPhotoHint" data-i18n="feedback_photo_hint"');
    expect(html).not.toContain('data-i18n="feedback_photo_help"');
  });

  test('feedback helper translations match the visible category filters', () => {
    const i18nSrc = fs.readFileSync(
      path.join(__dirname, '../../public/shared/i18n.js'),
      'utf8'
    );
    const categoryEntries = [...i18nSrc.matchAll(/"feedback_category_help": "([^"]+)"/g)]
      .map((match) => match[1]);
    const filteredEmptyEntries = [...i18nSrc.matchAll(/"feedback_filter_empty_sub": "([^"]+)"/g)]
      .map((match) => match[1]);
    const photoHelpEntries = [...i18nSrc.matchAll(/"feedback_photo_help": "([^"]+)"/g)]
      .map((match) => match[1]);
    const settingsHelpCopy = fs.readFileSync(
      path.join(__dirname, '../../scripts/settings-help-copy.json'),
      'utf8'
    );

    expect(categoryEntries).toHaveLength(15);
    expect(filteredEmptyEntries).toHaveLength(15);
    expect(photoHelpEntries).toHaveLength(15);
    expect(settingsHelpCopy).not.toMatch(/\bEXIF\b/i);
    for (const value of categoryEntries) {
      expect(value).not.toMatch(/\bdesign\b|visual diff|視覺 diff|视觉 diff|시각적 차이|เปรียบเทียบภาพ|so sánh hình ảnh|perbandingan visual|comparaison visuelle|comparación visual|visueller Vergleich|reka bentuk|दृश्य तुलना|مقارنة بصرية/i);
    }
    for (const value of photoHelpEntries) {
      expect(value).not.toMatch(/\bEXIF\b/i);
    }
    for (const value of filteredEmptyEntries) {
      expect(value).toContain('{label}');
      expect(value).toContain('{count}');
    }
  });
});
