"use strict";

// Integration tests: run app.js in jsdom against a fake fetch and check the DOM.

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, flush, type, key, goTo, json, hanging } = require("./helpers");

let app;
afterEach(() => app && app.close());

function start(opts = {}) {
  app = createApp({ scripts: ["app.js"], ...opts });
  return app;
}

const inMinutes = (m) => new Date(Date.now() + m * 60000 + 5000).toISOString();

function arrival(extra = {}) {
  return { time: inMinutes(5), load: "SEA", type: "SD", feature: "WAB", monitored: 1, ...extra };
}

const serviceNos = (a) => [...a.doc.querySelectorAll("#services .bus-no")].map((n) => n.textContent);
const resultItems = (a) => [...a.$("results").children];

describe("loading the stop list", () => {
  test("enables search once stops load", async () => {
    start();
    assert.equal(app.$("search").disabled, true);
    assert.equal(app.$("search").placeholder, "Loading stops…");
    await flush();
    assert.equal(app.$("search").disabled, false);
    assert.equal(app.$("search").placeholder, "Search stop code, name or road");
    assert.equal(app.$("stops-error").hidden, true);
    assert.equal(app.$("welcome").hidden, false);
  });

  test("shows an error banner on HTTP failure and recovers on retry", async () => {
    let fail = true;
    start({ routes: { stops: () => (fail ? json(null, 500) : json({ "01012": [0, 0, "Hotel Grand Pacific", "Victoria St"] })) } });
    await flush();
    assert.equal(app.$("stops-error").hidden, false);
    assert.equal(app.$("search").disabled, true);
    assert.equal(app.$("search").placeholder, "Stop list unavailable");

    fail = false;
    app.$("stops-retry").click();
    await flush();
    assert.equal(app.$("stops-error").hidden, true);
    assert.equal(app.$("search").disabled, false);
    assert.equal(app.g("state.stops.length"), 1);
  });

  test("shows an error banner when fetch rejects (offline)", async () => {
    start({ routes: { stops: () => Promise.reject(new TypeError("Failed to fetch")) } });
    await flush();
    assert.equal(app.$("stops-error").hidden, false);
  });
});

describe("search box", () => {
  test("lists matches with name, road and code", async () => {
    start();
    await flush();
    type(app, "victoria");
    const items = resultItems(app);
    assert.equal(app.$("results").hidden, false);
    assert.equal(app.$("search").getAttribute("aria-expanded"), "true");
    assert.equal(items.length, 2);
    assert.equal(items[0].querySelector(".r-name").textContent, "Hotel Grand Pacific");
    assert.equal(items[0].querySelector(".r-sub").textContent, "Victoria St · 01012");
    assert.equal(items[0].getAttribute("role"), "option");
  });

  test("stays closed for queries shorter than two characters", async () => {
    start();
    await flush();
    type(app, "v");
    assert.equal(app.$("results").hidden, true);
    assert.equal(app.$("search").getAttribute("aria-expanded"), "false");
  });

  test("shows a 'No matching stops' message", async () => {
    start();
    await flush();
    type(app, "zzzz");
    const items = resultItems(app);
    assert.equal(items.length, 1);
    assert.equal(items[0].textContent, "No matching stops");
    assert.equal(app.$("results").hidden, false);
  });

  test("arrow keys move the active option and wrap around", async () => {
    start();
    await flush();
    type(app, "victoria");
    const items = () => resultItems(app);

    key(app, "ArrowDown");
    assert.equal(items()[0].getAttribute("aria-selected"), "true");
    assert.equal(app.$("search").getAttribute("aria-activedescendant"), "opt-0");

    key(app, "ArrowDown");
    assert.equal(items()[1].getAttribute("aria-selected"), "true");
    assert.equal(items()[0].getAttribute("aria-selected"), "false");

    key(app, "ArrowDown"); // wraps
    assert.equal(items()[0].getAttribute("aria-selected"), "true");

    key(app, "ArrowUp"); // wraps backwards
    assert.equal(items()[1].getAttribute("aria-selected"), "true");
  });

  test("Enter picks the active option", async () => {
    start();
    await flush();
    type(app, "victoria");
    key(app, "ArrowDown");
    key(app, "ArrowDown");
    const ev = key(app, "Enter");
    assert.equal(ev.defaultPrevented, true);
    assert.equal(app.$("search").value, "");
    assert.equal(app.$("results").hidden, true);
    await flush();
    assert.equal(app.window.location.hash, "#01013");
    assert.equal(app.text("stop-name"), "St. Joseph's Church");
  });

  test("Enter with no active option picks the first match", async () => {
    start();
    await flush();
    type(app, "woodlands");
    key(app, "Enter");
    await flush();
    assert.equal(app.window.location.hash, "#46971");
  });

  test("Enter with no matches does nothing", async () => {
    start();
    await flush();
    type(app, "zzzz");
    const ev = key(app, "Enter");
    assert.equal(ev.defaultPrevented, false);
    assert.equal(app.window.location.hash, "");
  });

  test("Escape and blur close the list", async () => {
    start();
    await flush();
    type(app, "victoria");
    key(app, "Escape");
    assert.equal(app.$("results").hidden, true);

    type(app, "victoria");
    app.$("search").dispatchEvent(new app.window.Event("blur"));
    assert.equal(app.$("results").hidden, true);
    assert.equal(app.$("search").hasAttribute("aria-activedescendant"), false);
  });

  test("ArrowDown reopens a closed list", async () => {
    start();
    await flush();
    type(app, "victoria");
    key(app, "Escape");
    key(app, "ArrowDown");
    assert.equal(app.$("results").hidden, false);
  });

  test("mousedown on an option selects that stop", async () => {
    start();
    await flush();
    type(app, "sims");
    const li = resultItems(app)[0];
    const ev = new app.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    li.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    await flush();
    assert.equal(app.window.location.hash, "#83139");
    assert.equal(app.text("stop-name"), "Opp Blk 3");
  });
});

