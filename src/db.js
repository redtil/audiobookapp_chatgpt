// What the device keeps for itself: settings, a copy of the library status,
// and the books' text (so they open quickly and offline). The library itself
// lives on the server; audio is cached separately (see player.js).

import { STORAGE_PREFIX } from "./config.js";

const DB_NAME = `${STORAGE_PREFIX}-v2`;

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("books", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(mode = "readonly") {
  return (await db()).transaction("books", mode).objectStore("books");
}

export async function putBook(book) {
  try {
    await done((await store("readwrite")).put(book));
  } catch {}
}

export async function getBook(id) {
  try {
    return await done((await store()).get(id));
  } catch {
    return null;
  }
}

export async function deleteBook(id) {
  try {
    await done((await store("readwrite")).delete(id));
  } catch {}
}

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export const loadSettings = () => load(`${STORAGE_PREFIX}-settings`, {});
export const saveSettings = (s) => save(`${STORAGE_PREFIX}-settings`, s);
export const loadLibrary = () => load(`${STORAGE_PREFIX}-library`, { books: {} });
export const saveLibrary = (l) => save(`${STORAGE_PREFIX}-library`, l);
