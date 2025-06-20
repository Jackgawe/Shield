import { Component, onCleanup, createSignal, Signal } from "solid-js";
import { createMutable } from "solid-js/store";
import { dbStore, isInited, storage, waitInit, ShelterStore as StorageStore } from "./storage";
import { createScopedApiInternal, log, prettifyError } from "./util";
import {
  ModalBody,
  ModalHeader,
  ModalRoot,
  ModalFooter,
  Button,
  ButtonColors,
  ButtonSizes,
  openModal,
} from "@uwu/shelter-ui";
import { devModeReservedId } from "./devmode";
import { registerInjSection, setInjectorSections } from "./settings";
import { batch, untrack } from "solid-js";
import { IDBPDatabase, openDB } from "idb";

// Type definitions
export type LoaderIntegrationOpts = {
  allowedActions: { toggle?: true; delete?: true; edit?: true; update?: true };
  isVisible: boolean;
  loaderName?: string;
};

export type PluginLifecycleHooks = {
  onLoad?(): void | Promise<void>;
  onUnload?(): void | Promise<void>;
  onUpdate?(): void | Promise<void>;
  onError?(error: Error): void | Promise<void>;
  onSettingsChange?(settings: Record<string, any>): void | Promise<void>;
};

export type PluginMetadata = {
  name: string;
  description: string;
  version: string;
  author: string;
  license?: string;
  repository?: string;
  dependencies?: Record<string, string>;
  permissions?: string[];
  tags?: string[];
  minShieldVersion?: string;
  maxShieldVersion?: string;
  hash?: string;
};

// Store symbols
export const symWait = Symbol("wait");
export const symDb = Symbol("db");
export const symSig = Symbol("sig");

// Update store type to match storage implementation
export type ShelterStore<T> = StorageStore<T>;

// Define a separate interface for usage stats
interface PluginUsageStats {
  startCount: number;
  errorCount: number;
  lastStarted?: number;
  totalUptime?: number;
}

// Rest of type definitions
export type StoredPlugin = PluginMetadata & {
  local: boolean;
  src: string;
  update?: boolean;
  manifest: PluginMetadata;
  js: string;
  on: boolean;
  enabledAt?: number;
  disabledAt?: number;
  lastError?: string;
  lastUpdated?: number;
  injectorIntegration?: LoaderIntegrationOpts;
  usageStats?: PluginUsageStats;
  store: ShelterStore<unknown>;
};

export type EvaledPlugin = {
  onLoad?(): void | Promise<void>;
  onUnload?(): void | Promise<void>;
  onUpdate?(): void | Promise<void>;
  onError?(error: Error): void | Promise<void>;
  onSettingsChange?(settings: Record<string, any>): void | Promise<void>;
  settings?: Component;
  scopedDispose(): void;
};

export type PluginStore = Record<string, StoredPlugin>;

// Store creation function
export async function createStorage<T>(pluginId: string): Promise<[ShelterStore<T>, () => void]> {
  if (!isInited(pluginStorages)) {
    throw new Error("to keep data persistent, plugin storages must not be created until connected to IDB");
  }

  const store = storage<T>(`plugin-${pluginId}`) as unknown as ShelterStore<T>;
  const flushStore = () => {
    // Storage is automatically persisted
  };

  Object.defineProperty(store, Symbol.iterator, {
    value: function* () {
      for (const key in store) {
        if (
          typeof key === "string" &&
          key !== symWait.toString() &&
          key !== symDb.toString() &&
          key !== symSig.toString()
        ) {
          yield [key, store[key]];
        }
      }
    },
    enumerable: false,
    configurable: true,
  });

  await waitInit(store);
  return [store, flushStore];
}

// Internal state
const pluginStorages = storage("plugins-data") as unknown as ShelterStore<Record<string, any>>;
const [internalLoaded, setInternalLoaded] = createSignal<Record<string, EvaledPlugin>>({});
const loadedPlugins = createMutable<Record<string, EvaledPlugin>>({});
const internalData = storage<PluginStore>("plugins-internal") as unknown as ShelterStore<PluginStore>;

// Create signal for installed plugins with proper typing
const [getInstalledPlugins, setInstalledPlugins] = createSignal<PluginStore>(internalData as unknown as PluginStore);

// Export readonly accessor for installed plugins
export const installedPlugins = () => getInstalledPlugins();

// Export loaded plugins store
export { loadedPlugins };

// Helper functions
export function getPluginData(id: string): StoredPlugin | undefined {
  return (internalData as unknown as Record<string, StoredPlugin>)[id];
}