describe("stop view and arrivals", () => {
  test("opens the stop from the initial URL hash", async () => {
    start({ hash: "01012" });
    await flush();
    assert.equal(app.$("welcome").hidden, true);
    assert.equal(app.$("stop").hidden, false);
    assert.equal(app.text("stop-name"), "Hotel Grand Pacific");
    assert.equal(app.text("stop-meta"), "Victoria St · 01012");
    assert.equal(app.doc.title, "Hotel Grand Pacific · Bus Arrivals");
    assert.ok(app.calls.includes("https://arrivelah2.busrouter.sg/?id=01012"));
  });

  test("shows skeletons while arrivals are loading", async () => {
    start({ hash: "01012", routes: { arrivals: (_, signal) => hanging(signal) } });
    await flush();
    assert.equal(app.doc.querySelectorAll("#services .skeleton").length, 3);
    assert.equal(app.doc.querySelector("#services .hint").textContent, "Loading…");
    assert.ok(app.$("refresh").classList.contains("spin"));
  });

  test("renders services sorted with times, load, type and features", async () => {
    const services = [
      { no: "100", next: arrival({ load: "LSD", type: "BD", feature: "" }), next2: null },
      { no: "2", next: arrival({ load: "SDA", type: "DD" }), next2: arrival({ time: inMinutes(12) }) },
      { no: "10e", next: arrival({ time: new Date(Date.now() - 1000).toISOString() }), next2: arrival() },
    ];
    start({ hash: "01012", routes: { arrivals: () => json({ services }) } });
    await flush();

    assert.deepEqual(serviceNos(app), ["2", "10e", "100"]);
    const cards = app.doc.querySelectorAll("#services .service");

    const [first, second] = cards[0].querySelectorAll(".arrival");
    assert.equal(first.querySelector(".mins").textContent, "5 min");
    assert.match(first.querySelector(".sub").textContent, /Standing/);
    assert.ok(first.querySelector(".dot.SDA"));
    const badges = [...first.querySelectorAll(".badge")].map((b) => b.title);
    assert.deepEqual(badges, ["Double deck", "Wheelchair accessible"]);
    assert.equal(second.querySelector(".mins").textContent, "12 min");
    assert.match(second.querySelector(".mins").title, /\d/);

    assert.equal(cards[1].querySelector(".mins").textContent, "Arr");

    const [bendy, missing] = cards[2].querySelectorAll(".arrival");
    assert.match(bendy.querySelector(".sub").textContent, /Limited standing/);
    assert.equal(bendy.querySelector(".badge").title, "Bendy bus");
    assert.equal(missing.querySelector(".mins").textContent, "–");
    assert.ok(missing.querySelector(".mins").classList.contains("none"));
    assert.equal(missing.querySelector(".sub"), null);

    assert.ok(app.text("updated").startsWith("Updated "));
    assert.equal(app.$("warning").hidden, true);
    assert.equal(app.$("refresh").classList.contains("spin"), false);
  });

  test("marks unmonitored arrivals as scheduled", async () => {
    const services = [{ no: "7", next: arrival({ monitored: 0 }), next2: null }];
    start({ hash: "01012", routes: { arrivals: () => json({ services }) } });
    await flush();
    const cell = app.doc.querySelector("#services .arrival");
    assert.ok(cell.classList.contains("scheduled"));
    assert.equal(cell.querySelector(".tag").textContent, "Scheduled");
  });

  test("shows origin → destination using stop names, falling back to codes", async () => {
    const services = [
      { no: "1", next: arrival({ origin_code: "10009", destination_code: "46971" }), next2: null },
      { no: "2", next: arrival(), next2: arrival({ origin_code: "99999", destination_code: "01012" }) },
      { no: "3", next: arrival(), next2: null },
    ];
    start({ hash: "01012", routes: { arrivals: () => json({ services }) } });
    await flush();
    const routes = [...app.doc.querySelectorAll("#services .service")].map((c) => {
      const r = c.querySelector(".route");
      return r ? r.textContent : null;
    });
    assert.deepEqual(routes, ["Bt Merah Int → Woodlands Int", "99999 → Hotel Grand Pacific", null]);
  });

  test("shows a message when there are no services", async () => {
    start({ hash: "01012", routes: { arrivals: () => json({ services: [] }) } });
    await flush();
    assert.equal(app.doc.querySelector("#services .empty").textContent, "No bus services at the moment");
  });

  test("treats a response without a services array as empty", async () => {
    start({ hash: "01012", routes: { arrivals: () => json({}) } });
    await flush();
    assert.equal(app.doc.querySelector("#services .empty").textContent, "No bus services at the moment");
  });

  test("shows an error when the first arrivals load fails", async () => {
    start({ hash: "01012", routes: { arrivals: () => json(null, 503) } });
    await flush();
    assert.equal(app.doc.querySelector("#services .empty").textContent, "Couldn't load arrivals. Try the refresh button.");
    assert.equal(app.$("warning").hidden, true);
  });

  test("keeps the last data and shows a warning when a refresh fails", async () => {
    let fail = false;
    const services = [{ no: "7", next: arrival(), next2: null }];
    start({ hash: "01012", routes: { arrivals: () => (fail ? Promise.reject(new TypeError("offline")) : json({ services })) } });
    await flush();
    assert.equal(app.$("warning").hidden, true);

    fail = true;
    app.$("refresh").click();
    await flush();
    assert.equal(app.$("warning").hidden, false);
    assert.deepEqual(serviceNos(app), ["7"]);

    fail = false;
    app.$("refresh").click();
    await flush();
    assert.equal(app.$("warning").hidden, true);
  });

  test("shows 'Stop not found' for an unknown code", async () => {
    start({ hash: "00000" });
    await flush();
    assert.equal(app.text("stop-name"), "Stop not found");
    assert.equal(app.text("stop-meta"), 'No bus stop with code "00000".');
    assert.equal(app.$("fav").hidden, true);
    assert.equal(app.$("refresh").hidden, true);
    assert.equal(app.calls.some((u) => u.includes("?id=")), false);
  });

  test("ignores a stale response after switching stops", async () => {
    let resolveFirst;
    start({
      hash: "01012",
      routes: {
        arrivals: (code) =>
          code === "01012"
            ? new Promise((r) => (resolveFirst = r))
            : json({ services: [{ no: "99", next: arrival(), next2: null }] }),
      },
    });
    await flush();
    await goTo(app, "10009");
    assert.deepEqual(serviceNos(app), ["99"]);

    resolveFirst(json({ services: [{ no: "1", next: arrival(), next2: null }] }));
    await flush();
    assert.deepEqual(serviceNos(app), ["99"]);
    assert.equal(app.text("stop-name"), "Bt Merah Int");
  });

  test("aborts the in-flight request when navigating away", async () => {
    let aborted = false;
    start({
      hash: "01012",
      routes: {
        arrivals: (_, signal) => {
          signal.addEventListener("abort", () => (aborted = true));
          return hanging(signal);
        },
      },
    });
    await flush();
    await goTo(app, "");
    assert.equal(aborted, true);
  });

  test("the home link returns to the welcome screen", async () => {
    start({ hash: "01012" });
    await flush();
    app.$("home").click();
    await flush();
    assert.equal(app.$("stop").hidden, true);
    assert.equal(app.$("welcome").hidden, false);
    assert.equal(app.doc.title, "Bus Arrivals");
    assert.equal(app.window.location.hash, "");
    assert.equal(app.g("state.code"), null);
  });

  test("decodes and trims the hash", async () => {
    start({ hash: "%2001012%20" });
    await flush();
    assert.equal(app.text("stop-name"), "Hotel Grand Pacific");
  });
});

