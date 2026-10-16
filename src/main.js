import { readBook, bookIdFor } from "./book.js";
import * as db from "./db.js";
import { Library, mergeLibraries, isRemoved } from "./cloud.js";
import { Player, cached, forgetAudio } from "./player.js";
import { VOICES, voiceLabel } from "./voices.js";
import { formatTime, formatDuration } from "./format.js";
import { estimateSeconds } from "./plan.js";
import { MusicEngine, MOODS } from "./music.js";
import { chapterMood } from "./mood.js";
import { APP_NAME, repositoryDefaults } from "./config.js";

const $ = (id) => document.getElementById(id);
const el = new Proxy({}, { get: (_, id) => $(id) });

const CHARS_PER_SECOND = 15; // speaking rate at 1×, for estimates
const settings = { voice: "af_heart", speed: 1, musicLevel: "off", ...db.loadSettings() };
// Earlier versions had an on/off switch.
if (settings.music !== undefined) {
  if (settings.musicLevel === "off" && settings.music) settings.musicLevel = "medium";
  delete settings.music;
  delete settings.musicVolume;
}
const musicOn = () => settings.musicLevel !== "off";
const LEVEL_ORDER = ["off", "faint", "soft", "medium", "strong", "full"];
const LEVEL_NAMES = { off: "Off", faint: "Faint", soft: "Soft", medium: "Medium", strong: "Strong", full: "Full" };
// Loudness of the live composer at each level.
const LIVE_VOLUME = { faint: 0.2, soft: 0.33, medium: 0.5, strong: 0.72, full: 0.95 };
const save = () => db.saveSettings(settings);

let cloud = null; // Library, once connected
let library = db.loadLibrary(); // { books: { id: entry } }
const status = {}; // id -> { index, made, done (0..1), running, failed, startedAt }
let book = null; // the open book (full text)
let shownCh = -1;
let spans = [];

// ---------- connecting ----------

const defaults = () => repositoryDefaults(location);

// A link from "Add another device" carries the key in the #fragment, which
// never leaves the browser.
function takeKeyFromLink() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (!hash.get("key")) return;
  settings.conn = {
    ...defaults(),
    key: hash.get("key"),
    ...(hash.get("lib") ? { dataRepo: hash.get("lib") } : {}),
    ...(hash.get("app") ? { appRepo: hash.get("app") } : {}),
  };
  save();
  history.replaceState(null, "", location.pathname + location.search);
}

function showConnect(error) {
  el.connect.hidden = false;
  el.library.hidden = true;
  el.bookScreen.hidden = true;
  const d = { ...defaults(), ...settings.conn };
  el.dataRepoInput.value ||= d.dataRepo;
  el.appRepoInput.value ||= d.appRepo;
  el.appRepoName.textContent = d.appRepo ? d.appRepo.split("/")[1] : "this app's repository";
  el.connectError.textContent = error || "";
  el.connectError.hidden = !error;
}

el.connectBtn.addEventListener("click", async () => {
  const conn = {
    key: el.keyInput.value.trim(),
    dataRepo: el.dataRepoInput.value.trim(),
    appRepo: el.appRepoInput.value.trim(),
  };
  if (!conn.key) return showConnect("Paste your library key.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(conn.dataRepo) || !/^[\w.-]+\/[\w.-]+$/.test(conn.appRepo)) {
    el.connect.querySelector(".advanced").open = true;
    return showConnect("Fill in the library and app under Advanced (as owner/name).");
  }
  el.connectBtn.disabled = true;
  try {
    const lib = new Library(conn);
    await lib.check();
    cloud = lib;
    settings.conn = conn;
    save();
    await showLibrary();
  } catch (err) {
    showConnect(err.message);
  } finally {
    el.connectBtn.disabled = false;
  }
});

// ---------- library state ----------

const entry = (id) => library.books[id];

function updateEntry(id, changes, delay = 2000) {
  const e = library.books[id];
  if (!e) return;
  Object.assign(e, changes);
  db.saveLibrary(library);
  syncSoon(delay);
}

let syncTimer = null;
let syncing = null;

function syncSoon(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}

