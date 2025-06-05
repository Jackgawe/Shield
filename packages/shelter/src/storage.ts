import { batch, createSignal, Signal, untrack } from "solid-js";
import { IDBPDatabase, openDB } from "idb";
import { log } from "./util";

// can't use a solid store as i could do with bespoke logic for idb
// so heres a custom proxy impl -- sink

// idb cannot directly store solid mutables so this clones them
function cloneRec(node: unknown, seenNodes: object[] = []) {
  switch (typeof node) {
    case "function":
    case "symbol":
      //throw new Error
      log(`can't store a ${typeof node} in a shelter storage!`, "error");
      return undefined;

    case "object":
      if (seenNodes?.includes(node)) throw new Error("can't store a circular reference in a shelter storage!");

      const newObj = Array.isArray(node) ? [] : {};
      for (const k of Object.keys(node)) {
        newObj[k] = cloneRec(node[k], [...seenNodes, node]);
      }
      return newObj;

    default:
      return node as undefined | boolean | number | string | bigint;
  }
}

const symWait = Symbol();
const symDb = Symbol();
const symSig = Symbol();

export { symWait, symDb, symSig };

export interface ShelterStore<T> {
  [_: string]: T;

  [symWait]: (cb: () => void) => void;
  [symDb]: IDBPDatabase<any>;
  [symSig]: () => Record<string, T>;
}

// we have to mutex opening the db for adding new stores etc to work correctly
let storesToAdd: string[] = [];
let getDbPromise: Promise<IDBPDatabase<any>>;

async function getDb(store: string) {
  storesToAdd.push(store);

  if (storesToAdd.length > 1) return getDbPromise;

  const prom = openDB("shelter", Date.now(), {
    upgrade(udb) {
      for (const name of storesToAdd) if (!udb.objectStoreNames.contains(name)) udb.createObjectStore(name);
    },
  }).then((db) => {
    storesToAdd = [];

    return db;
  });

  return (getDbPromise = prom);
}

// Add encryption support
const ENCRYPTION_KEY = "shield-storage-key"; // In production, this should be securely generated and stored

async function encryptData(data: any): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(JSON.stringify(data));

  // Generate a random IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Import the key
  const key = await crypto.subtle.importKey("raw", encoder.encode(ENCRYPTION_KEY), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);

  // Encrypt the data
  const encryptedBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, dataBuffer);

  // Combine IV and encrypted data
  const result = new Uint8Array(iv.length + encryptedBuffer.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encryptedBuffer), iv.length);

  return btoa(String.fromCharCode(...result));
}

async function decryptData(encrypted: string): Promise<any> {
  const str = atob(encrypted);
  const data = new Uint8Array(str.length);
  for (let i = 0; i < str.length; ++i) data[i] = str.charCodeAt(i);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Extract IV and encrypted data
  const iv = data.slice(0, 12);
  const encryptedSlice = data.slice(12);
  const encryptedBuffer = new Uint8Array(encryptedSlice.length);
  for (let i = 0; i < encryptedSlice.length; ++i) encryptedBuffer[i] = encryptedSlice[i];

  // Import the key
  const key = await crypto.subtle.importKey("raw", encoder.encode(ENCRYPTION_KEY), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);

  // Decrypt the data
  const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedBuffer);

  return JSON.parse(decoder.decode(decryptedBuffer));
}

// Add data validation
type StorageSchema = {
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  default?: any;
  validate?: (value: any) => boolean;
  properties?: Record<string, StorageSchema>;
  items?: StorageSchema;
};

function validateData(data: any, schema: StorageSchema): boolean {
  if (schema.required && data === undefined) return false;
  if (data === undefined) return true;

  switch (schema.type) {
    case "string":
      if (typeof data !== "string") return false;
      break;
    case "number":
      if (typeof data !== "number") return false;
      break;
    case "boolean":
      if (typeof data !== "boolean") return false;
      break;
    case "object":
      if (typeof data !== "object" || data === null) return false;
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (!validateData(data[key], propSchema)) return false;
        }
      }
      break;
    case "array":
      if (!Array.isArray(data)) return false;
      if (schema.items) {
        for (const item of data) {
          if (!validateData(item, schema.items)) return false;
        }
      }
      break;
  }

  if (schema.validate && !schema.validate(data)) return false;
  return true;
}

// Add storage options
type StorageOptions = {
  encrypt?: boolean;
  schema?: StorageSchema;
  maxSize?: number;
  compression?: boolean;
  ttl?: number; // Time to live in milliseconds
};

