/**
 * Local session persistence.
 *
 * The product promises the file never leaves the tab. That promise is worth
 * very little if the analysis also evaporates the moment the tab closes, so the
 * workbench keeps a copy of the parsed dataset and the working state in
 * IndexedDB — on this device, in this browser profile, readable by nothing but
 * this origin.
 *
 * Three records, deliberately:
 *   meta      — a few fields describing what is stored. Read on every visit.
 *   dataset   — written once when a file is parsed. Several MB of typed arrays.
 *   workspace — written on every change to filters, shortlist, sort or mode.
 *
 * Splitting them keeps the hot path (typing a note) from rewriting megabytes,
 * and keeps the "continue where you left off" card from having to deserialise a
 * whole genome before it can render one sentence.
 * IndexedDB stores the columnar arrays by structured clone, so the round trip
 * costs no serialisation and no precision.
 *
 * Nothing here touches the network. IndexedDB is not an egress channel, and the
 * page's `connect-src 'none'` means there is no egress channel to reach.
 */
import type { Filter, ShortlistEntry, Sort, ViewMode } from "./store";
import type { Dataset, FindingCriteria } from "./types";

const DB_NAME = "locuslocal";
const DB_VERSION = 1;
const STORE = "session";
const DATASET_KEY = "dataset";
const META_KEY = "meta";
const WORKSPACE_KEY = "workspace";
const STORE_RO: IDBTransactionMode = "readonly";
const STORE_RW: IDBTransactionMode = "readwrite";

export interface SavedDataset {
  dataset: Dataset;
  savedAt: number;
}

export interface SavedMeta {
  markers: number;
  savedAt: number;
  sourceName: string;
}

export interface SavedWorkspace {
  filters: Filter[];
  guided: FindingCriteria;
  mode: ViewMode;
  savedAt: number;
  shortlist: ShortlistEntry[];
  sort: Sort;
}

/**
 * IndexedDB is unavailable in some private-browsing modes and can be disabled
 * outright. Every call here resolves to null rather than throwing, because
 * losing persistence must never break the analysis.
 */
function open(version: number): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB) {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, version);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/**
 * Open the database, repairing it if the object store is missing.
 *
 * A database created by an earlier build can exist at DB_VERSION without the
 * `session` store, and opening at the same version never fires
 * `onupgradeneeded` — so that state was permanent, and every later
 * `transaction()` threw `NotFoundError` synchronously. Bumping past whatever
 * version is actually on disk creates the store once and fixes it for good.
 */
async function openDb(): Promise<IDBDatabase | null> {
  const db = await open(DB_VERSION);
  if (!db) {
    return null;
  }
  if (db.objectStoreNames.contains(STORE)) {
    return db;
  }
  const next = db.version + 1;
  db.close();
  const repaired = await open(next);
  if (!repaired) {
    return null;
  }
  if (repaired.objectStoreNames.contains(STORE)) {
    return repaired;
  }
  repaired.close();
  return null;
}

/**
 * Run one transaction and always settle.
 *
 * Two ways this used to hang or throw despite the never-throws contract above:
 * `db.transaction()` raises synchronously when the store is missing, and a
 * transaction aborted by a quota error or a `versionchange` fires neither
 * `oncomplete` nor `onerror` — only `onabort`, which nothing was listening for,
 * leaving `resumeSession` awaiting a promise that never settled.
 */
async function withTx<T>(
  mode: IDBTransactionMode,
  fallback: T,
  work: (tx: IDBTransaction, done: (value: T) => void) => void
): Promise<T> {
  const db = await openDb();
  if (!db) {
    return fallback;
  }
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      db.close();
      resolve(value);
    };
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
    } catch {
      done(fallback);
      return;
    }
    tx.onerror = () => done(fallback);
    tx.onabort = () => done(fallback);
    try {
      work(tx, done);
    } catch {
      done(fallback);
    }
  });
}

function put(key: string, value: unknown): Promise<boolean> {
  return withTx(STORE_RW, false, (tx, done) => {
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => done(true);
  });
}

function get<T>(key: string): Promise<T | null> {
  return withTx<T | null>(STORE_RO, null, (tx, done) => {
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => done((req.result as T | undefined) ?? null);
    req.onerror = () => done(null);
  });
}

export async function saveDataset(dataset: Dataset): Promise<boolean> {
  const savedAt = Date.now();
  const meta: SavedMeta = {
    markers: dataset.n,
    savedAt,
    sourceName: dataset.sourceName,
  };
  const [okMeta, okData] = await Promise.all([
    put(META_KEY, meta),
    put(DATASET_KEY, { dataset, savedAt }),
  ]);
  return okMeta && okData;
}

export function saveWorkspace(
  workspace: Omit<SavedWorkspace, "savedAt">
): Promise<boolean> {
  return put(WORKSPACE_KEY, { ...workspace, savedAt: Date.now() });
}

export function readDataset(): Promise<SavedDataset | null> {
  return get<SavedDataset>(DATASET_KEY);
}

export function readMeta(): Promise<SavedMeta | null> {
  return get<SavedMeta>(META_KEY);
}

export function readWorkspace(): Promise<SavedWorkspace | null> {
  return get<SavedWorkspace>(WORKSPACE_KEY);
}

export function deleteEverything(): Promise<boolean> {
  return withTx(STORE_RW, false, (tx, done) => {
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => done(true);
  });
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function describeAge(savedAt: number): string {
  const delta = Date.now() - savedAt;
  if (delta < MINUTE_MS) {
    return "moments ago";
  }
  if (delta < HOUR_MS) {
    const m = Math.round(delta / MINUTE_MS);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (delta < DAY_MS) {
    const h = Math.round(delta / HOUR_MS);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.round(delta / DAY_MS);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