async function syncNow() {
  if (!cloud) return;
  clearTimeout(syncTimer);
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const merged = await cloud.syncLibrary(library);
      library = mergeLibraries(merged, library); // keep changes made meanwhile
      db.saveLibrary(library);
      el.syncState.textContent = "";
      return true;
    } catch (err) {
      console.warn("Sync failed", err);
      el.syncState.textContent = navigator.onLine === false ? "Offline" : "Couldn't reach the library";
      el.syncState.title = err.message;
      return false;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

const chapterSizes = (b) => b.chapters.map((c) => c.paras.reduce((n, p) => n + p.reduce((m, s) => m + s.length, 0), 0));

// When the server should be done: estimated from the book's size and how
// fast GitHub's machines are, counted from when preparing started.
function estimateFor(e, index = {}) {
  const sizes = e.sizes || [];
  const todo = sizes.map((_, ch) => ch).filter((ch) => !index[ch]);
  return { at: Date.now(), seconds: Math.round(estimateSeconds(sizes, todo)) };
}

// Share of the work done, for the progress bar. Finished chapters alone
// lag behind (every machine is mid-chapter until near the end), so while
// it's running this also counts time elapsed against the estimate. It never
// goes backwards while a run is going.
const shown = {}; // id -> highest share shown
// id -> { at, seconds }: when this device expects the server to be done.
// Seeded from the entry's estimate (from the device that started it).
const etas = {};
const etaOf = (e) => (e ? (etas[e.id] ||= e.eta || null) : null);
function progress(e, st) {
  if (!st) return 0;
  const eta = etaOf(e);
  if (!st.running || !eta) {
    delete shown[e?.id];
    return st.done;
  }
  const elapsed = (Date.now() - eta.at) / 1000;
  const byTime = st.waiting ? 0 : Math.min(0.97, elapsed / Math.max(1, elapsed + secondsLeft(e)));
  shown[e.id] = Math.max(shown[e.id] || 0, st.done, byTime);
  return shown[e.id];
}

function secondsLeft(e) {
  const eta = etaOf(e);
  if (!eta) return null;
  return Math.max(0, (eta.at + eta.seconds * 1000 - Date.now()) / 1000);
}

function countdown(sec) {
  if (sec == null) return "";
  return sec < 1 ? "finishing up" : `${formatTime(sec)} left`;
}

// How far along a book's audio is, from the chapters on the server and any
// preparation running now.
async function refreshStatus(id, runs) {
  const e = entry(id);
  if (!e || e.ready) return status[id];
  const [index, active] = await Promise.all([cloud.audioIndex(id), runs ? null : cloud.activeRuns(id)]);
  const run = runs ? runs[id] : active[0];
  const sizes = e.sizes || [];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  const made = Object.keys(index).length;
  const madeChars = Object.keys(index).reduce((n, ch) => n + (sizes[ch] || 0), 0);
  const running = !!run && run.status !== "completed";
  // A run takes a few seconds to show up after it's started.
  const starting = !running && e.startedAt && Date.now() - e.startedAt < 90_000 && made < e.chapters;
  const waiting = running && (await cloud.waiting(run).catch(() => false));
  status[id] = {
    index,
    made,
    done: madeChars / total,
    running: running || starting,
    waiting,
    failed: !running && !starting && run?.conclusion === "failure",
    startedAt: run?.run_started_at ? Date.parse(run.run_started_at) : e.startedAt,
  };
  // The estimate is kept on this device only: copies synced from other
  // devices would otherwise keep replacing it.
  const todo = sizes.map((_, ch) => ch).filter((ch) => !index[ch]);
  if (!status[id].running) delete etas[id];
  else if (waiting) {
    // The clock starts once a machine is free.
    etas[id] = estimateFor(e, index);
  } else if (!etaOf(e)) {
    etas[id] = { ...estimateFor(e, index), at: status[id].startedAt || Date.now() };
  } else if (secondsLeft(e) === 0) {
    // Taking longer than expected: push the end back by what's left, keeping
    // the start, so the bar carries on from where it is.
    const { at } = etas[id];
    const elapsed = (Date.now() - at) / 1000;
    etas[id] = { at, seconds: Math.round(elapsed + estimateSeconds(sizes, todo, { startup: false }) + 30) };
  }
  if (made === e.chapters && e.chapters > 0) await markReady(id, index);
  return status[id];
}

async function markReady(id, index) {
  // Total length, from each chapter's timings (small files).
  const durations = await Promise.all(Object.values(index).map(async (ids) => {
    try {
      return JSON.parse(await (await cloud.blob(ids.json)).text()).duration;
    } catch {
      return 0;
    }
  }));
  updateEntry(id, { ready: true, seconds: durations.reduce((a, b) => a + b, 0), startedAt: 0, eta: null, audioAt: Date.now() }, 500);
  const rec = await db.getBook(id);
  if (rec) await db.putBook({ ...rec, index });
  if (book?.id === id) book.index = index;
}

// ---------- library screen ----------

let libraryTimer = null;

async function showLibrary() {
  player.close();
  music.stop();
  book = null;
  clearInterval(bookTimer);
  document.title = APP_NAME;
  el.connect.hidden = true;
  el.bookScreen.hidden = true;
  el.library.hidden = false;
  el.settings.hidden = true;
  renderBooks();
  await syncNow();
  renderBooks();
  await refreshAll();
  clearInterval(libraryTimer);
  libraryTimer = setInterval(() => !el.library.hidden && document.visibilityState === "visible" && refreshAll(), 30_000);
}

async function refreshAll() {
  // Every unfinished book, including ones another device started moments ago.
  const pending = Object.values(library.books).filter((e) => !isRemoved(e) && !e.ready);
  if (!pending.length) return;
  try {
    const runs = await cloud.latestRuns();
    await Promise.all(pending.map((e) => refreshStatus(e.id, runs)));
  } catch (err) {
    console.warn(err);
  }
  if (!el.library.hidden) renderBooks();
}

function renderBooks() {
  const entries = Object.values(library.books)
    .filter((e) => !isRemoved(e))
    .sort((a, b) => (b.pos?.at || b.addedAt) - (a.pos?.at || a.addedAt));
  el.books.innerHTML = entries.map((e) => {
    const tags = [];
    const st = status[e.id];
    const pct = st ? Math.floor(progress(e, st) * 100) : 0;
    const rm = removing[e.id];
    if (rm?.error) tags.push(`<span class="tag warn">Couldn't remove it: ${esc(rm.error)}. Tap ✕ to try again.</span>`);
    else if (rm) {
      const parts = rm.total ? ` · ${rm.done} of ${rm.total} parts` : "";
      tags.push(`<span class="tag busy"><span class="spinner" aria-hidden="true"></span>Removing${rm.step ? ` ${rm.step}` : "…"}${parts}</span>`);
    } else if (e.ready) {
      tags.push(`<span class="tag ready">Ready · ${formatDuration(e.seconds || 0)}</span>`);
      if (e.finished) tags.push(`<span class="tag done">Finished</span>`);
      else if (e.pos && (e.pos.ch || e.pos.i)) tags.push(`<span class="tag">Paused at chapter ${e.pos.ch + 1} of ${e.chapters}</span>`);
      else tags.push(`<span class="tag">Not started</span>`);
    } else if (!st?.running && !e.voice && e.failedAt) tags.push(`<span class="tag warn">Preparing failed and was cleared · try again</span>`);
    else if (!st && !e.voice) tags.push(`<span class="tag">Not prepared yet</span>`);
    else if (!st) tags.push(`<span class="tag">Checking…</span>`);
    else if (!st.running && !st.made && !e.voice) tags.push(`<span class="tag">Not prepared yet</span>`);
    else if (st.running && st.waiting) tags.push(`<span class="tag busy">Waiting for a free server${pct ? ` · ${pct}%` : ""}</span>`);
    else if (st.running) {
      const left = secondsLeft(e);
      tags.push(`<span class="tag busy">Preparing · ${pct}%${left ? ` · ${formatDuration(left)} left` : ""}</span>`);
    }
    else if (st.failed) tags.push(`<span class="tag">Stopped at ${pct}% · open to continue</span>`);
    else tags.push(`<span class="tag">Paused · ${pct}%</span>`);
    const busy = rm && !rm.error;
    return `<li class="${busy ? "removing" : ""}">
      <button class="open" data-open="${esc(e.id)}"${busy ? " disabled" : ""}><strong>${esc(e.title)}</strong><span class="tags">${tags.join("")}</span></button>
      <button class="icon-btn remove" data-remove="${esc(e.id)}" aria-label="Remove ${esc(e.title)}"${busy ? " disabled" : ""}>✕</button>
    </li>`;
  }).join("");
  el.noBooks.hidden = entries.length > 0;
}

async function addFile(file) {
  el.libError.hidden = true;
  el.drop.classList.add("busy");
  const label = el.drop.querySelector(".drop-title");
  try {
    label.textContent = "Reading the book…";
    const id = await bookIdFor(file);
    const known = entry(id);
    if (!known || isRemoved(known)) {
      const parsed = await readBook(file);
      const rec = { id, title: parsed.title, chapters: parsed.chapters };
      label.textContent = "Adding it to your library…";
      await cloud.uploadBook(rec);
      await db.putBook(rec);
      library.books[id] = {
        id,
        title: rec.title,
        chapters: rec.chapters.length,
        sizes: chapterSizes(rec),
        addedAt: Date.now(),
        audioAt: Date.now(),
      };
      db.saveLibrary(library);
      await syncNow();
    }
    await openBook(id);
  } catch (err) {
    console.error(err);
    showLibError(err);
  } finally {
    el.drop.classList.remove("busy");
    label.textContent = "Add a book";
  }
}

function showLibError(err) {
  el.libError.textContent = err.message || "Something went wrong.";
  el.libError.hidden = false;
}

// Books being removed: id -> { step, done, total, error }.
const removing = {};

function libNotice(text) {
  el.libNotice.textContent = text;
  el.libNotice.hidden = !text;
  clearTimeout(libNotice.timer);
  if (text) libNotice.timer = setTimeout(() => (el.libNotice.hidden = true), 6000);
}

async function removeBook(id) {
  const e = entry(id);
  if (!e || (removing[id] && !removing[id].error)) return;
  if (!confirm(`Remove "${e.title}" and its audio from your library?`)) return;
  const show = (changes) => {
    removing[id] = { ...removing[id], ...changes };
    renderBooks();
  };
  show({ step: "…", done: 0, total: 0, error: null });
  try {
    // What there is for the book, to clear from this device once it's gone.
    const all = await cloud.audioAll(id).catch(() => ({ chapters: {} }));
    show({ step: "(stopping any preparing)" });
    await cloud.pause(id);
    show({ step: "the audio" });
    await cloud.deleteBook(id, (done, total) => show({ done, total }));
    show({ step: "from this device", total: 0 });
    await forgetAudio(all);
    await db.deleteBook(id);
  } catch (err) {
    console.error(err);
    show({ error: err.message || "something went wrong" });
    return;
  }
  delete removing[id];
  updateEntry(id, { deletedAt: Date.now() }, 0);
  renderBooks();
  libNotice(`Removed "${e.title}" and its audio.`);
}

// ---------- book screen ----------

let bookTimer = null;

async function openBook(id) {
  el.libError.hidden = true;
  const e = entry(id);
  if (!e) return;
  let rec = await db.getBook(id);
  if (!rec) {
    try {
      el.syncState.textContent = "Opening…";
      rec = await cloud.downloadBook(id);
      await db.putBook(rec);
      el.syncState.textContent = "";
    } catch (err) {
      el.syncState.textContent = "";
      return showLibError(new Error(`Couldn't open this book (${err.message}).`));
    }
  }
  book = rec;
  document.title = book.title;
  el.bookTitle.textContent = book.title;
  el.library.hidden = true;
  el.bookScreen.hidden = false;
  el.tocList.innerHTML = book.chapters.map((c, i) => `<li><button data-ch="${i}">${esc(c.title)}</button></li>`).join("");
  shownCh = -1;
  const pos = e.pos || { ch: 0, i: 0 };
  showChapter(Math.min(pos.ch, book.chapters.length - 1));
  await showBookState();
}

// Pick the panel for where this book is: choose a voice, preparing, or ready.
async function showBookState() {
  clearInterval(bookTimer);
  const e = entry(book.id);
  if (e.ready) return openPlayer();
  if (!e.voice) {
    const st = await refreshStatus(book.id).catch(() => null);
    if (!st?.running && !st?.made) {
      showSetup();
      if (e.failedAt) setupStatus("The last try went wrong on the server, so it was cleared away. Tap Prepare to try again.", true);
      return;
    }
  }
  showWork();
  const myBook = book;
  const poll = async () => {
    try {
      await refreshStatus(myBook.id);
    } catch (err) {
      if (book === myBook) el.workInfo.textContent = err.message;
      return;
    }
    if (book !== myBook) return;
    if (entry(myBook.id).ready) return showBookState();
    showWork();
  };
  await poll();
  if (book === myBook && !entry(myBook.id).ready) {
    bookTimer = setInterval(() => document.visibilityState === "visible" && poll(), 15_000);
  }
}

async function openPlayer() {
  clearInterval(bookTimer);
  showPanel("player");
  const e = entry(book.id);
  try {
    if (!book.index) {
      book.index = await cloud.audioIndex(book.id);
      db.putBook(book);
    }
    const pos = e.pos || { ch: 0, i: 0 };
    player.musicLevel = musicOn() ? settings.musicLevel : null;
    await player.open(book, book.index, (sha) => cloud.blob(sha), Math.min(pos.ch, book.chapters.length - 1), pos.i);
    updateMetadata();
    music.clearClips();
    loadBookMusic(book);
  } catch (err) {
    playerStatus(`Couldn't load the audio (${err.message}).`);
  }
}

function showPanel(name) {
  el.musicMenu.hidden = true;
  el.setupPanel.hidden = name !== "setup";
  el.workPanel.hidden = name !== "work";
  el.playerPanel.hidden = name !== "player";
  el.moreMenu.hidden = true;
  el.text.classList.toggle("can-jump", name === "player");
}

function showChapter(ch) {
  if (ch === shownCh) return;
  shownCh = ch;
  const c = book.chapters[ch];
  el.chapterTitle.textContent = c.title;
  el.text.innerHTML = "";
  spans = [];
  marked = null;
  // Most EPUB chapters start with their heading as text; show that as the
  // heading (it's read aloud too) rather than repeating the title.
  const headingInText = c.paras[0].join("").trim() === c.title.trim();
  if (!headingInText) {
    const h = document.createElement("h2");
    h.textContent = c.title;
    el.text.append(h);
  }
  for (const [k, para] of c.paras.entries()) {
    const p = document.createElement(k === 0 && headingInText ? "h2" : "p");
    for (const s of para) {
      const span = document.createElement("span");
      span.className = "s";
      span.dataset.i = spans.length;
      span.textContent = s;
      spans.push(span);
      p.append(span);
    }
    el.text.append(p);
  }
  const nav = document.createElement("div");
  nav.className = "chapter-nav";
  if (ch > 0) nav.innerHTML += `<button class="btn" data-goto="${ch - 1}">‹ Previous chapter</button>`;
  if (ch < book.chapters.length - 1) nav.innerHTML += `<button class="btn next" data-goto="${ch + 1}">Next chapter ›</button>`;
  el.text.append(nav);
  el.text.scrollTop = 0;
  el.tocList.querySelectorAll("button").forEach((b) => b.classList.toggle("active", +b.dataset.ch === ch));
  updateMetadata();
}

let marked = null;
function markSentence(i) {
  marked?.classList.remove("now");
  marked = spans[i];
  if (!marked) return;
  marked.classList.add("now");
  const r = marked.getBoundingClientRect();
  const box = el.text.getBoundingClientRect();
  if (r.top < box.top + 40 || r.bottom > box.bottom - 40) marked.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
}

function goToChapter(ch) {
  if (player.track) player.goToSentence(ch, 0);
  else showChapter(ch);
}

// ---------- choose a voice ----------

function showSetup() {
  showPanel("setup");
  const chars = chapterSizes(book).reduce((a, b) => a + b, 0);
  el.setupInfo.textContent =
    `${book.chapters.length} chapters · about ${formatDuration(chars / CHARS_PER_SECOND)} of listening. ` +
    "The whole book is prepared on the server; you can close the app while it works.";
  el.voiceSel.innerHTML = VOICES.map((v) => `<option value="${v.id}">${voiceLabel(v.id)}</option>`).join("");
  el.voiceSel.value = settings.voice;
  setupStatus("");
}

function setupStatus(text, isError = false) {
  el.setupStatus.textContent = text;
  el.setupStatus.hidden = !text;
  el.setupStatus.classList.toggle("error", isError);
}

const sample = new Audio();
el.sampleBtn.addEventListener("click", () => {
  if (!sample.paused) return sample.pause();
  sample.src = `./samples/${el.voiceSel.value}.mp3`;
  sample.play().catch(() => setupStatus("The voice sample isn't available.", true));
});
sample.addEventListener("play", () => (el.sampleBtn.textContent = "❚❚ Stop"));
sample.addEventListener("pause", () => (el.sampleBtn.textContent = "▶ Hear it"));
el.voiceSel.addEventListener("change", () => {
  settings.voice = el.voiceSel.value;
  save();
  if (!sample.paused) {
    sample.src = `./samples/${el.voiceSel.value}.mp3`;
    sample.play().catch(() => {});
  }
});

async function startPreparing(voice) {
  const id = book.id;
  try {
    await cloud.startPreparing(id, voice);
  } catch (err) {
    if (book?.id === id) {
      if (el.setupPanel.hidden) el.workInfo.textContent = err.message;
      else setupStatus(err.message, true);
    }
    return;
  }
  const eta = estimateFor(entry(id), status[id]?.index);
  etas[id] = eta;
  delete shown[id];
  updateEntry(id, { voice, startedAt: Date.now(), eta, ready: false, failedAt: 0, audioAt: Date.now() }, 0);
  status[id] = { index: {}, made: 0, done: 0, ...status[id], running: true, failed: false, startedAt: Date.now() };
  await syncNow(); // so other devices see it straight away, even if this one closes
  if (book?.id === id) showBookState();
}

el.prepareBtn.addEventListener("click", async () => {
  sample.pause();
  el.prepareBtn.disabled = true;
  setupStatus("Starting…");
  await startPreparing(el.voiceSel.value);
  el.prepareBtn.disabled = false;
});

// ---------- preparing ----------

let workTicker = null;
function showWork() {
  showPanel("work");
  clearInterval(workTicker);
  workTicker = setInterval(() => {
    if (el.workPanel.hidden || !book) return clearInterval(workTicker);
    if (status[book.id]?.running) showProgress();
  }, 1000);
  const e = entry(book.id);
  const st = status[book.id];
  const running = !st || st.running;
  el.workTitle.textContent = !st ? "Checking…" : running ? (st.waiting ? "In line" : `Preparing${e.voice ? ` with ${voiceLabel(e.voice)}` : ""}`) : st.failed ? "Stopped" : "Paused";
  showProgress();
  el.pauseBtn.hidden = !running;
  el.resumeBtn.hidden = running;
  el.restartBtn.hidden = running;
}

// Percentage, bar, time left and chapters, refreshed every second.
function showProgress() {
  const e = entry(book.id);
  const st = status[book.id];
  if (!st) {
    el.workPct.textContent = "";
    el.workInfo.textContent = "";
    return;
  }
  const done = progress(e, st);
  const pct = `${Math.floor(done * 100)}%`;
  const chapters = `${st.made} of ${e.chapters} chapters ready`;
  el.workBar.style.width = `${done * 100}%`;
  if (st.running && st.waiting) {
    el.workPct.textContent = "Waiting";
    el.workInfo.textContent = `Waiting for a free server: other books are being prepared first. ${chapters}. It starts by itself, even if you close the app.`;
  } else if (st.running) {
    const left = secondsLeft(e);
    el.workPct.textContent = left == null ? pct : countdown(left);
    el.workInfo.textContent = `${pct} · ${chapters}. It keeps going on the server, even if you close the app.`;
  } else {
    el.workPct.textContent = pct;
    el.workInfo.textContent = st.failed
      ? `${chapters}. Something went wrong on the server; tap Continue to try again.`
      : `${chapters}.`;
  }
}

el.pauseBtn.addEventListener("click", async () => {
  el.pauseBtn.disabled = true;
  const id = book.id;
  try {
    await cloud.pause(id);
    updateEntry(id, { startedAt: 0, eta: null, audioAt: Date.now() }, 0);
    delete etas[id];
    if (status[id]) status[id].running = false;
    if (book?.id === id) showWork();
  } catch (err) {
    el.workInfo.textContent = err.message;
  } finally {
    el.pauseBtn.disabled = false;
  }
});

el.resumeBtn.addEventListener("click", () => startPreparing(entry(book.id).voice || settings.voice));

async function startOver() {
  if (!confirm("Delete this book's audio and choose a voice again?")) return;
  const id = book.id;
  const all = await cloud.audioAll(id).catch(() => ({ chapters: book.index }));
  try {
    await cloud.pause(id);
    await cloud.deleteAudio(id);
  } catch (err) {
    return alert(err.message);
  }
  player.close();
  await forgetAudio(all);
  delete status[id];
  delete book.index;
  db.putBook(book);
  updateEntry(id, { voice: null, ready: false, seconds: 0, startedAt: 0, audioAt: Date.now() }, 0);
  showBookState();
}
el.restartBtn.addEventListener("click", startOver);
el.redoBtn.addEventListener("click", startOver);

// ---------- listening ----------

const music = new MusicEngine();
music.setVolume(LIVE_VOLUME[settings.musicLevel] ?? 0.5);

// The mood at a sentence: from the server's reading of the book when it has
// one (it changes within chapters as the story does), otherwise a quick guess
// from the chapter's words.
function moodAt(ch, i = 0) {
  if (!book) return "reflective";
  const segments = book.segments?.[ch];
  if (segments?.length) {
    let mood = segments[0].mood;
    for (const seg of segments) if (seg.at <= i) mood = seg.mood;
    return mood;
  }
  return book.moods?.[ch] || (book.guessedMoods ??= {})[ch] || (book.guessedMoods[ch] = chapterMood(book.chapters[ch]));
}

// This chapter's narration already has its music mixed in.
const mixedHere = () => !!player.track?.mixed;

function syncMusic() {
  el.musicBtn.classList.toggle("on", musicOn());
  el.musicLevel.value = LEVEL_ORDER.indexOf(settings.musicLevel);
  el.musicLevelName.textContent = LEVEL_NAMES[settings.musicLevel];
  // The live composer only fills in where the narration has no music of its own.
  const live = musicOn() && player.playing && !mixedHere();
  const mood = moodAt(shownCh, Math.max(0, player.sentence));
  if (live) music.play(mood);
  else music.pause();
  const label = MOODS[mood]?.label || "";
  const wanted = settings.musicLevel;
  const playing = player.track?.mixed;
  el.musicNow.textContent = !musicOn() ? "Narration only."
    : !mixedHere() ? `Now: ${label}, composed live on this device.`
    : playing === wanted ? `Now: ${label}. The music is part of the narration and follows the story.`
    : `Now: ${label}. This book has the music at ${LEVEL_NAMES[playing]} only so far.`;
  // Offer to make what's missing: music at all, or the chosen level.
  const chapters = Object.values(book?.index || {});
  const hasMix = chapters.some((c) => c.mix);
  const hasLevel = chapters.some((c) => c.mix?.[wanted]);
  const offer = !!book && musicOn() && !composing.has(book.id) && (!hasMix || !hasLevel || book.oldMix);
  el.composeBtn.hidden = !offer;
  el.composeBtn.textContent = !hasMix ? "Add music to this book"
    : book.oldMix ? "Update the music mix (smoother narration)"
    : `Make the ${LEVEL_NAMES[wanted]} level for this book`;
}

// What the server made for this book: mood segments, composed music, and
// chapters mixed with music. Checked in the background whenever a book opens,
// so music added since last time is picked up.
const composing = new Set();
async function loadBookMusic(myBook) {
  try {
    const all = await cloud.audioAll(myBook.id);
    if (book !== myBook) return;
    if (all.moods) {
      const moods = JSON.parse(await (await cached(all.moods, (s) => cloud.blob(s))).text());
      myBook.moods = moods.moods;
      myBook.segments = moods.chapters;
    }
    myBook.oldMix = all.oldMix;
    // Newly mixed chapters.
    const before = JSON.stringify(myBook.index);
    myBook.index = all.chapters;
    if (JSON.stringify(myBook.index) !== before) {
      db.putBook(myBook);
      player.updateIndex(all.chapters);
    }
    if (Object.values(all.chapters).some((c) => c.mix)) composing.delete(myBook.id);
    // Composed music, for the live player in chapters that aren't mixed yet.
    const files = {};
    for (const [mood, sha] of Object.entries(all.music)) {
      files[mood] = await (await cached(sha, (s) => cloud.blob(s))).arrayBuffer();
    }
    if (book !== myBook) return;
    if (Object.keys(files).length) await music.setClips(files);
    syncMusic();
  } catch (err) {
    console.warn("Couldn't load the book's music", err);
  }
}

let seeking = false;
let lastPositionUpdate = 0;

const player = new Player(el.audio, {
  onChapter: (ch) => {
    showChapter(ch);
    syncMusic();
  },
  onSentence: (ch, i) => {
    if (!book) return;
    markSentence(i);
    if (musicOn() && !mixedHere()) {
      music.setMood(moodAt(ch, i));
      el.musicNow.textContent = `Now: ${MOODS[moodAt(ch, i)]?.label || ""}, composed live on this device.`;
    }
    updateEntry(book.id, { pos: { ch, i, at: Date.now() } }, 60_000);
  },
  onState: (playing) => {
    el.playBtn.textContent = playing ? "❚❚" : "▶";
    el.playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    syncMusic();
    if (!book) return;
    if (playing && entry(book.id)?.finished) updateEntry(book.id, { finished: false, finishedAt: Date.now() });
    if (!playing) syncSoon(1500); // save where you paused
  },
  onFinished: () => {
    if (book) updateEntry(book.id, { finished: true, finishedAt: Date.now(), pos: { ch: 0, i: 0, at: Date.now() } }, 500);
  },
  onLoading: (on) => playerStatus(on ? "Loading the chapter…" : ""),
  onTime: (now, total) => {
    if (!seeking) el.seekBar.value = total ? Math.round((now / total) * 1000) : 0;
    el.timeNow.textContent = formatTime(now);
    el.timeLeft.textContent = `-${formatTime(total - now)}`;
    updatePosition(now, total);
  },
});

function playerStatus(text) {
  el.playerStatus.textContent = text;
  el.playerStatus.hidden = !text;
}

function updateMetadata() {
  if (!("mediaSession" in navigator) || !book) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: book.chapters[shownCh]?.title || book.title,
    artist: book.title,
    album: APP_NAME,
  });
}

