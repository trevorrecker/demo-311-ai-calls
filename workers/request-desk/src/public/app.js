"use strict";

(() => {
  const LIMITS = { report: 1200, neighborhood: 100 };
  const DEFAULT_MAX_PHOTO_BASE64 = 349528; // 256 KiB decoded
  const MAX_PHOTO_EDGE = 768;
  const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 25000;
  const MAX_RUNS = 12;
  const MAX_ASSESSMENT_CHARS = 4000;
  const DRAFT_KEY = "rd311.draft";
  const PHOTO_KEY = "rd311.photo";
  const THEME_KEY = "rd311.theme";
  // Stable (/) uses the defaults. /experimental/ sets <base href="/experimental/"> so relative api/ calls
  // reach its own label, loads shared files from the root, and keeps a separate run history.
  const page = document.documentElement.dataset;
  const ASSET_BASE = page.assetBase || "";
  const RUNS_KEY = page.variant ? `rd311.runs.${page.variant}` : "rd311.runs";

  const $ = (id) => document.getElementById(id);
  const el = {
    form: $("request-form"),
    neighborhood: $("neighborhood"),
    report: $("report"),
    neighborhoodCount: $("neighborhood-count"),
    reportCount: $("report-count"),
    neighborhoodError: $("neighborhood-error"),
    reportError: $("report-error"),
    photoZone: $("photo-zone"),
    photoEmpty: $("photo-empty"),
    photoFilled: $("photo-filled"),
    photoPreview: $("photo-preview"),
    photoName: $("photo-name"),
    photoSize: $("photo-size"),
    photoInput: $("photo-input"),
    photoChoose: $("photo-choose"),
    photoReplace: $("photo-replace"),
    photoRemove: $("photo-remove"),
    photoError: $("photo-error"),
    assess: $("assess"),
    assessLabel: $("assess-label"),
    assessKbd: $("assess-kbd"),
    loadSample: $("load-sample"),
    clearForm: $("clear-form"),
    themeToggle: $("theme-toggle"),
    runLabel: $("run-label"),
    live: $("live"),
    changeNote: $("change-note"),
    changeText: $("change-text"),
    compareToggle: $("compare-toggle"),
    error: $("error"),
    resultBody: $("result-body"),
    empty: $("empty"),
    assessment: $("assessment"),
    pending: $("pending"),
    elapsed: $("elapsed"),
    meta: $("meta"),
    compare: $("compare"),
    compareTitle: $("compare-title"),
    compareBody: $("compare-body"),
    insights: $("insights"),
    insightsLabel: $("insights-label"),
    insightsRun: $("insights-run"),
    insightsRunLabel: $("insights-run-label"),
    insightsElapsed: $("insights-elapsed"),
    insightsNote: $("insights-note"),
    insightsError: $("insights-error"),
    insightsBody: $("insights-body"),
    insightsMeta: $("insights-meta"),
    history: $("history"),
    historyList: $("history-list"),
  };

  const state = {
    config: { callName: null, callId: null, maxPhotoBase64Chars: DEFAULT_MAX_PHOTO_BASE64, insights: null },
    photo: null, // { base64, name, width, height }
    photoBusy: false,
    runs: [], // { id, at, ok, input, elapsedMs, assessment?, ...provenance, error?, insights? }
    selected: -1,
    pending: null, // { controller, startedAt, timer }
    insightsPending: null, // { controller, timer, runId, cancelled }
    compareOpen: false,
  };

  // ---------- storage ----------
  const store = {
    get(area, key) {
      try { return JSON.parse(area.getItem(key) || "null"); } catch { return null; }
    },
    set(area, key, value) {
      try {
        if (value == null) area.removeItem(key);
        else area.setItem(key, JSON.stringify(value));
      } catch { /* quota or privacy mode: retention degrades to in-memory */ }
    },
  };
  const saveDraft = () => store.set(localStorage, DRAFT_KEY, { report: el.report.value, neighborhood: el.neighborhood.value });
  const savePhoto = () => store.set(localStorage, PHOTO_KEY, state.photo);
  const saveRuns = () => store.set(sessionStorage, RUNS_KEY, state.runs);

  // ---------- form ----------
  const formFields = () => ({ report: el.report.value.trim(), neighborhood: el.neighborhood.value.trim() });

  function updateCounters() {
    for (const [field, counter] of [[el.report, el.reportCount], [el.neighborhood, el.neighborhoodCount]]) {
      const max = LIMITS[field.name];
      const n = field.value.trim().length;
      counter.textContent = `${n}/${max}`;
      counter.classList.toggle("near", n > max * 0.9);
    }
  }

  function setFieldError(field, errorEl, message) {
    errorEl.textContent = message || "";
    errorEl.hidden = !message;
    if (message) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
  }

  function validate() {
    const fields = formFields();
    const tooLong = (name) => `Keep it under ${LIMITS[name]} characters.`;
    const neighborhoodMsg = !fields.neighborhood ? "Add the neighborhood."
      : fields.neighborhood.length > LIMITS.neighborhood ? tooLong("neighborhood") : "";
    const reportMsg = !fields.report ? "Describe what you saw."
      : fields.report.length > LIMITS.report ? tooLong("report") : "";
    setFieldError(el.neighborhood, el.neighborhoodError, neighborhoodMsg);
    setFieldError(el.report, el.reportError, reportMsg);
    if (neighborhoodMsg) el.neighborhood.focus();
    else if (reportMsg) el.report.focus();
    return neighborhoodMsg || reportMsg ? null : fields;
  }

  // ---------- photo ----------
  function renderPhoto() {
    const p = state.photo;
    el.photoEmpty.hidden = !!p;
    el.photoFilled.hidden = !p;
    el.photoZone.classList.toggle("busy", state.photoBusy);
    if (p) {
      el.photoPreview.src = `data:image/jpeg;base64,${p.base64}`;
      el.photoName.textContent = p.name;
      el.photoSize.textContent = `${p.width}×${p.height} JPEG · ${Math.round((p.base64.length * 3) / 4 / 1024)} KiB`;
    } else {
      el.photoPreview.removeAttribute("src");
    }
  }

  function showPhotoError(message) {
    el.photoError.textContent = message || "";
    el.photoError.hidden = !message;
  }

  async function decodeImage(blob) {
    if ("createImageBitmap" in window) {
      try { return await createImageBitmap(blob); } catch { /* fall back to <img> decoding */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  const canvasToJpeg = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

  // Re-encode any browser-decodable image to a JPEG that fits the Worker's payload limit.
  async function encodePhoto(blob) {
    const image = await decodeImage(blob);
    const srcW = image.width, srcH = image.height;
    if (!srcW || !srcH) throw new Error("That image appears to be empty.");
    const max = state.config.maxPhotoBase64Chars;
    const base = Math.min(1, MAX_PHOTO_EDGE / Math.max(srcW, srcH));
    const attempts = [[1, 0.85], [1, 0.75], [1, 0.65], [0.8, 0.7], [0.6, 0.7], [0.45, 0.65]];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    try {
      for (const [shrink, quality] of attempts) {
        canvas.width = Math.max(1, Math.round(srcW * base * shrink));
        canvas.height = Math.max(1, Math.round(srcH * base * shrink));
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const jpeg = await canvasToJpeg(canvas, quality);
        if (!jpeg) throw new Error("This browser could not encode the photo.");
        const base64 = await blobToBase64(jpeg);
        if (base64.length <= max) return { base64, width: canvas.width, height: canvas.height };
      }
    } finally {
      if (typeof image.close === "function") image.close();
    }
    throw new Error("That photo is too detailed to send. Try a smaller or simpler image.");
  }

  async function attachPhoto(blob, name) {
    if (state.photoBusy) return;
    showPhotoError("");
    if (!blob || !blob.type.startsWith("image/")) {
      showPhotoError("Choose a JPEG, PNG, WebP, or GIF image.");
      return;
    }
    if (blob.size > MAX_SOURCE_BYTES) {
      showPhotoError("That file is over 25 MB. Choose a smaller photo.");
      return;
    }
    state.photoBusy = true;
    renderPhoto();
    try {
      state.photo = { ...(await encodePhoto(blob)), name: name || "photo.jpg" };
      savePhoto();
    } catch (err) {
      showPhotoError(err instanceof Error && err.message ? err.message : "Could not read that image.");
    } finally {
      state.photoBusy = false;
      renderPhoto();
      renderInsights(state.runs[state.selected]);
    }
  }

  function removePhoto() {
    state.photo = null;
    savePhoto();
    showPhotoError("");
    renderPhoto();
    renderInsights(state.runs[state.selected]);
    el.photoChoose.focus();
  }

  // ---------- model text ----------
  // Model output is plain text that the Calls ask to format as "Label: value" lines and short paragraphs. Split it
  // into sections: a label line starts one, the lines right after it continue its value, and a label on its own line
  // ("Field check:" or "## Field check") keeps every following paragraph until the next label. Unlabeled paragraphs
  // stand on their own. Everything reaches the page through textContent, never HTML.
  const LABEL_LINE = /^(?:#{1,4}\s+)?([A-Z][A-Za-z0-9 /&'’-]{0,40}?)\s*(\([^()]{1,60}\))?\s*(:\s*(.*))?$/;
  const LIST_ITEM = /^(?:[-*•]|\d{1,2}[.)])\s+/;

  // Returns { label, value } when the line opens a section. "Priority (High, Medium, or Low): High" drops the
  // option list the prompt asked for; "Suggested agency (DOT): ..." keeps its note.
  function readLabel(line) {
    const markdownHeading = /^#{1,4}\s/.test(line);
    const match = LABEL_LINE.exec(line);
    if (!match || (!match[3] && !markdownHeading)) return null;
    const [, name, note, , value = ""] = match;
    if (name.trim().split(/\s+/).length > 5 || /\d$/.test(name.trim())) return null;
    const options = note && /,|\bor\b/.test(note);
    return { label: note && !options ? `${name.trim()} ${note}` : name.trim(), value: value.trim() };
  }

  function parseSections(text) {
    const sections = []; // { label, paragraphs: string[][] }
    let section = null; // receives the next line
    let paragraph = null; // the lines of the open paragraph
    let inlineValue = false; // the section's value started on its label line, so a blank line ends it

    for (const raw of String(text).replace(/\r\n?/g, "\n").split("\n")) {
      const line = raw.replace(/\*\*|__/g, "").trim();
      if (!line) {
        paragraph = null;
        if (inlineValue) section = null;
        continue;
      }
      const heading = readLabel(line);
      if (heading) {
        section = { label: heading.label, paragraphs: [] };
        sections.push(section);
        inlineValue = !!heading.value;
        paragraph = heading.value ? [heading.value] : null;
        if (paragraph) section.paragraphs.push(paragraph);
        continue;
      }
      if (!section) {
        section = { label: "", paragraphs: [] };
        sections.push(section);
        inlineValue = false;
      }
      if (!paragraph) section.paragraphs.push((paragraph = []));
      paragraph.push(line);
    }
    return sections;
  }

  const toneFor = (label, paragraphs) => {
    const value = paragraphs.length === 1 && paragraphs[0].length === 1 ? paragraphs[0][0] : "";
    if (!/^(priority|urgency|severity|risk)\b/i.test(label) || !value || value.length > 40) return "";
    if (/^(high|urgent|critical|emergency|immediate)/i.test(value)) return "high";
    if (/^(medium|moderate|normal|standard)/i.test(value)) return "medium";
    if (/^(low|routine|minor)/i.test(value)) return "low";
    return "";
  };

  function renderText(container, text) {
    const nodes = parseSections(text).map(({ label, paragraphs }) => {
      const section = document.createElement("div");
      section.className = label ? "section" : "section note";
      if (label) {
        const name = document.createElement("p");
        name.className = "section-label";
        name.textContent = label;
        section.append(name);
      }
      const body = document.createElement("div");
      body.className = "section-body";
      const tone = toneFor(label, paragraphs);
      if (tone) body.dataset.tone = tone;
      for (const lines of paragraphs) {
        if (lines.length > 1 && lines.every((line) => LIST_ITEM.test(line))) {
          const list = document.createElement("ul");
          list.append(...lines.map((line) => {
            const item = document.createElement("li");
            item.textContent = line.replace(LIST_ITEM, "");
            return item;
          }));
          body.append(list);
        } else {
          const p = document.createElement("p");
          p.textContent = lines.join("\n");
          body.append(p);
        }
      }
      section.append(body);
      return section;
    });
    container.replaceChildren(...nodes);
  }

  // Re-render only when the content changes, and replay the entrance animation for new content.
  function showText(container, key, text) {
    if (container.dataset.key === key) return;
    renderText(container, text);
    container.dataset.key = key;
    container.classList.remove("fresh");
    void container.offsetWidth;
    container.classList.add("fresh");
  }

  // ---------- result rendering ----------
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const fmtSecs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const isVersion = (v) => typeof v === "number" && Number.isFinite(v);

  function photoNote(run, included) {
    const photo = run.input.photo;
    if (!photo) return "text only";
    const size = `${photo.width}×${photo.height}`;
    return included === false ? `photo not used (${size})` : `photo ${size}`;
  }

  // One quiet line of provenance: which saved Call answered and how. Each part wraps as a whole.
  function showMeta(target, callName, result, run) {
    const parts = [
      callName,
      result.callLabel && `label ${result.callLabel}`,
      isVersion(result.callVersion) && `version ${result.callVersion}`,
      result.route,
      result.model,
      photoNote(run, result.photoIncluded),
    ].filter(Boolean);
    target.replaceChildren(...parts.map((part) => {
      const span = document.createElement("span");
      span.textContent = part;
      return span;
    }));
  }

  function showError(prefix, error) {
    $(`${prefix}-title`).textContent = error.title;
    $(`${prefix}-message`).textContent = error.message;
    $(`${prefix}-code`).textContent = error.code;
  }

  function previousOk(index) {
    for (let i = index - 1; i >= 0; i--) if (state.runs[i].ok) return state.runs[i];
    return null;
  }

  function render() {
    const run = state.runs[state.selected];
    const isPending = !!state.pending;

    el.empty.hidden = !!run || isPending;
    el.pending.hidden = !isPending;
    el.resultBody.setAttribute("aria-busy", String(isPending));
    el.runLabel.textContent = run ? runLabel(run) : "";
    el.error.hidden = !run || run.ok;
    el.assessment.hidden = !run || !run.ok;
    el.assessment.classList.toggle("dim", isPending);
    el.meta.hidden = !run || !run.ok;

    if (run && !run.ok) showError("error", run.error);
    if (run && run.ok) {
      showText(el.assessment, run.id, run.assessment);
      showMeta(el.meta, run.callName || state.config.callName || run.callId || state.config.callId, run, run);
    }
    renderChange(run);
    renderInsights(run);
    renderHistory();
  }

  function runLabel(run) {
    const bits = [`Run ${state.selected + 1}`, fmtTime(run.at)];
    if (run.elapsedMs != null) bits.push(fmtSecs(run.elapsedMs));
    if (state.selected !== state.runs.length - 1) bits.push("earlier run");
    return bits.join(" · ");
  }

  // When the saved Call version behind a label changes between runs, offer the previous answer side by side.
  function renderChange(run) {
    const prev = run && run.ok ? previousOk(state.selected) : null;
    const changed = !!prev && isVersion(prev.callVersion) && isVersion(run.callVersion) && prev.callVersion !== run.callVersion;
    el.changeNote.hidden = !changed;
    el.compare.hidden = !(changed && state.compareOpen);
    if (!changed) return;

    const sameInput = prev.input.fingerprint && prev.input.fingerprint === run.input.fingerprint;
    el.changeText.textContent = `Call version changed from ${prev.callVersion} to ${run.callVersion}. ${sameInput ? "Same input." : "Input also changed."}`;
    el.compareToggle.textContent = state.compareOpen ? "Hide previous" : `Compare with version ${prev.callVersion}`;
    el.compareToggle.setAttribute("aria-expanded", String(state.compareOpen));
    if (state.compareOpen) {
      el.compareTitle.textContent = `Version ${prev.callVersion} · Run ${state.runs.indexOf(prev) + 1}`;
      showText(el.compareBody, prev.id, prev.assessment);
    }
  }

  function renderHistory() {
    el.history.hidden = state.runs.length < 2;
    el.historyList.replaceChildren(...state.runs.map((run, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.index = String(i);
      if (i === state.selected) btn.setAttribute("aria-current", "true");
      if (!run.ok) btn.className = "failed";
      btn.textContent = run.ok ? `${i + 1}${isVersion(run.callVersion) ? ` · v${run.callVersion}` : ""}` : `${i + 1} · error`;
      const detail = run.ok ? (isVersion(run.callVersion) ? `version ${run.callVersion}` : "") : "error";
      btn.title = [`Run ${i + 1}`, detail, run.input.photo ? "photo" : "", run.elapsedMs != null ? fmtSecs(run.elapsedMs) : ""]
        .filter(Boolean).join(" · ");
      btn.setAttribute("aria-label", [`Run ${i + 1}`, detail].filter(Boolean).join(", "));
      const li = document.createElement("li");
      li.append(btn);
      return li;
    }));
  }

  // ---------- insights (secondary, non-streaming) ----------
  const currentFingerprint = () => inputFingerprint(formFields(), state.photo);

  function renderInsights(run) {
    const cfg = state.config.insights;
    el.insights.hidden = !cfg || !run || !run.ok;
    if (el.insights.hidden) return;

    const busy = state.insightsPending;
    const pending = !!busy && busy.runId === run.id;
    const ins = pending ? null : run.insights;
    const stale = !pending && currentFingerprint() !== run.input.fingerprint;
    const blocked = !pending && (!!state.pending || !!busy || state.photoBusy || stale);

    el.insightsRun.dataset.state = pending ? "pending" : "idle";
    if (pending || blocked) el.insightsRun.setAttribute("aria-disabled", "true");
    else el.insightsRun.removeAttribute("aria-disabled");
    el.insightsRunLabel.textContent = pending ? "Analyzing…" : ins && ins.ok ? "Run again" : "More insights";
    el.insightsElapsed.hidden = !pending;
    el.insightsNote.hidden = !stale;
    el.insightsNote.textContent = stale ? "The form changed after this run. Assess again to get insights for it." : "";
    el.insightsLabel.textContent = ins ? [fmtTime(ins.at), ins.elapsedMs != null && fmtSecs(ins.elapsedMs)].filter(Boolean).join(" · ") : "";

    el.insightsError.hidden = !ins || ins.ok;
    if (ins && !ins.ok) showError("insights-error", ins.error);

    const shown = run.insights && run.insights.ok ? run.insights : null;
    el.insightsBody.hidden = !shown;
    el.insightsMeta.hidden = !shown || pending;
    el.insightsBody.classList.toggle("dim", pending);
    if (shown) {
      showText(el.insightsBody, `${run.id}@${shown.at}`, shown.text);
      showMeta(el.insightsMeta, shown.callName || cfg.callName || shown.callId || cfg.callId, shown, run);
    }
  }

  function cancelInsights() {
    const busy = state.insightsPending;
    if (!busy) return;
    busy.cancelled = true;
    busy.controller.abort();
    clearInterval(busy.timer);
    state.insightsPending = null;
  }

  async function requestInsights() {
    const run = state.runs[state.selected];
    if (!run || !run.ok || !state.config.insights) return;
    if (state.pending || state.insightsPending || state.photoBusy) return;
    const fields = formFields();
    const photo = state.photo;
    // Insights must describe the same input the assessment saw; the form is the only copy of it.
    if (inputFingerprint(fields, photo) !== run.input.fingerprint) return;

    const startedAt = performance.now();
    const busy = {
      runId: run.id,
      controller: new AbortController(),
      cancelled: false,
      timer: setInterval(() => { el.insightsElapsed.textContent = fmtSecs(performance.now() - startedAt); }, 100),
    };
    state.insightsPending = busy;
    el.insightsElapsed.textContent = "0.0s";
    el.live.textContent = photo ? "Analyzing the photo and assessment." : "Analyzing the assessment.";
    render();

    const assessment = String(run.assessment).trim().slice(0, MAX_ASSESSMENT_CHARS);
    const reply = await callWorker("api/insights", requestBody({ ...fields, assessment }, photo), "insights", busy.controller);
    if (busy.cancelled) return;

    clearInterval(busy.timer);
    state.insightsPending = null;
    run.insights = { at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - startedAt), ...reply };
    saveRuns();
    render();
    if (state.runs[state.selected] === run) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.insights.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "nearest" });
    }
    el.live.textContent = announce("Insights", reply);
  }

  // ---------- request ----------
  const ERROR_TITLES = {
    invalid_request: "The desk couldn't accept that request",
    payload_too_large: "That request is too large",
    rate_limited: "Too many requests right now",
    ai_unavailable: "AI Calls are unavailable right now",
    unavailable: "The desk is unavailable right now",
    upstream_timeout: "The model took too long to answer",
    upstream_error: "The AI service returned an error",
    timeout: "No answer within 25 seconds",
    network: "Couldn't reach the Worker",
    not_found: "That endpoint wasn't found",
    label_not_found: "This AI Call label isn't assigned",
    method_not_allowed: "The Worker rejected this request method",
    bad_response: "The Worker sent an unexpected response",
  };

  // The Worker host can answer 413/503/504 with an empty or non-JSON body before the app runs,
  // so fall back to the HTTP status when there's no error envelope.
  const STATUS_FALLBACK = {
    400: ["invalid_request", "Check the report and neighborhood, then try again."],
    404: ["not_found", "The Worker isn't serving this endpoint."],
    405: ["method_not_allowed", "The Worker didn't accept this request."],
    413: ["payload_too_large", "Remove or replace the photo with a smaller one, then try again."],
    429: ["rate_limited", "Wait a few seconds, then try again."],
    502: ["upstream_error", "Try again in a moment."],
    503: ["unavailable", "The desk is temporarily unavailable. Try again in a moment."],
    504: ["upstream_timeout", "The request took too long. Try again."],
  };

  // label_not_found: the page's label (e.g. experimental) points at no saved Call version yet.
  const CODE_FALLBACK = { label_not_found: "Assign the label to a saved Call version, then try again." };

  function toError(code, message, status) {
    const fallback = STATUS_FALLBACK[status] || ["bad_response", "Try again in a moment."];
    const known = typeof code === "string" && code ? code : fallback[0];
    const title = ERROR_TITLES[known] || (status ? `Request failed (${status})` : "Request failed");
    return { code: status ? `${known} · HTTP ${status}` : known, title, message: message || CODE_FALLBACK[known] || fallback[1] };
  }

  const requestBody = (fields, photo) => (photo ? { ...fields, photo: { image: photo.base64, mediaType: "image/jpeg" } } : fields);
  const optionalString = (value) => (typeof value === "string" && value ? value : undefined);

  // POSTs to the Worker and returns { ok: true, text, ...provenance } or { ok: false, error }. `field` names the
  // response property that carries the model text.
  async function callWorker(path, body, field, controller) {
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let data = null;
      try { data = await res.json(); } catch { /* handled below */ }
      if (res.ok && data && typeof data[field] === "string") {
        return {
          ok: true,
          text: data[field],
          callId: optionalString(data.callId),
          callName: optionalString(data.callName),
          callLabel: optionalString(data.callLabel),
          callVersion: isVersion(data.callVersion) ? data.callVersion : undefined,
          route: optionalString(data.route),
          model: optionalString(data.model),
          photoIncluded: typeof data.photoIncluded === "boolean" ? data.photoIncluded : undefined,
        };
      }
      const e = data && data.error && typeof data.error === "object" ? data.error : {};
      return { ok: false, error: toError(e.code, typeof e.message === "string" ? e.message : "", res.status) };
    } catch (err) {
      return {
        ok: false,
        error: err && err.name === "AbortError"
          ? toError("timeout", "The Worker didn't answer in time. Your report and photo are still here; try again.")
          : toError("network", "Check your connection and try again."),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  const announce = (what, reply) => (reply.ok
    ? `${what} ready${isVersion(reply.callVersion) ? ` from Call version ${reply.callVersion}` : ""}.`
    : `${reply.error.title}. ${reply.error.message}`);

  function setPending(on) {
    if (on) {
      const startedAt = performance.now();
      const timer = setInterval(() => { el.elapsed.textContent = fmtSecs(performance.now() - startedAt); }, 100);
      state.pending = { controller: new AbortController(), startedAt, timer };
      el.elapsed.textContent = "0.0s";
      el.assess.setAttribute("aria-disabled", "true");
      el.assessLabel.textContent = "Assessing…";
      el.live.textContent = "Assessing the request.";
    } else if (state.pending) {
      clearInterval(state.pending.timer);
      state.pending = null;
      el.assess.removeAttribute("aria-disabled");
      el.assessLabel.textContent = "Assess";
    }
  }

  async function submit() {
    if (state.pending || state.photoBusy) return;
    const fields = validate();
    if (!fields) return;
    cancelInsights();

    const photo = state.photo;
    setPending(true);
    render();
    const { controller, startedAt } = state.pending;
    const { text, ...reply } = await callWorker("api/assess", requestBody(fields, photo), "assessment", controller);

    const run = {
      id: `${Date.now().toString(36)}-${state.runs.length}`,
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - startedAt),
      ...reply,
      ...(reply.ok && { assessment: text }),
      input: {
        neighborhood: fields.neighborhood,
        reportChars: fields.report.length,
        fingerprint: inputFingerprint(fields, photo),
        photo: photo ? { width: photo.width, height: photo.height } : null,
      },
    };
    state.runs.push(run);
    if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);
    state.selected = state.runs.length - 1;
    state.compareOpen = false;
    saveRuns();
    setPending(false);
    render();
    el.live.textContent = announce("Assessment", reply);
  }

  // Cheap identity check so the version note only claims "same input" when it was.
  function inputFingerprint(fields, photo) {
    const text = `${fields.neighborhood}\u0000${fields.report}\u0000${photo ? photo.base64 : ""}`;
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${(h >>> 0).toString(36)}`;
  }

  // ---------- config + sample ----------
  async function loadConfig() {
    try {
      const res = await fetch("api/config", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = await res.json();
      const c = state.config;
      c.callName = optionalString(data.callName) || null;
      c.callId = optionalString(data.callId) || null;
      if (Number.isInteger(data.maxPhotoBase64Chars) && data.maxPhotoBase64Chars > 0) c.maxPhotoBase64Chars = data.maxPhotoBase64Chars;
      const ins = data.insights;
      if (ins && typeof ins === "object" && (optionalString(ins.callId) || optionalString(ins.callName))) {
        c.insights = { callId: optionalString(ins.callId) || null, callName: optionalString(ins.callName) || null };
      }
    } catch {
      return;
    }
    if (state.runs.length) render();
  }

  async function loadSample() {
    el.loadSample.disabled = true;
    try {
      const sample = await (await fetch(`${ASSET_BASE}fixtures/demo-request.json`)).json();
      el.neighborhood.value = sample.neighborhood;
      el.report.value = sample.report;
      setFieldError(el.neighborhood, el.neighborhoodError, "");
      setFieldError(el.report, el.reportError, "");
      updateCounters();
      saveDraft();
      if (sample.photo) {
        const img = await fetch(`${ASSET_BASE}${sample.photo}`);
        await attachPhoto(await img.blob(), sample.photo.split("/").pop());
      }
    } catch {
      showPhotoError("Couldn't load the sample request.");
    } finally {
      el.loadSample.disabled = false;
    }
  }

  function clearForm() {
    el.neighborhood.value = "";
    el.report.value = "";
    setFieldError(el.neighborhood, el.neighborhoodError, "");
    setFieldError(el.report, el.reportError, "");
    updateCounters();
    saveDraft();
    removePhoto();
    el.neighborhood.focus();
  }

  // ---------- wiring ----------
  function restore() {
    const draft = store.get(localStorage, DRAFT_KEY);
    if (draft) {
      el.neighborhood.value = typeof draft.neighborhood === "string" ? draft.neighborhood : "";
      el.report.value = typeof draft.report === "string" ? draft.report : "";
    }
    const photo = store.get(localStorage, PHOTO_KEY);
    if (photo && typeof photo.base64 === "string" && /^[A-Za-z0-9+/]+=*$/.test(photo.base64)) state.photo = photo;
    const runs = store.get(sessionStorage, RUNS_KEY);
    if (Array.isArray(runs)) {
      state.runs = runs.filter((r) => r && typeof r.id === "string" && r.input);
      state.selected = state.runs.length - 1;
    }
  }

  // Theme: follows the system until the user picks one; theme.js applies the saved choice before paint.
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light")) === "dark";
  function syncThemeToggle() {
    const dark = isDark();
    el.themeToggle.dataset.dark = String(dark);
    el.themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  }
  el.themeToggle.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* choice lasts for this page only */ }
    syncThemeToggle();
  });
  systemDark.addEventListener("change", syncThemeToggle);
  syncThemeToggle();

  el.assessKbd.textContent = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘↵" : "Ctrl ↵";

  el.form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  el.form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });
  for (const [field, errorEl] of [[el.report, el.reportError], [el.neighborhood, el.neighborhoodError]]) {
    field.addEventListener("input", () => {
      updateCounters();
      saveDraft();
      if (field.getAttribute("aria-invalid")) setFieldError(field, errorEl, "");
      renderInsights(state.runs[state.selected]);
    });
  }

  const choose = () => el.photoInput.click();
  el.photoChoose.addEventListener("click", choose);
  el.photoReplace.addEventListener("click", choose);
  el.photoRemove.addEventListener("click", removePhoto);
  el.photoInput.addEventListener("change", () => {
    const file = el.photoInput.files && el.photoInput.files[0];
    el.photoInput.value = "";
    if (file) attachPhoto(file, file.name);
  });
  el.photoZone.addEventListener("dragover", (e) => { e.preventDefault(); el.photoZone.classList.add("dragging"); });
  el.photoZone.addEventListener("dragleave", () => el.photoZone.classList.remove("dragging"));
  el.photoZone.addEventListener("drop", (e) => {
    e.preventDefault();
    el.photoZone.classList.remove("dragging");
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) attachPhoto(file, file.name);
  });

  el.loadSample.addEventListener("click", loadSample);
  el.clearForm.addEventListener("click", clearForm);
  el.insightsRun.addEventListener("click", requestInsights);
  el.compareToggle.addEventListener("click", () => { state.compareOpen = !state.compareOpen; render(); });
  el.historyList.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest("button[data-index]") : null;
    if (!btn) return;
    state.selected = Number(btn.dataset.index);
    state.compareOpen = false;
    render();
  });

  restore();
  updateCounters();
  renderPhoto();
  render();
  loadConfig();
})();