export function updatePluginData(id: string, plugin: Partial<StoredPlugin>) {
  const existing = getPluginData(id);
  if (!existing) throw new Error(`attempted to update non-existent plugin: ${id}`);
  (internalData as unknown as Record<string, StoredPlugin>)[id] = { ...existing, ...plugin };
}

// Add local plugin with validation
export function addLocalPlugin(id: string, plugin: StoredPlugin) {
  if (typeof id !== "string" || untrack(() => getPluginData(id)) || id === devModeReservedId)
    throw new Error("plugin ID invalid or taken");

  if (!plugin.local) plugin.local = true;
  delete plugin.injectorIntegration;

  if (
    typeof plugin.js !== "string" ||
    typeof plugin.update !== "boolean" ||
    (plugin.src !== undefined && typeof plugin.src !== "string") ||
    typeof plugin.manifest !== "object"
  )
    throw new Error("Plugin object failed validation");

  plugin.on = false;
  updatePluginData(id, plugin);
}

export async function addRemotePlugin(id: string, src: string): Promise<StoredPlugin> {
  if (untrack(() => getPluginData(id))) throw new Error("plugin already exists");
  if (!id.match(/^[a-z0-9-]+$/)) throw new Error("plugin id must be lowercase alphanumeric with hyphens");

  const [store] = await createStorage<unknown>(id);
  const plugin: StoredPlugin = {
    name: "",
    version: "",
    author: "",
    description: "",
    local: false,
    src,
    manifest: {} as PluginMetadata,
    js: "",
    on: false,
    store,
  };

  updatePluginData(id, plugin);

  try {
    await updatePlugin(id);
    return plugin;
  } catch (e) {
    delete internalData[id];
    throw e;
  }
}

export function editPlugin(id: string, overwrite: StoredPlugin, updating = false) {
  const plugin = { ...untrack(() => getPluginData(id)), ...overwrite } as StoredPlugin;
  updatePluginData(id, plugin);
  if (updating) plugin.lastUpdated = Date.now();
  return plugin;
}

export function removePlugin(id: string) {
  if (!untrack(() => getPluginData(id))) throw new Error(`attempted to remove non-existent plugin ${id}`);
  if (id in internalLoaded()) stopPlugin(id);
  if (id === devModeReservedId) delete pluginStorages[id];
  delete internalData[id];
}

// Update devmode plugin initialization
export const devmodePrivateApis = {
  initDevmodePlugin: () => {
    const plugin: StoredPlugin = {
      local: true,
      update: false,
      on: false,
      manifest: {} as PluginMetadata,
      js: "{onUnload(){}}",
      name: "Dev Mode",
      version: "1.0.0",
      author: "shelter",
      description: "Development mode plugin",
      src: "",
      store: {} as ShelterStore<unknown>,
    };
    updatePluginData(devModeReservedId, plugin);
  },
  replacePlugin: (obj: { js: string; manifest: object }) => {
    const plugin = untrack(() => getPluginData(devModeReservedId));
    Object.assign(plugin, obj);
    updatePluginData(devModeReservedId, plugin);
  },
};

// Update loader plugin initialization
export async function ensureLoaderPlugin(
  id?: string,
  plugin?: string | [string, LoaderIntegrationOpts],
): Promise<void> {
  const pluginId = id ?? "shelter-loader";
  const existing = untrack(() => getPluginData(pluginId));

  if (existing?.local) return;

  const [store] = await createStorage<unknown>(pluginId);
  const [src, opts] = plugin ? (Array.isArray(plugin) ? plugin : [plugin, undefined]) : ["", undefined];
  const pluginData: StoredPlugin = {
    name: "Shelter Loader",
    version: "1.0.0",
    author: "uwu.network",
    description: "The plugin that loads other plugins",
    local: true,
    src,
    manifest: {
      name: "Shelter Loader",
      version: "1.0.0",
      author: "uwu.network",
      description: "The plugin that loads other plugins",
    },
    js: "",
    on: true,
    store,
    injectorIntegration: opts,
  };

  updatePluginData(pluginId, pluginData);

  try {
    await startPlugin(pluginId);
  } catch (e) {
    delete internalData[pluginId];
    throw e;
  }
}

// Update local plugin migration
export async function startAllPlugins() {
  await Promise.all([waitInit(internalData), waitInit(pluginStorages)]);

  const allPlugins = Object.keys(internalData);

  // migrate missing local keys from before it was stored
  for (const k of allPlugins) {
    const plugin = untrack(() => getPluginData(k));
    if (plugin.local === undefined) {
      plugin.local = !plugin.src;
      updatePluginData(k, plugin);
    }
  }

  // update in parallel
  const results = await Promise.allSettled(
    allPlugins.filter((id) => getPluginData(id).update && !getPluginData(id).local).map(updatePlugin),
  );

  for (const res of results) if (res.status === "rejected") log(res.reason, "error");

  const toStart = allPlugins.filter((id) => getPluginData(id).on && id !== devModeReservedId);

  // probably safer to do this in series though :p
  toStart.forEach(startPlugin);

  // makes things cleaner in index.ts init
  return stopAllPlugins;
}

