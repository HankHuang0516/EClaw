import fs from 'fs';
import path from 'path';

const repoRoot = path.join(__dirname, '../..');

describe('Needs-you WidgetKit prebuild wiring', () => {
  test('app config installs the local WidgetKit config plugin', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
    expect(appJson.expo.plugins).toContain('./plugins/withNeedsYouWidget');
  });

  test('app config declares the WidgetKit extension for EAS credentials', () => {
    const appJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
    const appExtensions =
      appJson.expo.extra?.eas?.build?.experimental?.ios?.appExtensions || [];
    expect(appExtensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetName: 'NeedsYouWidgetExtension',
          bundleIdentifier: 'com.eclawbot.app.NeedsYouWidgetExtension',
          entitlements: expect.objectContaining({
            'com.apple.security.application-groups': ['group.com.eclawbot.app.needyou'],
          }),
        }),
      ])
    );
  });

  test('config plugin creates WidgetKit extension and shared app group', () => {
    const plugin = fs.readFileSync(path.join(repoRoot, 'plugins/withNeedsYouWidget.js'), 'utf8');
    expect(plugin).toContain("withEntitlementsPlist");
    expect(plugin).toContain("withXcodeProject");
    expect(plugin).toContain("group.com.eclawbot.app.needyou");
    expect(plugin).toContain("project.addTarget");
    expect(plugin).toContain("'app_extension'");
    expect(plugin).toContain("PBXSourcesBuildPhase");
    expect(plugin).toContain("PBXFrameworksBuildPhase");
    expect(plugin).toContain("WidgetKit.framework");
    expect(plugin).toContain("NeedsYouWidgetStore.swift");
    expect(plugin).toContain("__WIDGET_SHORT_VERSION__");
    expect(plugin).toContain("__WIDGET_BUILD_VERSION__");
    expect(plugin).toContain("projectConfig.exp?.ios?.buildNumber");
    expect(plugin).toContain("developmentTeam: 'KLBQRT47CT'");
    expect(plugin).toContain('settings.DEVELOPMENT_TEAM = options.developmentTeam');
  });

  test('native store writes pending count to the WidgetKit app group', () => {
    const swift = fs.readFileSync(
      path.join(repoRoot, 'plugins/needs-you-widget/NeedsYouWidgetStore.swift'),
      'utf8'
    );
    expect(swift).toContain('UserDefaults(suiteName: "__APP_GROUP__")');
    expect(swift).toContain('defaults.set(clampedCount, forKey: "__PENDING_COUNT_KEY__")');
    expect(swift).toContain('WidgetCenter.shared.reloadTimelines(ofKind: "__WIDGET_KIND__")');
  });

  test('WidgetKit template renders pending and all-clear states from app group storage', () => {
    const widget = fs.readFileSync(
      path.join(repoRoot, 'plugins/needs-you-widget/NeedsYouWidget.swift'),
      'utf8'
    );
    expect(widget).toContain('StaticConfiguration(kind: kind, provider: NeedsYouProvider())');
    expect(widget).toContain('UserDefaults(suiteName: appGroupIdentifier)');
    expect(widget).toContain('pendingCountKey');
    expect(widget).toContain('Needs you');
    expect(widget).toContain('All clear');
  });

  test('WidgetKit Info.plist keeps extension version aligned with app config', () => {
    const plist = fs.readFileSync(
      path.join(repoRoot, 'plugins/needs-you-widget/NeedsYouWidget-Info.plist'),
      'utf8'
    );
    expect(plist).toContain('__WIDGET_SHORT_VERSION__');
    expect(plist).toContain('__WIDGET_BUILD_VERSION__');
  });
});
