export const MOCKFORGE_DB_NAME = "mockforge";
export const MOCKFORGE_DB_VERSION = 1;

let databasePromise: Promise<IDBDatabase> | undefined;
let openDatabaseConnection: IDBDatabase | undefined;

function requestError(request: IDBRequest): Error {
  const reason = request.error;
  return new Error(reason?.message || "IndexedDB request failed.");
}

function createDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("IndexedDB is not available in this browser."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MOCKFORGE_DB_NAME, MOCKFORGE_DB_VERSION);
    let blocked = false;

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("pdfs")) {
        const store = database.createObjectStore("pdfs", { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }

      if (!database.objectStoreNames.contains("extractions")) {
        const store = database.createObjectStore("extractions", { keyPath: "id" });
        store.createIndex("sourcePdfId", "sourcePdfId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }

      if (!database.objectStoreNames.contains("mockTests")) {
        const store = database.createObjectStore("mockTests", { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("name", "name", { unique: false });
      }

      if (!database.objectStoreNames.contains("attempts")) {
        const store = database.createObjectStore("attempts", { keyPath: "id" });
        store.createIndex("mockTestId", "mockTestId", { unique: false });
        store.createIndex("startedAt", "startedAt", { unique: false });
        store.createIndex("completedAt", "completedAt", { unique: false });
        store.createIndex("mockTestStarted", ["mockTestId", "startedAt"], { unique: false });
        store.createIndex("mockTestCompleted", ["mockTestId", "completedAt"], { unique: false });
      }

      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      openDatabaseConnection = database;
      const closeConnection = () => {
        if (openDatabaseConnection === database) {
          openDatabaseConnection = undefined;
          databasePromise = undefined;
        }
        database.close();
      };
      database.onversionchange = closeConnection;
      database.onclose = () => {
        if (openDatabaseConnection === database) {
          openDatabaseConnection = undefined;
          databasePromise = undefined;
        }
      };
      resolve(database);
    };
    request.onerror = () => reject(requestError(request));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Opening MockForge storage is blocked by another database connection."));
    };
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    const opening = createDatabase();
    databasePromise = opening.catch((error) => {
      databasePromise = undefined;
      openDatabaseConnection = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export function createStableId(prefix: string): string {
  if ("crypto" in globalThis && typeof globalThis.crypto.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
