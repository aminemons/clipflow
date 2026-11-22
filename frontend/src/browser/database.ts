const databaseName = "clipflow-browser-workspace";
type Table = "projects" | "sources" | "jobs" | "artifacts";

let database: Promise<IDBDatabase> | undefined;
function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      for (const table of ["projects", "sources", "jobs", "artifacts"]) request.result.createObjectStore(table);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
  });
  return database;
}

export async function transaction<T>(tables: Table[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T>) {
  const handle = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = handle.transaction(tables, mode);
    const request = work(tx);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error("Local storage operation was interrupted."));
    tx.onerror = () => reject(tx.error ?? request.error);
  });
}

export const read = <T>(table: Table, id: string) => transaction<T | undefined>([table], "readonly", tx => tx.objectStore(table).get(id));
export const list = <T>(table: Table) => transaction<T[]>([table], "readonly", tx => tx.objectStore(table).getAll());
export const put = <T>(table: Table, id: string, value: T) => transaction([table], "readwrite", tx => tx.objectStore(table).put(value, id));
export const remove = (table: Table, id: string) => transaction([table], "readwrite", tx => tx.objectStore(table).delete(id));

export async function revise<T, R>(table: Table, id: string, edit: (current: T | undefined) => [T, R]) {
  const handle = await open();
  return new Promise<R>((resolve, reject) => {
    const tx = handle.transaction(table, "readwrite");
    const records = tx.objectStore(table);
    let result: R;
    let failure: unknown;
    const request = records.get(id);
    request.onsuccess = () => {
      try {
        const [value, output] = edit(request.result);
        result = output;
        records.put(value, id);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Local edit was not saved."));
    tx.onerror = () => reject(tx.error ?? request.error);
  });
}
