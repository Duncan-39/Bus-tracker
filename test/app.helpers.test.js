"use strict";

// Unit tests for the pure helpers in app.js.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createApp, STOPS } = require("./helpers");

let app;
let h;
// Cross-realm values (arrays/objects built inside jsdom) fail deepStrictEqual
// on prototype checks, so compare plain JSON copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

before(() => {
  app = createApp({ scripts: ["app.js"], routes: { stops: () => new Promise(() => {}) } });
  h = app.window;
});
after(() => app.close());

describe("normalize", () => {
  test("lowercases and turns punctuation into single spaces", () => {
    assert.equal(h.normalize("St. Joseph's  Church"), "st joseph s church");
  });
  test("trims leading/trailing separators", () => {
    assert.equal(h.normalize("  --Bt Merah--  "), "bt merah");
  });
  test("coerces non-strings", () => {
    assert.equal(h.normalize(1012), "1012");
    assert.equal(h.normalize(null), "null");
  });
  test("returns empty string for punctuation only", () => {
    assert.equal(h.normalize("!!! ..."), "");
  });
});

describe("toStopList", () => {
  test("maps raw { code: [lng, lat, name, road] } to stop objects", () => {
    const list = plain(h.toStopList({ "01012": [103.85, 1.29, "Hotel Grand Pacific", "Victoria St"] }));
    assert.deepEqual(list, [
      {
        code: "01012",
        name: "Hotel Grand Pacific",
        road: "Victoria St",
        nName: "hotel grand pacific",
        nRoad: "victoria st",
      },
    ]);
  });
  test("returns an empty list for an empty object", () => {
    assert.equal(h.toStopList({}).length, 0);
  });
});

describe("searchStops", () => {
  let stops;
  before(() => {
    stops = h.toStopList(STOPS);
  });
  const codes = (list) => plain(list.map((s) => s.code));

  test("requires at least two normalized characters", () => {
    assert.equal(h.searchStops(stops, "").length, 0);
    assert.equal(h.searchStops(stops, "w").length, 0);
    assert.equal(h.searchStops(stops, " .w. ").length, 0);
  });

  test("exact code match ranks first, then code prefix", () => {
    assert.deepEqual(codes(h.searchStops(stops, "01012")), ["01012"]);
    assert.deepEqual(codes(h.searchStops(stops, "0101")), ["01012", "01013"]);
  });

  test("matches name prefix case-insensitively", () => {
    assert.deepEqual(codes(h.searchStops(stops, "WOODLANDS")), ["46971"]);
  });

  test("matches words inside the name", () => {
    assert.deepEqual(codes(h.searchStops(stops, "grand")), ["01012"]);
  });

  test("ignores punctuation and spacing differences", () => {
    assert.deepEqual(codes(h.searchStops(stops, "st joseph's")), ["01013"]);
    assert.deepEqual(codes(h.searchStops(stops, "stjoseph")), ["01013"]);
    assert.deepEqual(codes(h.searchStops(stops, "btmerah")), ["10009"]);
  });

  test("matches by road and ranks name hits above road hits", () => {
    const hits = codes(h.searchStops(stops, "victoria"));
    assert.deepEqual(hits, ["01012", "01013"]);
    assert.deepEqual(codes(h.searchStops(stops, "sims")), ["83139"]);
  });

  test("name-prefix hits sort before substring hits", () => {
    const list = h.toStopList({
      A: [0, 0, "Opp Bedok Stn", "Bedok Rd"],
      B: [0, 0, "Bedok Int", "Bedok Nth Rd"],
    });
    assert.deepEqual(codes(h.searchStops(list, "bedok")), ["B", "A"]);
  });

  test("ties within a rank are sorted by name", () => {
    const list = h.toStopList({
      X: [0, 0, "Zebra Rd", "Same Rd"],
      Y: [0, 0, "Apple Rd", "Same Rd"],
    });
    assert.deepEqual(codes(h.searchStops(list, "same")), ["Y", "X"]);
  });

  test("respects the result limit (default 8)", () => {
    const raw = {};
    for (let i = 0; i < 20; i++) raw[String(10000 + i)] = [0, 0, `Stop ${i}`, "Main Rd"];
    const list = h.toStopList(raw);
    assert.equal(h.searchStops(list, "main").length, 8);
    assert.equal(h.searchStops(list, "main", 3).length, 3);
  });

  test("returns nothing when no stop matches", () => {
    assert.equal(h.searchStops(stops, "zzzz").length, 0);
  });
});

describe("minutesUntil", () => {
  const now = Date.parse("2026-01-01T08:00:00+08:00");
  const at = (ms) => ({ time: new Date(now + ms).toISOString() });

  test("returns whole minutes, rounded down", () => {
    assert.equal(h.minutesUntil(at(5 * 60000), now), 5);
    assert.equal(h.minutesUntil(at(5 * 60000 + 59000), now), 5);
    assert.equal(h.minutesUntil(at(59000), now), 0);
  });
  test("is negative for past arrivals", () => {
    assert.equal(h.minutesUntil(at(-30000), now), -1);
  });
  test("returns null for missing or invalid input", () => {
    assert.equal(h.minutesUntil(null, now), null);
    assert.equal(h.minutesUntil(undefined, now), null);
    assert.equal(h.minutesUntil({}, now), null);
    assert.equal(h.minutesUntil({ time: "" }, now), null);
    assert.equal(h.minutesUntil({ time: "not a date" }, now), null);
  });
});

describe("formatMinutes", () => {
  const now = Date.parse("2026-01-01T08:00:00Z");
  const at = (ms) => ({ time: new Date(now + ms).toISOString() });

  test("shows minutes with a unit", () => {
    assert.deepEqual(plain(h.formatMinutes(at(3 * 60000), now)), { text: "3", unit: "min", none: false });
  });
  test("shows Arr under one minute and for past times", () => {
    assert.deepEqual(plain(h.formatMinutes(at(30000), now)), { text: "Arr", unit: "", none: false });
    assert.deepEqual(plain(h.formatMinutes(at(-120000), now)), { text: "Arr", unit: "", none: false });
  });
  test("shows a dash when there is no time", () => {
    assert.deepEqual(plain(h.formatMinutes(null, now)), { text: "–", unit: "", none: true });
    assert.deepEqual(plain(h.formatMinutes({ time: "" }, now)), { text: "–", unit: "", none: true });
  });
});

describe("naturalCompare / sortServices", () => {
  test("orders bus numbers numerically, letters after the number", () => {
    const sorted = h.sortServices([{ no: "100" }, { no: "2" }, { no: "10e" }, { no: "10" }, { no: "NR1" }, { no: "7A" }]);
    assert.deepEqual(plain(sorted.map((s) => s.no)), ["2", "7A", "10", "10e", "100", "NR1"]);
  });
  test("does not mutate the input array", () => {
    const input = [{ no: "20" }, { no: "3" }];
    h.sortServices(input);
    assert.deepEqual(input.map((s) => s.no), ["20", "3"]);
  });
  test("is case-insensitive", () => {
    assert.equal(h.naturalCompare("10e", "10E"), 0);
  });
});
