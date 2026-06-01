const fs = require('fs');
const path = require('path');

const portalDir = path.join(__dirname, '../../public/portal');

function readPortalPage(page) {
  return fs.readFileSync(path.join(portalDir, page), 'utf8');
}

function formRange(html, formId) {
  const formStart = html.search(new RegExp(`<form\\b[^>]*\\bid=["']${formId}["']`, 'i'));
  expect(formStart).toBeGreaterThanOrEqual(0);
  const formEnd = html.indexOf('</form>', formStart);
  expect(formEnd).toBeGreaterThan(formStart);
  return { start: formStart, end: formEnd };
}

function expectInsideForm(html, formId, elementId) {
  const range = formRange(html, formId);
  const elementIndex = html.search(new RegExp(`\\bid=["']${elementId}["']`, 'i'));
  expect(elementIndex).toBeGreaterThan(range.start);
  expect(elementIndex).toBeLessThan(range.end);
}

describe('portal auth forms', () => {
  test('login page password credentials live inside native forms', () => {
    const html = readPortalPage('index.html');

    [
      ['loginForm', 'loginEmail'],
      ['loginForm', 'loginPassword'],
      ['registerForm', 'regEmail'],
      ['registerForm', 'regPassword'],
      ['registerForm', 'regPasswordConfirm'],
      ['deviceForm', 'deviceId'],
      ['deviceForm', 'deviceSecret'],
      ['forgotForm', 'forgotEmail'],
      ['resetForm', 'resetPassword'],
      ['resetForm', 'resetPasswordConfirm'],
    ].forEach(([formId, elementId]) => expectInsideForm(html, formId, elementId));

    expect(html).toMatch(/<form\b[^>]*\bid=["']loginForm["'][^>]*\bonsubmit=["']doLogin\(\);return false;["']/i);
    expect(html).toMatch(/<form\b[^>]*\bid=["']registerForm["'][^>]*\bonsubmit=["']doRegister\(\);return false;["']/i);
    expect(html).toMatch(/<form\b[^>]*\bid=["']deviceForm["'][^>]*\bonsubmit=["']doDeviceLogin\(\);return false;["']/i);
    expect(html).toMatch(/<form\b[^>]*\bid=["']forgotForm["'][^>]*\bonsubmit=["']doForgot\(\);return false;["']/i);
    expect(html).toMatch(/<form\b[^>]*\bid=["']resetForm["'][^>]*\bonsubmit=["']doReset\(\);return false;["']/i);
  });

  test('settings switch-device secret is submitted through a native form', () => {
    const html = readPortalPage('settings.html');

    expectInsideForm(html, 'switchDeviceForm', 'switchDeviceIdInput');
    expectInsideForm(html, 'switchDeviceForm', 'switchDeviceSecretInput');
    expect(html).toMatch(/<form\b[^>]*\bid=["']switchDeviceForm["'][^>]*\bonsubmit=["']performSwitchDevice\(\);return false;["']/i);
    expect(html).toMatch(/<button\b[^>]*\btype=["']submit["'][^>]*\bform=["']switchDeviceForm["'][^>]*\bid=["']btnConfirmSwitchDevice["']/i);
  });
});
