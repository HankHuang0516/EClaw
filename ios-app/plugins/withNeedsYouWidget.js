const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withEntitlementsPlist,
  withXcodeProject,
} = require('@expo/config-plugins');

const NEEDS_YOU_WIDGET_CONFIG = {
  appGroup: 'group.com.eclawbot.app.needyou',
  widgetKind: 'NeedsYouWidget',
  widgetTargetName: 'NeedsYouWidgetExtension',
  widgetDirectory: 'NeedsYouWidget',
  nativeModuleFile: 'NeedsYouWidgetStore.swift',
  nativeModuleExternFile: 'NeedsYouWidgetStoreBridge.m',
  pendingCountKey: 'pendingCount',
  updatedAtKey: 'updatedAt',
};

function withNeedsYouWidget(config, props = {}) {
  const options = { ...NEEDS_YOU_WIDGET_CONFIG, ...props };

  config = withEntitlementsPlist(config, (entitlementsConfig) => {
    const existing =
      entitlementsConfig.modResults['com.apple.security.application-groups'] || [];
    entitlementsConfig.modResults['com.apple.security.application-groups'] = [
      ...new Set([...existing, options.appGroup]),
    ];
    return entitlementsConfig;
  });

  return withXcodeProject(config, (projectConfig) => {
    const project = projectConfig.modResults;
    const iosRoot = projectConfig.modRequest.platformProjectRoot;
    const projectRoot = projectConfig.modRequest.projectRoot;
    const projectName = IOSConfig.XcodeUtils.getProjectName(projectRoot);
    const bundleIdentifier =
      projectConfig.ios?.bundleIdentifier ||
      projectConfig.exp?.ios?.bundleIdentifier ||
      config.ios?.bundleIdentifier;

    if (!bundleIdentifier) {
      throw new Error('[withNeedsYouWidget] Missing expo.ios.bundleIdentifier');
    }

    writeNativeModuleFiles({ iosRoot, projectName, options });
    linkBuildSource(project, iosRoot, path.join(projectName, options.nativeModuleFile));
    linkBuildSource(project, iosRoot, path.join(projectName, options.nativeModuleExternFile));
    ensureSwiftBuildSettings(project, project.getFirstTarget().uuid);

    writeWidgetFiles({ iosRoot, bundleIdentifier, options });
    const widgetTarget = ensureWidgetTarget(project, bundleIdentifier, options);
    ensureSwiftBuildSettings(project, widgetTarget.uuid);
    ensureWidgetBuildSettings(project, widgetTarget.uuid, bundleIdentifier, options);

    return projectConfig;
  });
}

function writeNativeModuleFiles({ iosRoot, projectName, options }) {
  const replacements = buildReplacements(options);
  writeTemplate(
    'NeedsYouWidgetStore.swift',
    path.join(iosRoot, projectName, options.nativeModuleFile),
    replacements
  );
  writeTemplate(
    'NeedsYouWidgetStoreBridge.m',
    path.join(iosRoot, projectName, options.nativeModuleExternFile),
    replacements
  );
}

function writeWidgetFiles({ iosRoot, bundleIdentifier, options }) {
  const widgetRoot = path.join(iosRoot, options.widgetDirectory);
  const replacements = {
    ...buildReplacements(options),
    __WIDGET_BUNDLE_IDENTIFIER__: `${bundleIdentifier}.${options.widgetTargetName}`,
  };
  writeTemplate(
    'NeedsYouWidget.swift',
    path.join(widgetRoot, 'NeedsYouWidget.swift'),
    replacements
  );
  writeTemplate(
    'NeedsYouWidget-Info.plist',
    path.join(widgetRoot, 'NeedsYouWidget-Info.plist'),
    replacements
  );
  writeTemplate(
    'NeedsYouWidget.entitlements',
    path.join(widgetRoot, 'NeedsYouWidget.entitlements'),
    replacements
  );
}