const stopAllPlugins = () => Object.keys(internalData).forEach(stopPlugin);

// Update plugin API creation
async function createPluginApi(pluginId: string, plugin: StoredPlugin) {
  const [store, flushStore] = await createStorage(pluginId);
  const scoped = createScopedApiInternal(window["shelter"].flux.dispatcher, !!plugin.injectorIntegration);

  return {
    store,
    flushStore,
    id: pluginId,
    plugin,
    showSettings: () =>
      openModal((mprops) => (
        <ModalRoot>
          <ModalHeader close={mprops.close}>Settings - {plugin.name}</ModalHeader>
          <ModalBody>{getSettings(pluginId)({})}</ModalBody>
          <ModalFooter>
            <Button
              size={ButtonSizes.MEDIUM}
              color={ButtonColors.PRIMARY}
              onclick={() => {
                mprops.close();
              }}
            >
              Done
            </Button>
          </ModalFooter>
        </ModalRoot>
      )),
    scoped,
  };
}

export type ShelterPluginApi = ReturnType<typeof createPluginApi>;

// Add version comparison
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 !== num2) return num1 - num2;
  }
  return 0;
}

// Update plugin validation
function validatePlugin(plugin: StoredPlugin): string[] {
  const errors: string[] = [];

  // Required fields
  if (!plugin.name?.trim()) errors.push("Plugin must have a non-empty name");
  if (!plugin.version?.trim()) errors.push("Plugin must have a version");
  if (!plugin.author?.trim()) errors.push("Plugin must have an author");
  if (!plugin.description?.trim()) errors.push("Plugin must have a description");

  // Version format validation
  if (plugin.version && !/^\d+\.\d+\.\d+$/.test(plugin.version)) {
    errors.push("Version must follow semver format (x.y.z)");
  }

  // Hash validation (if present)
  if (plugin.hash && typeof plugin.hash !== "string") {
    errors.push("Hash must be a string if present");
  }

  // Shield version compatibility check
  const currentVersion = "1.0.0"; // TODO: Get from package.json
  if (plugin.minShieldVersion && compareVersions(currentVersion, plugin.minShieldVersion) < 0) {
    errors.push(`Plugin requires Shield version ${plugin.minShieldVersion} or higher`);
  }
  if (plugin.maxShieldVersion && compareVersions(currentVersion, plugin.maxShieldVersion) > 0) {
    errors.push(`Plugin requires Shield version ${plugin.maxShieldVersion} or lower`);
  }

  // Dependencies validation
  if (plugin.dependencies) {
    for (const [dep, version] of Object.entries(plugin.dependencies)) {
      if (!version.match(/^[\^~]?\d+\.\d+\.\d+$/)) {
        errors.push(`Invalid version format for dependency ${dep}`);
      }
    }
  }

  // Permissions validation
  if (plugin.permissions) {
    const validPermissions = ["storage", "network", "ui", "settings"];
    for (const perm of plugin.permissions) {
      if (!validPermissions.includes(perm)) {
        errors.push(`Invalid permission: ${perm}`);
      }
    }
  }

  return errors;
}

// Enhance plugin sandboxing
function createPluginSandbox(pluginId: string, api: ShelterPluginApi) {
  const rateLimits = new Map<string, { count: number; reset: number }>();
  const MAX_REQUESTS = 100;
  const WINDOW_MS = 60000; // 1 minute

  const checkRateLimit = (key: string): boolean => {
    const now = Date.now();
    const limit = rateLimits.get(key) || { count: 0, reset: now + WINDOW_MS };

    if (now > limit.reset) {
      limit.count = 0;
      limit.reset = now + WINDOW_MS;
    }

    limit.count++;
    rateLimits.set(key, limit);
    return limit.count <= MAX_REQUESTS;
  };

  const sandbox = {
    console: {
      log: (...args: any[]) => log([`[${pluginId}]`, ...args]),
      warn: (...args: any[]) => log([`[${pluginId}]`, ...args], "warn"),
      error: (...args: any[]) => log([`[${pluginId}]`, ...args], "error"),
    },
    fetch: async (url: string, opts?: RequestInit) => {
      if (!checkRateLimit("fetch")) {
        throw new Error("Rate limit exceeded for fetch requests");
      }

      // Validate URL
      try {
        const parsedUrl = new URL(url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          throw new Error("Only HTTP(S) URLs are allowed");
        }
      } catch (e) {
        throw new Error(`Invalid URL: ${e.message}`);
      }

      return fetch(url, opts);
    },
    setTimeout: (cb: Function, ms: number) => {
      if (!checkRateLimit("setTimeout")) {
        throw new Error("Rate limit exceeded for setTimeout calls");
      }
      return setTimeout(cb, Math.min(ms, 30000));
    },
    setInterval: (cb: Function, ms: number) => {
      if (!checkRateLimit("setInterval")) {
        throw new Error("Rate limit exceeded for setInterval calls");
      }
      return setInterval(cb, Math.min(ms, 30000));
    },
  };

  return sandbox;
}

