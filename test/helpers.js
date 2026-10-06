"use strict";

// Loads index.html into jsdom and runs app.js / psi.js against a fake fetch,
// so tests exercise the real scripts without touching the network.

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const HTML = read("index.html").replace(/<script[^>]*><\/script>/g, "");

const STOPS = {
  "01012": [103.85, 1.29, "Hotel Grand Pacific", "Victoria St"],
  "01013": [103.85, 1.29, "St. Joseph's Church", "Victoria St"],
  "10009": [103.82, 1.28, "Bt Merah Int", "Bt Merah Ctrl"],
  "83139": [103.9, 1.31, "Opp Blk 3", "Sims Ave"],
  "46971": [103.77, 1.44, "Woodlands Int", "Woodlands Sq"],
};

const STOPS_URL = "https://data.busrouter.sg/v1/stops.min.json";
const ARRIVALS_URL = "https://arrivelah2.busrouter.sg/?id=";
const PSI_URL = "https://api-open.data.gov.sg/v2/real-time/api/psi";

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A fetch that never settles until aborted; useful for racing requests.
function hanging(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    signal.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
}

/**
 * routes: { stops, arrivals(code), psi } – each a function returning a
 * response (or a promise of one) or throwing. Defaults serve fixture data.
 */
function createApp({ routes = {}, hash = "", favourites, scripts = ["app.js", "psi.js"] } = {}) {
  const dom = new JSDOM(HTML, {
    url: "https://example.test/" + (hash ? "#" + hash : ""),
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];

  const r = {
    stops: () => json(STOPS),
    arrivals: () => json({ services: [] }),
    psi: () => json({ data: { items: [] } }),
    ...routes,
  };

  window.fetch = async (url, opts = {}) => {
    calls.push(url);
    if (url === STOPS_URL) return r.stops(opts.signal);
    if (url.startsWith(ARRIVALS_URL)) {
      return r.arrivals(decodeURIComponent(url.slice(ARRIVALS_URL.length)), opts.signal);
    }
    if (url === PSI_URL) return r.psi(opts.signal);
    throw new Error("Unexpected fetch: " + url);
  };

  if (favourites !== undefined) {
    window.localStorage.setItem(
      "bus-arrivals:favourites",
      typeof favourites === "string" ? favourites : JSON.stringify(favourites)
    );
  }

  // Real <script> elements so top-level declarations become globals, as in a browser.
  for (const f of scripts) {
    const el = window.document.createElement("script");
    el.textContent = read(f);
    window.document.body.append(el);
  }

  const doc = window.document;
  return {
    dom,
    window,
    doc,
    calls,
    $: (id) => doc.getElementById(id),
    // Top-level declarations in app.js live in the window's global scope.
    g: (expr) => window.eval(expr),
    text: (id) => doc.getElementById(id).textContent,
    close: () => window.close(),
  };
}

// Let pending promise chains (fake fetch -> json -> render) and zero-delay
// timers (jsdom queues hashchange on one) run.
async function flush(n = 5) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

function type(app, value) {
  const input = app.$("search");
  input.value = value;
  input.dispatchEvent(new app.window.Event("input", { bubbles: true }));
}

function key(app, k) {
  const ev = new app.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  app.$("search").dispatchEvent(ev);
  return ev;
}

async function goTo(app, hash) {
  app.window.location.hash = hash;
  await flush();
}

module.exports = { createApp, flush, type, key, goTo, json, hanging, STOPS };