function updatePosition(now, total) {
  if (!("mediaSession" in navigator) || !total || Date.now() - lastPositionUpdate < 1000) return;
  lastPositionUpdate = Date.now();
  try {
    navigator.mediaSession.setPositionState({ duration: total, position: Math.min(now, total), playbackRate: player.rate });
  } catch {}
}

if ("mediaSession" in navigator) {
  const handlers = {
    play: () => player.play(),
    pause: () => player.pause(),
    seekbackward: () => player.skip(-15),
    seekforward: () => player.skip(15),
    previoustrack: () => player.goToSentence(Math.max(0, shownCh - 1), 0),
    nexttrack: () => player.goToSentence(Math.min(book.chapters.length - 1, shownCh + 1), 0),
    seekto: (e) => player.seek(e.seekTime),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, (e) => player.track && fn(e));
    } catch {}
  }
}

el.playBtn.addEventListener("click", () => {
  if (player.playing) return player.pause();
  if (musicOn()) music.ensure(); // sound can only start from a tap
  player.play().catch((err) => playerStatus(err.message));
});
el.prevBtn.addEventListener("click", () => player.goToSentence(shownCh, player.sentence - 1));
el.nextBtn.addEventListener("click", () => player.goToSentence(shownCh, player.sentence + 1));
el.musicBtn.addEventListener("click", () => {
  el.musicMenu.hidden = !el.musicMenu.hidden;
  el.moreMenu.hidden = true;
  syncMusic();
});
el.musicLevel.addEventListener("input", () => {
  el.musicLevelName.textContent = LEVEL_NAMES[LEVEL_ORDER[el.musicLevel.value]];
});
el.musicLevel.addEventListener("change", async () => {
  const level = LEVEL_ORDER[el.musicLevel.value];
  if (!level || level === settings.musicLevel) return;
  settings.musicLevel = level;
  save();
  if (musicOn()) {
    music.ensure();
    music.setVolume(LIVE_VOLUME[level]);
  }
  syncMusic();
  await player.setMusicLevel(musicOn() ? level : null);
  syncMusic();
});
el.composeBtn.addEventListener("click", async () => {
  const id = book.id;
  el.composeBtn.disabled = true;
  try {
    // Preparing again only does what's missing: here, the moods and music.
    await cloud.startPreparing(id, entry(id).voice || settings.voice);
    composing.add(id);
    el.composeInfo.textContent = "Making it on the server: about 10 to 20 minutes. It's used by itself next time you open the book.";
  } catch (err) {
    el.composeInfo.textContent = err.message;
  } finally {
    el.composeInfo.hidden = false;
    el.composeBtn.disabled = false;
    syncMusic();
  }
});