// Update plugin loading with enhanced error handling
export async function startPlugin(pluginId: string) {
  const data = untrack(() => internalData[pluginId]) as unknown as StoredPlugin;
  if (!data) throw new Error(`attempted to load a non-existent plugin: ${pluginId}`);
  if (internalLoaded[pluginId]) throw new Error("attempted to load an already loaded plugin");

  // Validate plugin
  const validationErrors = validatePlugin(data);
  if (validationErrors.length > 0) {
    const error = new Error(`Plugin validation failed: ${validationErrors.join(", ")}`);
    data.lastError = error.message;
    if (!data.usageStats) {
      data.usageStats = {
        startCount: 0,
        errorCount: 0,
        lastStarted: Date.now(),
        totalUptime: 0,
      };
    }
    data.usageStats.errorCount++;
    throw error;
  }

  // Create plugin API and await it
  const pluginApi = await createPluginApi(pluginId, data);
  const sandbox = createPluginSandbox(pluginId, Promise.resolve(pluginApi));

  const shelterPluginEdition = {
    ...window["shelter"],
    plugin: pluginApi,
    sandbox,
  };

  try {
    // Create a more secure evaluation context
    const pluginString = `shelter=>{return ${data.js}}${atob("Ci8v")}# sourceURL=s://!SHELTER/${pluginId}`;
    const rawPlugin: EvaledPlugin & PluginLifecycleHooks = (0, eval)(pluginString)(shelterPluginEdition);

    // Clone and enhance plugin with awaited pluginApi
    const plugin = {
      ...rawPlugin,
      scopedDispose: pluginApi.scoped.disposeAllNow,
      manifest: data.manifest,
      id: pluginId,
    };

    internalLoaded[pluginId] = plugin;

    // Handle async onLoad
    try {
      await Promise.resolve(plugin.onLoad?.());
    } catch (e) {
      log([`plugin ${pluginId} errored during onLoad`, e], "error");
      throw e;
    }

    data.enabledAt = Date.now();
    if (!data.usageStats) {
      data.usageStats = {
        startCount: 0,
        errorCount: 0,
        lastStarted: Date.now(),
        totalUptime: 0,
      };
    }
    data.usageStats.startCount++;
    data.usageStats.lastStarted = Date.now();
  } catch (e) {
    data.disabledAt = Date.now();
    if (!data.usageStats) {
      data.usageStats = {
        startCount: 0,
        errorCount: 0,
        lastStarted: Date.now(),
        totalUptime: 0,
      };
    }
    data.usageStats.errorCount++;
    data.lastError = e instanceof Error ? e.message : String(e);
    data.on = false;

    // Cleanup
    try {
      await Promise.resolve(internalLoaded[pluginId]?.onUnload?.());
    } catch (e2) {
      log([`plugin ${pluginId} errored while unloading`, e2], "error");
    }

    delete internalLoaded[pluginId];
    throw e;
  }
}

// Enhance plugin unloading
export async function stopPlugin(pluginId: string) {
  const data = untrack(() => internalData[pluginId]) as unknown as StoredPlugin;
  const loadedData = internalLoaded[pluginId];
  if (!data) throw new Error(`attempted to unload a non-existent plugin: ${pluginId}`);
  if (!loadedData) throw new Error(`attempted to unload a non-loaded plugin: ${pluginId}`);

  try {
    await Promise.resolve(loadedData.onUnload?.());
  } catch (e) {
    log([`plugin ${pluginId} errored while unloading`, e], "error");
  }

  try {
    loadedData.scopedDispose();
  } catch (e) {
    log([`plugin ${pluginId} errored while unloading scoped APIs`, e], "error");
  }

  // Update usage stats
  if (data.enabledAt && data.usageStats) {
    data.usageStats.totalUptime = (data.usageStats.totalUptime || 0) + (Date.now() - data.enabledAt);
  }
  data.disabledAt = Date.now();

  delete internalLoaded[pluginId];
  data.on = false;
}

