import { openDatabase } from "./database";
import type {
  AttemptRecord,
  ExtractionRecord,
  MockTestRecord,
  PdfRecord,
  SettingRecord,
} from "./types";

type StoredRecord = PdfRecord | ExtractionRecord | MockTestRecord | AttemptRecord | SettingRecord;

function requestError(request: IDBRequest): Error {
  const reason = request.error;
  const detail = reason?.message || reason?.name;
  return new Error(detail ? `IndexedDB request failed: ${detail}` : "IndexedDB request failed.");
}

async function abortForOperationError(transaction: IDBTransaction, error: unknown, completion: Promise<void>): Promise<never> {
  try {
    transaction.abort();
  } catch {
    // The transaction may already be complete or aborted.
  }
  await completion.catch(() => undefined);
  throw error instanceof Error ? error : new Error(String(error));
}

async function executeRequest<TResult>(
  storeName: "pdfs" | "extractions" | "mockTests" | "attempts" | "settings",
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<TResult> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const completion = transactionDone(transaction);
  let request: IDBRequest;
  try {
    request = operation(store);
  } catch (error) {
    return abortForOperationError(transaction, error, completion);
  }
  const requestResult = new Promise<TResult>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as TResult);
    request.onerror = () => reject(requestError(request));
  });
  const [requestOutcome, completionOutcome] = await Promise.allSettled([requestResult, completion]);
  if (completionOutcome.status === "rejected") throw completionOutcome.reason;
  if (requestOutcome.status === "rejected") throw requestOutcome.reason;
  return requestOutcome.value;
}

async function executeTransaction<TResult>(
  storeName: "pdfs" | "extractions" | "mockTests" | "attempts" | "settings",
  operation: (transaction: IDBTransaction) => IDBRequest,
): Promise<TResult> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const completion = transactionDone(transaction);
  let request: IDBRequest;
  try {
    request = operation(transaction);
  } catch (error) {
    return abortForOperationError(transaction, error, completion);
  }
  const requestResult = new Promise<TResult>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as TResult);
    request.onerror = () => reject(requestError(request));
  });
  const [requestOutcome, completionOutcome] = await Promise.allSettled([requestResult, completion]);
  if (completionOutcome.status === "rejected") throw completionOutcome.reason;
  if (requestOutcome.status === "rejected") throw requestOutcome.reason;
  return requestOutcome.value;
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error
        ? new Error(`IndexedDB transaction aborted: ${transaction.error.message || transaction.error.name}`)
        : new Error("IndexedDB transaction aborted."),
    );
    transaction.onerror = () => reject(
      transaction.error
        ? new Error(`IndexedDB transaction failed: ${transaction.error.message || transaction.error.name}`)
        : new Error("IndexedDB transaction failed."),
    );
  });
}

async function addRecord<T extends StoredRecord>(storeName: "pdfs" | "extractions" | "mockTests" | "attempts" | "settings", record: T): Promise<T> {
  await executeRequest(storeName, "readwrite", (store) => store.add(record));
  return record;
}

async function putRecord<T extends StoredRecord>(storeName: "pdfs" | "extractions" | "mockTests" | "attempts" | "settings", record: T): Promise<T> {
  await executeRequest(storeName, "readwrite", (store) => store.put(record));
  return record;
}

async function updateExistingRecord<T extends PdfRecord | MockTestRecord>(
  storeName: "pdfs" | "mockTests",
  record: T,
): Promise<T> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(record);
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      }
    };
    const getRequest = store.get(record.id);
    getRequest.onerror = () => {
      try {
        transaction.abort();
      } catch {
        // The transaction may already be complete or aborted.
      }
    };
    getRequest.onsuccess = () => {
      if (!getRequest.result) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be complete or aborted.
        }
        if (!settled) {
          settled = true;
          reject(new Error("The record no longer exists."));
        }
        return;
      }
      const putRequest = store.put(record);
      putRequest.onerror = () => {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be complete or aborted.
        }
      };
    };
  });
}

async function getRecord<T extends StoredRecord>(storeName: "pdfs" | "extractions" | "mockTests" | "attempts" | "settings", id: string): Promise<T | undefined> {
  return executeRequest(storeName, "readonly", (store) => store.get(id));
}

async function listRecords<T extends StoredRecord>(storeName: "pdfs" | "extractions" | "mockTests" | "attempts" | "settings", indexName?: string): Promise<T[]> {
  return executeTransaction<T[]>(
    storeName,
    (transaction) => {
      const store = transaction.objectStore(storeName);
      return indexName ? store.index(indexName).getAll() : store.getAll();
    },
  );
}

async function deleteRecord(storeName: "pdfs" | "extractions" | "mockTests" | "attempts" | "settings", id: string): Promise<void> {
  await executeRequest(storeName, "readwrite", (store) => store.delete(id));
}