el.moreBtn.addEventListener("click", () => {
  el.musicMenu.hidden = true;
  el.moreMenu.hidden = !el.moreMenu.hidden;
  const e = entry(book.id);
  el.voiceInfo.textContent = `Voice: ${voiceLabel(e.voice)} · ${formatDuration(e.seconds || 0)} in total`;
});

el.seekBar.addEventListener("input", () => {
  seeking = true;
  el.timeNow.textContent = formatTime((el.seekBar.value / 1000) * (player.track?.duration || 0));
});
el.seekBar.addEventListener("change", () => {
  seeking = false;
  player.seek((el.seekBar.value / 1000) * (player.track?.duration || 0));
});

el.speedSel.value = String(settings.speed);
player.setRate(settings.speed);
el.speedSel.addEventListener("change", () => {
  settings.speed = +el.speedSel.value;
  player.setRate(settings.speed);
  save();
});

// ---------- other events ----------

el.fileInput.addEventListener("change", () => {
  const f = el.fileInput.files[0];
  el.fileInput.value = "";
  if (f) addFile(f);
});
el.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.drop.classList.add("over");
});
el.drop.addEventListener("dragleave", () => el.drop.classList.remove("over"));
el.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  el.drop.classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f) addFile(f);
});

el.books.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  if (rm) return removeBook(rm.dataset.remove);
  const open = e.target.closest("[data-open]");
  if (open) openBook(open.dataset.open);
});