describe("timers and visibility", () => {
  test("starts refresh timers for a stop and clears them on home", async () => {
    start({ hash: "01012" });
    await flush();
    assert.notEqual(app.g("state.refreshTimer"), null);
    assert.notEqual(app.g("state.renderTimer"), null);
    await goTo(app, "");
    assert.equal(app.g("state.refreshTimer"), null);
    assert.equal(app.g("state.renderTimer"), null);
  });

  test("pauses when hidden and refetches when visible again", async () => {
    start({ hash: "01012" });
    await flush();
    let hidden = false;
    Object.defineProperty(app.doc, "hidden", { configurable: true, get: () => hidden });

    hidden = true;
    app.doc.dispatchEvent(new app.window.Event("visibilitychange"));
    assert.equal(app.g("state.refreshTimer"), null);

    const before = app.calls.filter((u) => u.includes("?id=")).length;
    hidden = false;
    app.doc.dispatchEvent(new app.window.Event("visibilitychange"));
    await flush();
    assert.equal(app.calls.filter((u) => u.includes("?id=")).length, before + 1);
    assert.notEqual(app.g("state.refreshTimer"), null);
  });
});

describe("favourites", () => {
  test("toggling the star saves to localStorage and renders a chip", async () => {
    start({ hash: "01012" });
    await flush();
    assert.equal(app.$("fav").textContent, "☆");
    assert.equal(app.$("fav").getAttribute("aria-pressed"), "false");

    app.$("fav").click();
    assert.equal(app.$("fav").textContent, "★");
    assert.equal(app.$("fav").getAttribute("aria-pressed"), "true");
    assert.equal(app.$("fav").title, "Remove from favourites");
    assert.equal(app.window.localStorage.getItem("bus-arrivals:favourites"), '["01012"]');
    const chips = app.doc.querySelectorAll("#favourites .chip");
    assert.equal(chips.length, 1);
    assert.equal(chips[0].textContent, "Hotel Grand Pacific01012");

    app.$("fav").click();
    assert.equal(app.$("fav").textContent, "☆");
    assert.equal(app.window.localStorage.getItem("bus-arrivals:favourites"), "[]");
    assert.equal(app.doc.querySelectorAll("#favourites .chip").length, 0);
  });

  test("loads saved favourites, skipping unknown codes and non-strings", async () => {
    start({ favourites: ["10009", "00000", 42, "46971"] });
    await flush();
    const names = [...app.doc.querySelectorAll("#favourites .chip")].map((c) => c.firstChild.textContent);
    assert.deepEqual(names, ["Bt Merah Int", "Woodlands Int"]);
  });

  test("clicking a chip opens that stop", async () => {
    start({ favourites: ["83139"] });
    await flush();
    app.doc.querySelector("#favourites .chip").click();
    await flush();
    assert.equal(app.window.location.hash, "#83139");
    assert.equal(app.text("stop-name"), "Opp Blk 3");
  });

  test("clicking the chip of the stop already open refreshes it", async () => {
    start({ hash: "83139", favourites: ["83139"] });
    await flush();
    const before = app.calls.length;
    app.doc.querySelector("#favourites .chip").click();
    await flush();
    assert.equal(app.calls.length, before + 1);
  });

  test("ignores corrupt or non-array storage", async () => {
    for (const raw of ["{not json", '{"a":1}', "null"]) {
      start({ favourites: raw });
      await flush();
      assert.equal(app.doc.querySelectorAll("#favourites .chip").length, 0, raw);
      app.close();
    }
    app = null;
  });
});
