"use strict";

const STOPS_URL = "https://data.busrouter.sg/v1/stops.min.json";
const ARRIVALS_URL = "https://arrivelah2.busrouter.sg/?id=";
const REFRESH_MS = 15000;
const RENDER_MS = 10000;
const MAX_RESULTS = 8;
const MIN_QUERY = 2;
const FAV_KEY = "bus-arrivals:favourites";

const LOADS = {
  SEA: "Seats",
  SDA: "Standing",
  LSD: "Limited standing",
};

/* ---------- pure helpers ---------- */

// Lowercase, turn punctuation into spaces, collapse whitespace.
function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// stops.min.json is { code: [lng, lat, name, road] }.
function toStopList(raw) {
  return Object.entries(raw).map(([code, [, , name, road]]) => ({
    code,
    name,
    road,
    nName: normalize(name),
    nRoad: normalize(road),
  }));
}

function rankStop(stop, q, qCompact) {
  if (stop.code === q) return 0;
  if (stop.code.startsWith(q)) return 1;
  if (stop.nName.startsWith(q)) return 2;
  if (stop.nName.includes(q) || stop.nName.replace(/ /g, "").includes(qCompact)) return 3;
  if (stop.nRoad.includes(q) || stop.nRoad.replace(/ /g, "").includes(qCompact)) return 4;
  return -1;
}