function ensureWidgetTarget(project, bundleIdentifier, options) {
  const existing = findNativeTarget(project, options.widgetTargetName);
  const target =
    existing ||
    project.addTarget(
      options.widgetTargetName,
      'app_extension',
      options.widgetDirectory,
      `${bundleIdentifier}.${options.widgetTargetName}`
    );

  if (!hasBuildPhase(project, target.uuid, 'PBXSourcesBuildPhase', 'Sources')) {
    project.addBuildPhase(
      [`${options.widgetDirectory}/NeedsYouWidget.swift`],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid
    );
  }

  if (!hasBuildPhase(project, target.uuid, 'PBXFrameworksBuildPhase', 'Frameworks')) {
    project.addBuildPhase(
      ['WidgetKit.framework', 'SwiftUI.framework'],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid
    );
  }

  return target;
}

function ensureWidgetBuildSettings(project, targetUuid, bundleIdentifier, options) {
  updateTargetBuildSettings(project, targetUuid, (settings) => {
    settings.APPLICATION_EXTENSION_API_ONLY = 'YES';
    settings.CODE_SIGN_ENTITLEMENTS = `${options.widgetDirectory}/NeedsYouWidget.entitlements`;
    settings.INFOPLIST_FILE = `${options.widgetDirectory}/NeedsYouWidget-Info.plist`;
    settings.IPHONEOS_DEPLOYMENT_TARGET = settings.IPHONEOS_DEPLOYMENT_TARGET || '15.1';
    settings.LD_RUNPATH_SEARCH_PATHS =
      '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"';
    settings.PRODUCT_BUNDLE_IDENTIFIER = `${bundleIdentifier}.${options.widgetTargetName}`;
    settings.PRODUCT_NAME = `"${options.widgetTargetName}"`;
    settings.SKIP_INSTALL = 'YES';
  });
}

function ensureSwiftBuildSettings(project, targetUuid) {
  updateTargetBuildSettings(project, targetUuid, (settings) => {
    settings.ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES =
      settings.ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES || 'YES';
    settings.SWIFT_VERSION = settings.SWIFT_VERSION || '5.0';
  });
}

function updateTargetBuildSettings(project, targetUuid, updater) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const configs = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(project, target.buildConfigurationList);
  for (const [, buildConfig] of configs) {
    updater(buildConfig.buildSettings);
  }
}

function linkBuildSource(project, iosRoot, relativePath) {
  const absolutePath = path.join(iosRoot, relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  IOSConfig.XcodeProjectFile.createBuildSourceFile({
    project,
    nativeProjectRoot: iosRoot,
    filePath: relativePath,
    fileContents: source,
    overwrite: true,
  });
}

function findNativeTarget(project, name) {
  const entry = Object.entries(project.pbxNativeTargetSection()).find(([, target]) => {
    if (!target || typeof target !== 'object') return false;
    return stripQuotes(target.name) === name;
  });
  if (!entry) return null;
  return { uuid: entry[0], pbxNativeTarget: entry[1] };
}

function hasBuildPhase(project, targetUuid, phaseType, comment) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  return (target.buildPhases || []).some((phase) => {
    const buildPhase = project.hash.project.objects[phaseType]?.[phase.value];
    return buildPhase && (!comment || phase.comment === comment);
  });
}

function writeTemplate(templateName, destination, replacements) {
  const source = fs.readFileSync(path.join(__dirname, 'needs-you-widget', templateName), 'utf8');
  let output = source;
  for (const [token, value] of Object.entries(replacements)) {
    output = output.split(token).join(value);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, output, 'utf8');
}

function buildReplacements(options) {
  return {
    __APP_GROUP__: options.appGroup,
    __WIDGET_KIND__: options.widgetKind,
    __PENDING_COUNT_KEY__: options.pendingCountKey,
    __UPDATED_AT_KEY__: options.updatedAtKey,
  };
}

function stripQuotes(value) {
  return String(value || '').replace(/^"|"$/g, '');
}

module.exports = withNeedsYouWidget;
module.exports.NEEDS_YOU_WIDGET_CONFIG = NEEDS_YOU_WIDGET_CONFIG;