export async function addPdf(record: PdfRecord): Promise<PdfRecord> {
  return addRecord("pdfs", record);
}
export async function savePdfRecord(record: PdfRecord): Promise<PdfRecord> {
  const database = await openDatabase();
  const transaction = database.transaction("pdfs", "readwrite");
  const store = transaction.objectStore("pdfs");

  return new Promise<PdfRecord>((resolve, reject) => {
    let savedRecord = record;
    let settled = false;

    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(savedRecord);
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      }
    };

    const listRequest = store.getAll();
    listRequest.onerror = () => {
      try {
        transaction.abort();
      } catch {
        // The transaction may already be complete or aborted.
      }
    };
    listRequest.onsuccess = () => {
      const existingPdfs = listRequest.result as PdfRecord[];
      const duplicate = existingPdfs.find((pdf) =>
        pdf.filename === record.filename &&
        pdf.size === record.size &&
        pdf.pageCount === record.pageCount &&
        record.lastModified !== undefined &&
        pdf.lastModified === record.lastModified
      );

      if (duplicate) {
        savedRecord = duplicate;
        return;
      }

      const addRequest = store.add(record);
      addRequest.onerror = () => {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be complete or aborted.
        }
      };
    };
  });
}
export async function getPdf(id: string): Promise<PdfRecord | undefined> {
  return getRecord<PdfRecord>("pdfs", id);
}
export async function updatePdf(record: PdfRecord): Promise<PdfRecord> {
  return updateExistingRecord("pdfs", record);
}
export async function deletePdf(id: string): Promise<void> {
  return deleteRecord("pdfs", id);
}
export async function listPdfs(): Promise<PdfRecord[]> {
  return listRecords<PdfRecord>("pdfs", "createdAt");
}

export async function addExtraction(record: ExtractionRecord): Promise<ExtractionRecord> {
  return addRecord("extractions", record);
}
export async function getExtraction(id: string): Promise<ExtractionRecord | undefined> {
  return getRecord<ExtractionRecord>("extractions", id);
}
export async function updateExtraction(record: ExtractionRecord): Promise<ExtractionRecord> {
  return putRecord("extractions", record);
}
export async function deleteExtraction(id: string): Promise<void> {
  return deleteRecord("extractions", id);
}
export async function listExtractions(): Promise<ExtractionRecord[]> {
  return listRecords<ExtractionRecord>("extractions", "createdAt");
}
export async function listExtractionsByPdf(sourcePdfId: string): Promise<ExtractionRecord[]> {
  return executeTransaction<ExtractionRecord[]>(
    "extractions",
    (transaction) => transaction.objectStore("extractions").index("sourcePdfId").getAll(sourcePdfId),
  );
}

export async function addMockTest(record: MockTestRecord): Promise<MockTestRecord> {
  return addRecord("mockTests", record);
}
export async function getMockTest(id: string): Promise<MockTestRecord | undefined> {
  return getRecord<MockTestRecord>("mockTests", id);
}
export async function updateMockTest(record: MockTestRecord): Promise<MockTestRecord> {
  return updateExistingRecord("mockTests", record);
}
export async function deleteMockTest(id: string): Promise<void> {
  return deleteRecord("mockTests", id);
}
export async function listMockTests(): Promise<MockTestRecord[]> {
  return listRecords<MockTestRecord>("mockTests", "createdAt");
}

export async function addAttempt(record: AttemptRecord): Promise<AttemptRecord> {
  return addRecord("attempts", record);
}
export async function getAttempt(id: string): Promise<AttemptRecord | undefined> {
  return getRecord<AttemptRecord>("attempts", id);
}
export async function updateAttempt(record: AttemptRecord): Promise<AttemptRecord> {
  const database = await openDatabase();
  const transaction = database.transaction("attempts", "readwrite");
  const store = transaction.objectStore("attempts");

  return new Promise<AttemptRecord>((resolve, reject) => {
    let settled = false;
    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(record);
      }
    };
    transaction.onabort = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
      }
    };
    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error ?? new Error("IndexedDB transaction failed."));
      }
    };

    const getRequest = store.get(record.id);
    getRequest.onerror = () => {
      try {
        transaction.abort();
      } catch {
        // The transaction may already be complete or aborted.
      }
      if (!settled) {
        settled = true;
        reject(requestError(getRequest));
      }
    };
    getRequest.onsuccess = () => {
      if (!getRequest.result) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be complete or aborted.
        }
        if (!settled) {
          settled = true;
          reject(new Error("The in-progress attempt no longer exists and cannot be recreated."));
        }
        return;
      }
      const existing = getRequest.result as AttemptRecord;
      if (existing.status === "completed" && record.status !== "completed") {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be complete or aborted.
        }
        if (!settled) {
          settled = true;
          reject(new Error("A completed attempt cannot be changed by an autosave checkpoint."));
        }
        return;
      }
      const putRequest = store.put(record);
      putRequest.onerror = () => {
        try {
          transaction.abort();
        } catch {
          // The transaction may already be complete or aborted.
        }
      };
    };
  });
}
export async function deleteAttempt(id: string): Promise<void> {
  return deleteRecord("attempts", id);
}
export async function listAttempts(): Promise<AttemptRecord[]> {
  return listRecords<AttemptRecord>("attempts", "startedAt");
}
export async function listAttemptsByMockTest(mockTestId: string): Promise<AttemptRecord[]> {
  return executeTransaction<AttemptRecord[]>(
    "attempts",
    (transaction) => transaction.objectStore("attempts").index("mockTestId").getAll(mockTestId),
  );
}

export async function getSetting(key: string): Promise<unknown | undefined> {
  const record = await getRecord<SettingRecord>("settings", key);
  return record?.value;
}
export async function setSetting(key: string, value: unknown): Promise<SettingRecord> {
  return putRecord("settings", {
    key,
    value,
    updatedAt: Date.now(),
  });
}
export async function deleteSetting(key: string): Promise<void> {
  return deleteRecord("settings", key);
}
export async function listSettings(): Promise<SettingRecord[]> {
  return listRecords<SettingRecord>("settings");
}
