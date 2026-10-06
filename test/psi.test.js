"use strict";

// psi.js keeps everything inside an IIFE, so it is tested through the DOM.

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, flush, json, hanging } = require("./helpers");

let app;
afterEach(() => app && app.close());

const REGIONS = ["central", "north", "east", "west", "south"];

function readings(psi, pm25 = {}, pm10 = {}) {
  return {
    psi_twenty_four_hourly: psi,
    pm25_twenty_four_hourly: pm25,
    pm10_twenty_four_hourly: pm10,
  };
}

function item(r, minutesAgo = 10) {
  return { timestamp: new Date(Date.now() - minutesAgo * 60000).toISOString(), readings: r };
}

async function start(psi) {
  app = createApp({ scripts: ["psi.js"], routes: { psi } });
  await flush();
  return app;
}

function rows() {
  return [...app.doc.querySelectorAll("#psi-body tr")].map((tr) =>
    [...tr.children].map((c) => c.textContent)
  );
}

describe("PSI table", () => {
  test("shows Loading… before the first response", async () => {
    await start((signal) => hanging(signal));
    assert.deepEqual(rows(), [["Loading…"]]);
  });

  test("renders one row per region with PSI band, PM2.5 and PM10", async () => {
    const psi = { central: 40, north: 51, east: 150, west: 250, south: 301 };
    const pm25 = { central: 10, north: 11, east: 12, west: 13, south: 14 };
    const pm10 = { central: 20, north: 21, east: 22, west: 23, south: 24 };
    await start(() => json({ data: { items: [item(readings(psi, pm25, pm10))] } }));

    assert.deepEqual(rows(), [
      ["Central", "40 Good", "10", "20"],
      ["North", "51 Moderate", "11", "21"],
      ["East", "150 Unhealthy", "12", "22"],
      ["West", "250 Very unhealthy", "13", "23"],
      ["South", "301 Hazardous", "14", "24"],
    ]);
    const dots = [...app.doc.querySelectorAll("#psi-body .dot")].map((d) => d.className);
    assert.deepEqual(dots, [
      "dot psi-good",
      "dot psi-moderate",
      "dot psi-unhealthy",
      "dot psi-very-unhealthy",
      "dot psi-hazardous",
    ]);
    assert.equal(app.doc.querySelector("#psi-body th").getAttribute("scope"), "row");
  });

  test("band boundaries are inclusive at 50 / 100 / 200 / 300", async () => {
    const psi = { central: 50, north: 100, east: 200, west: 300, south: 0 };
    await start(() => json({ data: { items: [item(readings(psi))] } }));
    assert.deepEqual(
      rows().map((r) => r[1]),
      ["50 Good", "100 Moderate", "200 Unhealthy", "300 Very unhealthy", "0 Good"]
    );
  });

  test("shows dashes for missing or non-numeric readings", async () => {
    const psi = { central: "42", north: null };
    await start(() => json({ data: { items: [item({ psi_twenty_four_hourly: psi })] } }));
    for (const r of rows()) assert.deepEqual(r.slice(1), ["–", "–", "–"]);
    assert.equal(rows().length, REGIONS.length);
  });

  test("uses the newest item regardless of order", async () => {
    const older = item(readings({ central: 10 }), 120);
    const newer = item(readings({ central: 99 }), 5);
    await start(() => json({ data: { items: [older, newer] } }));
    assert.equal(rows()[0][1], "99 Moderate");
  });

  test("shows 'No PSI data available' when items is empty or missing", async () => {
    await start(() => json({ data: { items: [] } }));
    assert.deepEqual(rows(), [["No PSI data available"]]);
    app.close();

    await start(() => json({}));
    assert.deepEqual(rows(), [["No PSI data available"]]);
  });
});

describe("PSI status line", () => {
  test("shows 'As of' and 'checked' times and hides stale notice for fresh data", async () => {
    await start(() => json({ data: { items: [item(readings({ central: 30 }))] } }));
    assert.match(app.text("psi-asof"), /^As of .+ · checked .+$/);
    assert.equal(app.$("psi-stale").hidden, true);
    assert.equal(app.$("psi-error").hidden, true);
    assert.equal(app.$("psi-warning").hidden, true);
  });

  test("flags data older than two hours as delayed", async () => {
    await start(() => json({ data: { items: [item(readings({ central: 30 }), 121)] } }));
    assert.equal(app.$("psi-stale").hidden, false);
  });

  test("does not flag data just under two hours old", async () => {
    await start(() => json({ data: { items: [item(readings({ central: 30 }), 119)] } }));
    assert.equal(app.$("psi-stale").hidden, true);
  });

  test("omits 'As of' when the timestamp is invalid", async () => {
    await start(() => json({ data: { items: [{ timestamp: "bogus", readings: readings({ central: 30 }) }] } }));
    assert.match(app.text("psi-asof"), /^checked /);
    assert.equal(app.$("psi-stale").hidden, true);
  });
});

describe("PSI errors and refresh", () => {
  test("shows an error when the first load fails", async () => {
    await start(() => json(null, 500));
    assert.equal(app.$("psi-error").hidden, false);
    assert.equal(app.$("psi-warning").hidden, true);
    assert.deepEqual(rows(), [["PSI data unavailable"]]);
  });

  test("keeps the last table and warns when a later refresh fails", async () => {
    let fail = false;
    let hidden = false;
    await start(() => (fail ? Promise.reject(new TypeError("offline")) : json({ data: { items: [item(readings({ central: 30 }))] } })));
    assert.equal(rows()[0][1], "30 Good");

    // Becoming visible again triggers a refetch.
    Object.defineProperty(app.doc, "hidden", { configurable: true, get: () => hidden });
    fail = true;
    app.doc.dispatchEvent(new app.window.Event("visibilitychange"));
    await flush();
    assert.equal(app.$("psi-warning").hidden, false);
    assert.equal(app.$("psi-error").hidden, true);
    assert.equal(rows()[0][1], "30 Good");

    fail = false;
    app.doc.dispatchEvent(new app.window.Event("visibilitychange"));
    await flush();
    assert.equal(app.$("psi-warning").hidden, true);
  });

  test("does not refetch while the page is hidden", async () => {
    let count = 0;
    await start(() => {
      count++;
      return json({ data: { items: [] } });
    });
    assert.equal(count, 1);
    Object.defineProperty(app.doc, "hidden", { configurable: true, get: () => true });
    app.doc.dispatchEvent(new app.window.Event("visibilitychange"));
    await flush();
    assert.equal(count, 1);
  });
});
