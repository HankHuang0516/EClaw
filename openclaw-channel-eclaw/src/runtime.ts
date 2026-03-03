/**
 * PluginRuntime singleton storage.
 * Every OpenClaw channel plugin follows this pattern — store the runtime
 * received during register() so other modules can access it.
 */

// Using `any` because the PluginRuntime type comes from openclaw/plugin-sdk
// which is only available when installed as a plugin within OpenClaw.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pluginRuntime: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setPluginRuntime(runtime: any): void {
  pluginRuntime = runtime;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPluginRuntime(): any {
  if (!pluginRuntime) {
    throw new Error('[E-Claw] Plugin runtime not initialized');
  }
  return pluginRuntime;
}