function searchStops(stops, query, limit = MAX_RESULTS) {
  const q = normalize(query);
  if (q.length < MIN_QUERY) return [];
  const qCompact = q.replace(/ /g, "");
  const hits = [];
  for (const stop of stops) {
    const rank = rankStop(stop, q, qCompact);
    if (rank >= 0) hits.push({ stop, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || a.stop.name.localeCompare(b.stop.name));
  return hits.slice(0, limit).map((h) => h.stop);
}

// Minutes until arrival rounded down; null when there is no usable time.
function minutesUntil(arrival, now = Date.now()) {
  if (!arrival || !arrival.time) return null;
  const t = Date.parse(arrival.time);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / 60000);
}

// "Arr" for under a minute (including already past), "–" when missing.
function formatMinutes(arrival, now = Date.now()) {
  const m = minutesUntil(arrival, now);
  if (m === null) return { text: "–", unit: "", none: true };
  if (m < 1) return { text: "Arr", unit: "", none: false };
  return { text: String(m), unit: "min", none: false };
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

function sortServices(services) {
  return [...services].sort((a, b) => naturalCompare(a.no, b.no));
}

/* ---------- state ---------- */

const state = {
  stops: [],
  byCode: new Map(),
  code: null,
  services: null, // null = not loaded yet for the current stop
  updatedAt: null,
  failed: false,
  fetchToken: 0,
  controller: null,
  refreshTimer: null,
  renderTimer: null,
};

/* ---------- DOM ---------- */

const $ = (id) => document.getElementById(id);
const els = {
  search: $("search"),
  results: $("results"),
  favourites: $("favourites"),
  stopsError: $("stops-error"),
  stopsRetry: $("stops-retry"),
  welcome: $("welcome"),
  stop: $("stop"),
  stopName: $("stop-name"),
  stopMeta: $("stop-meta"),
  fav: $("fav"),
  updated: $("updated"),
  refresh: $("refresh"),
  warning: $("warning"),
  services: $("services"),
  home: $("home"),
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/* ---------- favourites ---------- */

function loadFavourites() {
  try {
    const list = JSON.parse(localStorage.getItem(FAV_KEY));
    return Array.isArray(list) ? list.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function saveFavourites(list) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: favourites just won't persist
  }
}

let favourites = loadFavourites();

function toggleFavourite(code) {
  favourites = favourites.includes(code)
    ? favourites.filter((c) => c !== code)
    : [...favourites, code];
  saveFavourites(favourites);
  renderFavourites();
  renderFavButton();
}

function renderFavourites() {
  els.favourites.replaceChildren();
  for (const code of favourites) {
    const stop = state.byCode.get(code);
    if (!stop) continue;
    const chip = el("button", { type: "button", class: "chip" }, stop.name, el("small", { text: code }));
    chip.addEventListener("click", () => selectStop(code));
    els.favourites.append(chip);
  }
}

function renderFavButton() {
  const on = state.code !== null && favourites.includes(state.code);
  els.fav.textContent = on ? "★" : "☆";
  els.fav.setAttribute("aria-pressed", String(on));
  els.fav.title = on ? "Remove from favourites" : "Add to favourites";
}

/* ---------- search UI ---------- */

let matches = [];
let activeIndex = -1;

function closeResults() {
  els.results.hidden = true;
  els.search.setAttribute("aria-expanded", "false");
  els.search.removeAttribute("aria-activedescendant");
  activeIndex = -1;
}

function setActive(i) {
  activeIndex = i;
  [...els.results.children].forEach((li, idx) => {
    li.setAttribute("aria-selected", String(idx === i));
    if (idx === i) els.search.setAttribute("aria-activedescendant", li.id);
  });
}

function renderResults() {
  const query = els.search.value;
  matches = searchStops(state.stops, query);
  els.results.replaceChildren();
  if (normalize(query).length < MIN_QUERY) {
    closeResults();
    return;
  }
  if (matches.length === 0) {
    els.results.append(el("li", { class: "none", text: "No matching stops" }));
  }
  matches.forEach((stop, i) => {
    const li = el(
      "li",
      { role: "option", id: `opt-${i}`, "aria-selected": "false" },
      el("span", { class: "r-name", text: stop.name }),
      el("span", { class: "r-sub", text: `${stop.road} · ${stop.code}` })
    );
    // mousedown so it fires before the input loses focus
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(stop.code);
    });
    els.results.append(li);
  });
  els.results.hidden = false;
  els.search.setAttribute("aria-expanded", "true");
  activeIndex = -1;
}

function pick(code) {
  els.search.value = "";
  closeResults();
  selectStop(code);
}

els.search.addEventListener("input", renderResults);
els.search.addEventListener("blur", closeResults);
els.search.addEventListener("keydown", (e) => {
  if (els.results.hidden && e.key !== "Escape") {
    if (e.key === "ArrowDown") renderResults();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (matches.length) setActive((activeIndex + 1) % matches.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (matches.length) setActive((activeIndex - 1 + matches.length) % matches.length);
  } else if (e.key === "Enter") {
    const stop = matches[activeIndex >= 0 ? activeIndex : 0];
    if (stop) {
      e.preventDefault();
      pick(stop.code);
    }
  } else if (e.key === "Escape") {
    closeResults();
  }
});

/* ---------- arrivals rendering ---------- */

function arrivalCell(arrival, now) {
  const f = formatMinutes(arrival, now);
  const scheduled = arrival && arrival.monitored === 0;
  const mins = el("div", { class: "mins" + (f.none ? " none" : "") }, f.text);
  if (f.unit) mins.append(" ", el("small", { text: f.unit }));
  const cell = el("div", { class: "arrival" + (scheduled ? " scheduled" : "") }, mins);
  if (f.none) return cell;

  if (arrival.time) {
    const d = new Date(arrival.time);
    if (!Number.isNaN(d.getTime())) {
      mins.title = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  }

  const sub = el("div", { class: "sub" });
  if (LOADS[arrival.load]) {
    sub.append(el("span", { class: `dot ${arrival.load}`, "aria-hidden": "true" }), LOADS[arrival.load]);
  }
  if (arrival.type === "DD" || arrival.type === "BD") {
    sub.append(el("span", { class: "badge", text: arrival.type, title: arrival.type === "DD" ? "Double deck" : "Bendy bus" }));
  }
  if (arrival.feature === "WAB") {
    sub.append(el("span", { class: "badge", text: "♿", title: "Wheelchair accessible", "aria-label": "Wheelchair accessible" }));
  }
  if (scheduled) sub.append(el("span", { class: "tag", text: "Scheduled" }));
  cell.append(sub);
  return cell;
}

function renderServices() {
  const box = els.services;
  box.replaceChildren();

  if (state.services === null) {
    if (state.failed) {
      box.append(el("p", { class: "empty", text: "Couldn't load arrivals. Try the refresh button." }));
    } else {
      for (let i = 0; i < 3; i++) box.append(el("div", { class: "skeleton" }));
      box.append(el("p", { class: "hint", text: "Loading…" }));
    }
    return;
  }
  if (state.services.length === 0) {
    box.append(el("p", { class: "empty", text: "No bus services at the moment" }));
    return;
  }
  const now = Date.now();
  for (const svc of sortServices(state.services)) {
    box.append(
      el(
        "div",
        { class: "service" },
        el("div", { class: "bus-no", text: svc.no }),
        arrivalCell(svc.next, now),
        arrivalCell(svc.next2, now)
      )
    );
  }
}

function renderStatus() {
  els.warning.hidden = !(state.failed && state.services !== null);
  els.updated.textContent = state.updatedAt
    ? "Updated " + state.updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : " ";
}

/* ---------- fetching ---------- */

async function fetchArrivals() {
  const code = state.code;
  if (!code || !state.byCode.has(code)) return;
  if (state.controller) state.controller.abort();
  const controller = new AbortController();
  state.controller = controller;
  const token = ++state.fetchToken;

  els.refresh.classList.add("spin");
  try {
    const res = await fetch(ARRIVALS_URL + encodeURIComponent(code), { signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (token !== state.fetchToken) return;
    state.services = Array.isArray(data.services) ? data.services : [];
    state.updatedAt = new Date();
    state.failed = false;
  } catch (err) {
    if (err.name === "AbortError" || token !== state.fetchToken) return;
    state.failed = true;
  }
  els.refresh.classList.remove("spin");
  renderStatus();
  renderServices();
}

function stopTimers() {
  clearInterval(state.refreshTimer);
  clearInterval(state.renderTimer);
  state.refreshTimer = state.renderTimer = null;
}

function startTimers() {
  stopTimers();
  if (!state.code || document.hidden) return;
  state.refreshTimer = setInterval(fetchArrivals, REFRESH_MS);
  state.renderTimer = setInterval(() => state.services && renderServices(), RENDER_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopTimers();
  } else if (state.code) {
    fetchArrivals();
    startTimers();
  }
});

els.refresh.addEventListener("click", fetchArrivals);
els.fav.addEventListener("click", () => state.code && toggleFavourite(state.code));

/* ---------- routing ---------- */

function selectStop(code) {
  if (location.hash.slice(1) === code) showStop(code);
  else location.hash = code; // triggers hashchange -> showStop
}

function showStop(code) {
  stopTimers();
  state.fetchToken++;
  if (state.controller) state.controller.abort();
  state.code = code;
  state.services = null;
  state.updatedAt = null;
  state.failed = false;

  els.welcome.hidden = true;
  els.stop.hidden = false;
  renderFavButton();
  renderStatus();

  const stop = state.byCode.get(code);
  if (!stop) {
    els.stopName.textContent = "Stop not found";
    els.stopMeta.textContent = `No bus stop with code "${code}".`;
    els.services.replaceChildren();
    els.fav.hidden = true;
    els.refresh.hidden = true;
    state.code = null;
    return;
  }
  els.fav.hidden = false;
  els.refresh.hidden = false;
  els.stopName.textContent = stop.name;
  els.stopMeta.textContent = `${stop.road} · ${stop.code}`;
  document.title = `${stop.name} · Bus Arrivals`;
  renderServices();
  fetchArrivals();
  startTimers();
}

function showHome() {
  stopTimers();
  state.fetchToken++;
  if (state.controller) state.controller.abort();
  state.code = null;
  els.stop.hidden = true;
  els.welcome.hidden = false;
  document.title = "Bus Arrivals";
}

function route() {
  const code = decodeURIComponent(location.hash.slice(1)).trim();
  if (!code) showHome();
  else if (state.stops.length === 0) return; // wait for the stops list
  else showStop(code);
}

window.addEventListener("hashchange", route);
els.home.addEventListener("click", (e) => {
  e.preventDefault();
  if (location.hash) location.hash = "";
  else showHome();
  history.replaceState(null, "", location.pathname + location.search);
});

/* ---------- init ---------- */

async function loadStops() {
  els.stopsError.hidden = true;
  els.search.disabled = true;
  els.search.placeholder = "Loading stops…";
  try {
    const res = await fetch(STOPS_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    state.stops = toStopList(await res.json());
    state.byCode = new Map(state.stops.map((s) => [s.code, s]));
  } catch {
    els.stopsError.hidden = false;
    els.search.placeholder = "Stop list unavailable";
    return;
  }
  els.search.disabled = false;
  els.search.placeholder = "Search stop code, name or road";
  renderFavourites();
  route();
}

els.stopsRetry.addEventListener("click", loadStops);
loadStops();