// Update fetchUpdate function to handle URLs properly
async function fetchUpdate(pluginId: string): Promise<false | StoredPlugin> {
  const data = untrack(() => internalData[pluginId]) as unknown as StoredPlugin;
  if (!data) throw new Error(`attempted to update a non-existent plugin: ${pluginId}`);
  if (data.local) throw new Error("cannot check for updates to a local plugin.");
  if (!data.src) throw new Error("cannot check for updates to a plugin with no src");

  try {
    const manifestUrl = new URL("plugin.json", data.src);
    const jsUrl = new URL("plugin.js", data.src);

    const newPluginManifest = await (await fetch(manifestUrl, { cache: "no-store" })).json();
    if (data.manifest.hash !== undefined && newPluginManifest.hash === data.manifest.hash) return false;

    const newPluginText = await (await fetch(jsUrl, { cache: "no-store" })).text();

    return {
      ...data,
      js: newPluginText,
      manifest: newPluginManifest,
      lastUpdated: Date.now(),
    };
  } catch (e) {
    throw new Error(`failed to check for updates for ${pluginId}\n${prettifyError(e)}`, { cause: e });
  }
}

// Add plugin update notification
export async function updatePlugin(pluginId: string): Promise<boolean> {
  const data = untrack(() => internalData[pluginId]) as unknown as StoredPlugin;
  if (!data) throw new Error(`attempted to update a non-existent plugin: ${pluginId}`);

  try {
    const checked = await fetchUpdate(pluginId);

    if (checked) {
      const oldVersion = internalData[pluginId].manifest.version;
      editPlugin(pluginId, checked, true);

      // Notify plugin of update
      try {
        await Promise.resolve(internalLoaded[pluginId]?.onUpdate?.());
      } catch (e) {
        log([`plugin ${pluginId} errored during update notification`, e], "error");
      }

      log(`Updated ${pluginId} from ${oldVersion} to ${checked.manifest.version}`);
      if (!data.usageStats) {
        data.usageStats = {
          startCount: 0,
          errorCount: 0,
        };
      }
      data.usageStats.startCount++;
      data.usageStats.lastStarted = Date.now();
      return true;
    }

    return false;
  } catch (e) {
    if (!data.usageStats) {
      data.usageStats = {
        startCount: 0,
        errorCount: 0,
      };
    }
    data.usageStats.errorCount++;
    data.lastError = e.message;
    throw e;
  }
}

// Add plugin settings change notification
export function updatePluginSettings(pluginId: string, settings: Record<string, any>) {
  const plugin = internalLoaded[pluginId];
  if (!plugin) return;

  try {
    Promise.resolve(plugin.onSettingsChange?.(settings)).catch((e) => {
      log([`plugin ${pluginId} errored during settings change`, e], "error");
    });
  } catch (e) {
    log([`plugin ${pluginId} errored during settings change`, e], "error");
  }
}

export const getSettings = (id: string) => internalLoaded[id]?.settings;

export function showSettingsFor(id: string) {
  const p = internalLoaded[id];
  if (!p) throw new Error(`cannot show plugins for non-loaded plugin ${id}`);
  if (!p.settings) throw new Error(`cannot show plugins for ${id}, which has no settings`);

  return new Promise<void>((res) => {
    openModal((mprops) => {
      onCleanup(res);
      const plugin = getPluginData(id);
      if (!plugin) throw new Error(`cannot show settings for non-existent plugin ${id}`);
      return (
        <ModalRoot>
          <ModalHeader close={mprops.close}>Settings - {plugin.name}</ModalHeader>
          <ModalBody>{p.settings({})}</ModalBody>
        </ModalRoot>
      );
    });
  });
}

// Update plugin store handling
export function getPluginStore<T>(pluginId: string): ShelterStore<T> {
  const data = getPluginData(pluginId);
  if (!data) throw new Error(`attempted to get store for non-existent plugin: ${pluginId}`);
  return data.store as unknown as ShelterStore<T>;
}

// Update plugin data access
export function getPlugin(id: string): StoredPlugin {
  const data = getPluginData(id);
  if (!data) throw new Error(`attempted to get data for non-existent plugin: ${id}`);
  return data;
}

// Update plugin manifest access
export function getPluginManifest(pluginId: string): PluginMetadata {
  const data = getPluginData(pluginId);
  if (!data) throw new Error(`attempted to get manifest for non-existent plugin: ${pluginId}`);
  return data.manifest;
}