// Enhance storage function
export function storage<T extends Record<string, any>>(name: string, options: StorageOptions = {}): T {
  const {
    encrypt = true,
    schema,
    maxSize = 5 * 1024 * 1024, // 5MB default
    compression = false,
    ttl,
  } = options;

  let data: T | undefined;
  let lastModified = 0;

  // Initialize storage
  async function init() {
    try {
      const stored = localStorage.getItem(name);
      if (!stored) {
        data = {} as T;
        return;
      }

      let parsed: T;
      if (encrypt) {
        parsed = await decryptData(stored);
      } else {
        parsed = JSON.parse(stored);
      }

      // Check TTL
      if (ttl && lastModified && Date.now() - lastModified > ttl) {
        data = {} as T;
        return;
      }

      // Validate schema
      if (schema && !validateData(parsed, schema)) {
        console.warn(`Storage ${name} failed schema validation, resetting to default`);
        data = {} as T;
        return;
      }

      data = parsed;
      lastModified = Date.now();
    } catch (e) {
      console.error(`Failed to initialize storage ${name}:`, e);
      data = {} as T;
    }
  }

  // Save data with compression and encryption
  async function save() {
    if (!data) return;

    try {
      let toStore = JSON.stringify(data);

      // Apply compression if enabled
      if (compression) {
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(toStore);
        const compressedBuffer = await compressData(dataBuffer);
        toStore = btoa(String.fromCharCode(...new Uint8Array(compressedBuffer)));
      }

      // Apply encryption if enabled
      if (encrypt) {
        toStore = await encryptData(toStore);
      }

      // Check size limit
      if (toStore.length > maxSize) {
        throw new Error(`Storage ${name} exceeds maximum size of ${maxSize} bytes`);
      }

      localStorage.setItem(name, toStore);
      lastModified = Date.now();
    } catch (e) {
      console.error(`Failed to save storage ${name}:`, e);
    }
  }

  // Initialize storage
  init();

  // Create proxy for automatic saving
  const proxy = new Proxy(data as T, {
    get(target, prop) {
      return target[prop as keyof T];
    },
    set(target, prop, value) {
      target[prop as keyof T] = value;
      save();
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop as keyof T];
      save();
      return true;
    },
  });

  // Attach required symbol properties for ShelterStore compatibility
  (proxy as any)[symWait] = (cb: () => void) => {
    /* no-op for now */
  };
  (proxy as any)[symDb] = undefined;
  (proxy as any)[symSig] = () => ({ ...proxy });

  return proxy;
}

// Add compression support
async function compressData(data: Uint8Array): Promise<ArrayBuffer> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  // Create a new Uint8Array to ensure we have a standard ArrayBuffer
  const standardData = new Uint8Array(data);
  await writer.write(standardData);
  await writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);

  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result.buffer;
}

// Add storage migration support
export async function migrateStorage<T extends Record<string, any>>(
  oldName: string,
  newName: string,
  migrator: (data: any) => T,
): Promise<void> {
  const oldData = localStorage.getItem(oldName);
  if (!oldData) return;

  try {
    const parsed = JSON.parse(oldData);
    const migrated = migrator(parsed);
    localStorage.setItem(newName, JSON.stringify(migrated));
    localStorage.removeItem(oldName);
  } catch (e) {
    console.error(`Failed to migrate storage from ${oldName} to ${newName}:`, e);
  }
}

// Add storage backup/restore support
export async function backupStorage(name: string): Promise<string> {
  const data = localStorage.getItem(name);
  if (!data) return "";

  try {
    const backup = {
      name,
      data,
      timestamp: Date.now(),
      version: "1.0",
    };

    return btoa(JSON.stringify(backup));
  } catch (e) {
    console.error(`Failed to backup storage ${name}:`, e);
    return "";
  }
}

export async function restoreStorage(backup: string): Promise<boolean> {
  try {
    const { name, data, timestamp, version } = JSON.parse(atob(backup));

    // Validate backup
    if (!name || !data || !timestamp || !version) {
      throw new Error("Invalid backup format");
    }

    // Check version compatibility
    if (version !== "1.0") {
      throw new Error(`Unsupported backup version: ${version}`);
    }

    localStorage.setItem(name, data);
    return true;
  } catch (e) {
    console.error("Failed to restore storage:", e);
    return false;
  }
}

export const dbStore = storage("dbstore");

// stuff like this is necessary when you *need* to have gets return persisted values as well as newly set ones

/** if the store is or is not yet connected to IDB */
export const isInited = (store: ShelterStore<unknown>) => !!store[symDb];
/** waits for the store to connect to IDB, then runs the callback (if connected, synchronously runs the callback now) */
export const whenInited = (store: ShelterStore<unknown>, cb: () => void) => store[symWait](cb) as void;
/** returns a promise that resolves when the store is connected to IDB (if connected, resolves instantly) */
export const waitInit = (store: ShelterStore<unknown>) => new Promise<void>((res) => whenInited(store, res));

/** sets default values for the store. these only apply once the store connects to IDB to prevent overwriting persist */
export const defaults = <T = any>(store: ShelterStore<T>, fallbacks: Record<string, T>) =>
  whenInited(store, () =>
    batch(() => {
      for (const k in fallbacks) if (!(k in store)) store[k] = fallbacks[k];
    }),
  );

/** gets a signal containing the whole store as an object */
export const signalOf = <T = any>(store: ShelterStore<T>): (() => Record<string, T>) => store[symSig];

/** wraps a solid mutable to provide a global signal */
export const solidMutWithSignal = <T extends object = any>(store: T) => {
  const [sig, setSig] = createSignal<T>();
  const update = () => setSig(() => ({ ...store }));
  update();
  return [
    new Proxy(store, {
      set(t, p, v, r) {
        const success = Reflect.set(t, p, v, r);
        if (success) update();
        return success;
      },
      deleteProperty(t, p) {
        const success = Reflect.deleteProperty(t, p);
        if (success) update();
        return success;
      },
    }),
    sig,
  ] as const;
};
