"use strict";

// Independent of app.js: own state, timers and error handling.
(function () {
  const PSI_URL = "https://api-open.data.gov.sg/v2/real-time/api/psi";
  const REFRESH_MS = 10 * 60 * 1000;
  const STALE_MS = 2 * 60 * 60 * 1000;
  const REGIONS = [
    ["central", "Central"],
    ["north", "North"],
    ["east", "East"],
    ["west", "West"],
    ["south", "South"],
  ];

  /* ---------- pure helpers ---------- */

  // NEA PSI bands. Returns null for a missing or non-numeric value.
  function psiBand(value) {
    if (typeof value !== "number" || Number.isNaN(value)) return null;
    if (value <= 50) return { key: "good", label: "Good" };
    if (value <= 100) return { key: "moderate", label: "Moderate" };
    if (value <= 200) return { key: "unhealthy", label: "Unhealthy" };
    if (value <= 300) return { key: "very-unhealthy", label: "Very unhealthy" };
    return { key: "hazardous", label: "Hazardous" };
  }

  // The API returns items newest first, but pick by timestamp to be safe.
  function latestItem(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    return items.reduce((a, b) => (Date.parse(b.timestamp) > Date.parse(a.timestamp) ? b : a));
  }

  function isStale(timestamp, now = Date.now()) {
    const t = Date.parse(timestamp);
    return !Number.isNaN(t) && now - t > STALE_MS;
  }

  function reading(item, key, region) {
    const group = item && item.readings && item.readings[key];
    const v = group ? group[region] : undefined;
    return typeof v === "number" ? v : null;
  }

  /* ---------- DOM ---------- */

  const $ = (id) => document.getElementById(id);
  const els = {
    asof: $("psi-asof"),
    stale: $("psi-stale"),
    warning: $("psi-warning"),
    error: $("psi-error"),
    body: $("psi-body"),
  };

  function cell(text, cls) {
    const td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  function messageRow(text) {
    const tr = document.createElement("tr");
    const td = cell(text, "psi-msg");
    td.colSpan = 4;
    tr.append(td);
    return tr;
  }

  function renderTable(item) {
    els.body.replaceChildren();
    if (!item) {
      els.body.append(messageRow("No PSI data available"));
      return;
    }
    for (const [region, label] of REGIONS) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = label;
      tr.append(th);

      const psi = reading(item, "psi_twenty_four_hourly", region);
      const band = psiBand(psi);
      const psiTd = document.createElement("td");
      if (band) {
        const dot = document.createElement("span");
        dot.className = `dot psi-${band.key}`;
        dot.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "psi-band";
        text.textContent = band.label;
        psiTd.append(String(psi), " ", dot, text);
      } else {
        psiTd.textContent = "–";
      }
      tr.append(psiTd);

      for (const key of ["pm25_twenty_four_hourly", "pm10_twenty_four_hourly"]) {
        const v = reading(item, key, region);
        tr.append(cell(v === null ? "–" : String(v)));
      }
      els.body.append(tr);
    }
  }

  /* ---------- state + fetching ---------- */

  const state = { item: null, loaded: false, failed: false, checkedAt: null, token: 0, controller: null, timer: null };

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function render() {
    els.error.hidden = !(state.failed && !state.loaded);
    els.warning.hidden = !(state.failed && state.loaded);
    if (state.loaded) renderTable(state.item);

    const ts = state.item && new Date(state.item.timestamp);
    const hasTs = ts && !Number.isNaN(ts.getTime());
    const parts = [];
    if (hasTs) parts.push(`As of ${fmtTime(ts)}`);
    if (state.checkedAt) parts.push(`checked ${fmtTime(state.checkedAt)}`);
    els.asof.textContent = parts.length ? parts.join(" · ") : " ";
    els.stale.hidden = !(hasTs && isStale(state.item.timestamp));
  }

  async function fetchPsi() {
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const token = ++state.token;
    try {
      const res = await fetch(PSI_URL, { signal: controller.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      if (token !== state.token) return;
      state.item = latestItem(json && json.data && json.data.items);
      state.loaded = true;
      state.failed = false;
      state.checkedAt = new Date();
    } catch (err) {
      if (err.name === "AbortError" || token !== state.token) return;
      state.failed = true;
      if (!state.loaded) els.body.replaceChildren(messageRow("PSI data unavailable"));
    }
    render();
  }

  function startTimer() {
    clearInterval(state.timer);
    state.timer = document.hidden ? null : setInterval(fetchPsi, REFRESH_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) fetchPsi();
    startTimer();
  });

  fetchPsi();
  startTimer();
})();