el.backBtn.addEventListener("click", showLibrary);
el.tocBtn.addEventListener("click", () => document.body.classList.toggle("toc-open"));
el.scrim.addEventListener("click", () => document.body.classList.remove("toc-open"));
el.tocList.addEventListener("click", (e) => {
  const b = e.target.closest("[data-ch]");
  if (!b) return;
  document.body.classList.remove("toc-open");
  goToChapter(+b.dataset.ch);
});
el.text.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) return goToChapter(+go.dataset.goto);
  const s = e.target.closest(".s");
  if (s && player.track && !getSelection().toString()) player.goToSentence(shownCh, +s.dataset.i);
});

el.settingsBtn.addEventListener("click", () => {
  el.settings.hidden = !el.settings.hidden;
  el.settingsMsg.hidden = true;
  el.shareLinkBtn.hidden = !navigator.share;
});

function deviceLink() {
  const c = settings.conn;
  const d = defaults();
  const params = new URLSearchParams({ key: c.key });
  if (c.dataRepo !== d.dataRepo) params.set("lib", c.dataRepo);
  if (c.appRepo !== d.appRepo) params.set("app", c.appRepo);
  return `${location.origin}${location.pathname}#${params}`;
}

el.copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(deviceLink());
    el.settingsMsg.textContent = "Copied. Open it on your other device (send it to yourself privately).";
  } catch {
    el.settingsMsg.textContent = deviceLink();
  }
  el.settingsMsg.hidden = false;
});
el.shareLinkBtn.addEventListener("click", () => navigator.share({ title: APP_NAME, url: deviceLink() }).catch(() => {}));

el.disconnectBtn.addEventListener("click", () => {
  if (!confirm("Sign out on this device? Your library stays safe on the server.")) return;
  delete settings.conn;
  save();
  cloud = null;
  library = { books: {} };
  db.saveLibrary(library);
  showConnect();
});

document.addEventListener("keydown", (e) => {
  if (!player.track || el.bookScreen.hidden || e.target.closest("input, select, button")) return;
  if (e.code === "Space") {
    e.preventDefault();
    player.playing ? player.pause() : player.play();
  } else if (e.code === "ArrowLeft") player.skip(-15);
  else if (e.code === "ArrowRight") player.skip(15);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") syncNow(); // leaving: save where you are
  else if (cloud) syncSoon(500);
});

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- start ----------

takeKeyFromLink();
if (settings.conn?.key) {
  cloud = new Library(settings.conn);
  showLibrary();
} else showConnect();
