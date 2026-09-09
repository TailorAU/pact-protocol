// SDUI side panel — plain TS + CSS, no framework.
//
// On entity click we fetch /api/intel/sdui/{id} and render the server-composed
// layout. SDUI rule: every panel fetches its own data.endpoint — panels never
// receive inline values. Honesty rule: whenever data is present, a "replayed
// fixture data — not live" banner is shown (the API replays fixtures here).

import { api, apiStatus } from "./api.js";
import type {
  EntityRecord,
  EntityStateResponse,
  InferenceRecord,
  ObservabilityGapRecord,
  SduiPanel,
  SduiPanelDoc,
  StateEntry,
} from "./types.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function el(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Liberal array extraction: bare array, or first array under known keys. */
function asArray(json: unknown, keys: string[]): unknown[] {
  if (Array.isArray(json)) return json;
  const rec = asRecord(json);
  if (!rec) return [];
  for (const k of keys) {
    const v = rec[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function fmtValue(v: unknown): string {
  if (typeof v === "number") {
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (abs >= 10) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof v === "string") return v;
  const rec = asRecord(v);
  if (rec && typeof rec.lat === "number" && typeof rec.lon === "number") {
    return `${rec.lat.toFixed(3)}, ${rec.lon.toFixed(3)}`;
  }
  return v === null || v === undefined ? "—" : JSON.stringify(v);
}

function fmtTime(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export class SidePanel {
  private root: HTMLElement;
  private banner: HTMLElement;
  private header: HTMLElement;
  private body: HTMLElement;
  private openToken = 0;

  constructor(parent: HTMLElement) {
    this.root = el("aside", "panel panel-hidden");
    const bar = el("div", "panel-bar");
    const close = el("button", "panel-close", "×");
    close.setAttribute("aria-label", "Close panel");
    close.addEventListener("click", () => this.close());
    bar.appendChild(close);
    this.banner = el("div", "panel-banner", "replayed fixture data — not live");
    this.banner.hidden = true;
    this.header = el("div", "panel-header");
    this.body = el("div", "panel-body");
    this.root.appendChild(bar);
    this.root.appendChild(this.banner);
    this.root.appendChild(this.header);
    this.root.appendChild(this.body);
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.classList.contains("panel-hidden");
  }

  close(): void {
    this.openToken += 1;
    this.root.classList.add("panel-hidden");
  }

  async open(entityId: string, entity?: EntityRecord): Promise<void> {
    const token = ++this.openToken;
    this.root.classList.remove("panel-hidden");
    this.banner.hidden = true;
    this.header.replaceChildren();
    this.body.replaceChildren(el("div", "panel-loading", "composing panel…"));

    const doc = await api.getSdui(entityId);
    if (token !== this.openToken) return; // superseded by a newer open/close

    this.renderHeader(entityId, entity, doc);
    this.body.replaceChildren();

    if (!doc) {
      const msg = apiStatus.down
        ? "API offline — structural view only. No SDUI document available."
        : "No SDUI document for this entity.";
      this.body.appendChild(el("div", "panel-empty", msg));
      return;
    }

    for (const panel of doc.layout) {
      const section = el("section", `panel-section panel-kind-${panel.panel}`);
      section.appendChild(el("h3", "panel-section-title", titleFor(panel)));
      this.body.appendChild(section);
      void this.fillSection(token, section, panel, doc);
    }

    this.renderSplatMount(entity);
  }

  // -- header ---------------------------------------------------------------

  private renderHeader(
    entityId: string,
    entity: EntityRecord | undefined,
    doc: SduiPanelDoc | null,
  ): void {
    this.header.replaceChildren();
    this.header.appendChild(
      el("h2", "panel-name", entity?.name ?? doc?.entity_id ?? entityId),
    );
    const meta = el("div", "panel-meta");
    const type = doc?.entity_type ?? entity?.entity_type;
    if (type) meta.appendChild(el("span", "chip chip-type", type));
    if (entity?.observability) {
      meta.appendChild(
        el(
          "span",
          `chip chip-obs obs-${entity.observability.toLowerCase()}`,
          entity.observability,
        ),
      );
    }
    for (const s of doc?.situation ?? []) {
      meta.appendChild(el("span", "chip chip-situation", s));
    }
    this.header.appendChild(meta);
    this.header.appendChild(el("div", "panel-id", entityId));
  }

  // -- section data ---------------------------------------------------------

  private async fillSection(
    token: number,
    section: HTMLElement,
    panel: SduiPanel,
    doc: SduiPanelDoc,
  ): Promise<void> {
    const endpoint = panel.data?.endpoint;
    const bodyEl = el("div", "panel-section-body");
    section.appendChild(bodyEl);

    if (!endpoint) {
      // SDUI rule: no endpoint, no data — we never render inline values.
      bodyEl.appendChild(
        el("div", "panel-empty", "no data endpoint declared"),
      );
      return;
    }

    bodyEl.appendChild(el("div", "panel-loading", "fetching…"));
    const json = await api.fetchEndpoint<unknown>(endpoint);
    if (token !== this.openToken) return;
    bodyEl.replaceChildren();

    if (json === null) {
      bodyEl.appendChild(
        el(
          "div",
          "panel-empty",
          apiStatus.down ? "API offline" : "no data from endpoint",
        ),
      );
      return;
    }

    this.banner.hidden = false; // data present → honesty banner on

    switch (panel.panel) {
      case "headline-state":
        renderHeadlineState(bodyEl, json);
        break;
      case "timeseries":
        renderTimeseries(bodyEl, json, panel);
        break;
      case "gap-card":
        renderGapCard(bodyEl, json);
        break;
      case "graph-neighborhood":
        renderGraphNeighborhood(bodyEl, json, doc.entity_id);
        break;
      case "inference-list":
        renderInferenceList(bodyEl, json);
        break;
      default:
        bodyEl.appendChild(
          el("div", "panel-empty", `unsupported panel type: ${panel.panel}`),
        );
    }
  }

  /** 3DGS mount contract: properties.visualisation.splat_url, when present. */
  private renderSplatMount(entity: EntityRecord | undefined): void {
    const vis = asRecord(entity?.properties?.["visualisation"]);
    const splatUrl = vis?.["splat_url"];
    if (typeof splatUrl !== "string" || !splatUrl) return;
    const section = el("section", "panel-section panel-kind-splat");
    section.appendChild(el("h3", "panel-section-title", "site view"));
    section.appendChild(
      el(
        "div",
        "panel-empty",
        "3D Gaussian Splatting site view reserved (out of scope in this workspace)",
      ),
    );
    this.body.appendChild(section);
  }
}

// ---------------------------------------------------------------------------
// Panel renderers
// ---------------------------------------------------------------------------

function titleFor(panel: SduiPanel): string {
  const names: Record<string, string> = {
    "headline-state": "live state",
    timeseries: "timeseries",
    "gap-card": "observability gaps",
    "graph-neighborhood": "neighborhood",
    "inference-list": "inferences",
  };
  return names[panel.panel] ?? panel.panel;
}

function renderHeadlineState(parent: HTMLElement, json: unknown): void {
  const states = asArray(json, ["states"]) as StateEntry[];
  if (states.length === 0) {
    parent.appendChild(el("div", "panel-empty", "no live state"));
    return;
  }
  const grid = el("div", "headline-grid");
  for (const s of states) {
    if (!asRecord(s)) continue;
    const card = el("div", "headline-card");
    const value = el("div", "headline-value", fmtValue(s.value));
    if (s.unit) value.appendChild(el("span", "headline-unit", ` ${s.unit}`));
    card.appendChild(value);
    card.appendChild(el("div", "headline-metric", s.metric ?? ""));
    const foot = el("div", "headline-foot", fmtTime(s.event_time));
    if (s.quality && s.quality !== "good") {
      foot.appendChild(el("span", `chip chip-quality q-${s.quality}`, s.quality));
    }
    card.appendChild(foot);
    grid.appendChild(card);
  }
  parent.appendChild(grid);
}

function renderTimeseries(
  parent: HTMLElement,
  json: unknown,
  panel: SduiPanel,
): void {
  const rows = asArray(json, ["observations", "states", "items", "data"]);
  const points: Array<{ t: number; v: number }> = [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    const v = rec["value"];
    const t = Date.parse(String(rec["event_time"] ?? ""));
    if (typeof v === "number" && Number.isFinite(v) && !Number.isNaN(t)) {
      points.push({ t, v });
    }
  }
  points.sort((a, b) => a.t - b.t);

  const metric = typeof panel.props?.["metric"] === "string" ? String(panel.props["metric"]) : "";
  const windowLabel = typeof panel.props?.["window"] === "string" ? String(panel.props["window"]) : "";
  if (metric || windowLabel) {
    parent.appendChild(
      el("div", "ts-caption", [metric, windowLabel].filter(Boolean).join(" · ")),
    );
  }

  if (points.length < 2) {
    parent.appendChild(el("div", "panel-empty", "not enough observations"));
    return;
  }

  const W = 264;
  const H = 64;
  const PAD = 4;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  const span = max - min || 1;
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? 1;
  const tSpan = t1 - t0 || 1;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "sparkline");
  const poly = document.createElementNS(SVG_NS, "polyline");
  poly.setAttribute(
    "points",
    points
      .map((p) => {
        const x = PAD + ((p.t - t0) / tSpan) * (W - PAD * 2);
        const y = H - PAD - ((p.v - min) / span) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" "),
  );
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "currentColor");
  poly.setAttribute("stroke-width", "1.5");
  svg.appendChild(poly);
  parent.appendChild(svg);

  const last = points[points.length - 1];
  parent.appendChild(
    el(
      "div",
      "ts-range",
      `min ${fmtValue(min)} · max ${fmtValue(max)} · latest ${fmtValue(last?.v)}`,
    ),
  );
}

function renderGapCard(parent: HTMLElement, json: unknown): void {
  const gaps = asArray(json, ["gaps"]) as ObservabilityGapRecord[];
  if (gaps.length === 0) {
    parent.appendChild(el("div", "panel-empty", "no open gaps"));
    return;
  }
  for (const gap of gaps) {
    if (!asRecord(gap)) continue;
    const card = el("div", "gap-card");
    const head = el("div", "gap-head");
    head.appendChild(el("span", `chip chip-priority p-${(gap.priority ?? "P4").toLowerCase()}`, gap.priority ?? "P?"));
    head.appendChild(el("span", "gap-metric", gap.desired_metric ?? ""));
    head.appendChild(el("span", "chip chip-status", gap.status ?? ""));
    card.appendChild(head);
    const vals = el("div", "gap-values");
    if (gap.commercial_value) vals.appendChild(el("span", "gap-val", `commercial: ${gap.commercial_value}`));
    if (gap.strategic_value) vals.appendChild(el("span", "gap-val", `strategic: ${gap.strategic_value}`));
    card.appendChild(vals);
    const opts = gap.instrumentation_options ?? [];
    if (opts.length > 0) {
      const list = el("ul", "gap-options");
      for (const opt of opts) {
        const item = el("li", "gap-option", opt.kind);
        if (opt.indicative_cost_band) {
          item.appendChild(el("span", "gap-cost", ` · cost ${opt.indicative_cost_band}`));
        }
        if (opt.notes) item.appendChild(el("span", "gap-note", ` — ${opt.notes}`));
        list.appendChild(item);
      }
      card.appendChild(list);
    }
    if (gap.best_available_proxy) {
      card.appendChild(
        el(
          "div",
          "gap-proxy",
          `proxy: ${gap.best_available_proxy.metric} (${gap.best_available_proxy.source_id})`,
        ),
      );
    }
    parent.appendChild(card);
  }
}

function nameOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  const rec = asRecord(v);
  if (!rec) return null;
  if (typeof rec["name"] === "string") return rec["name"];
  if (typeof rec["entity_id"] === "string") return rec["entity_id"];
  return null;
}

function renderNameList(parent: HTMLElement, label: string, items: string[]): void {
  if (items.length === 0) return;
  parent.appendChild(el("h4", "graph-label", label));
  const list = el("ul", "graph-list");
  for (const name of items) list.appendChild(el("li", "graph-item", name));
  parent.appendChild(list);
}

function renderGraphNeighborhood(
  parent: HTMLElement,
  json: unknown,
  entityId: string,
): void {
  const rec = asRecord(json) ?? {};

  // Shape 1: explicit upstream/downstream lists
  const upstream = asArray(rec["upstream"], []).map(nameOf).filter((n): n is string => n !== null);
  const downstream = asArray(rec["downstream"], []).map(nameOf).filter((n): n is string => n !== null);
  if (upstream.length > 0 || downstream.length > 0) {
    renderNameList(parent, "upstream", upstream);
    renderNameList(parent, "downstream", downstream);
    return;
  }

  // Shape 2: nodes + edges/relationships — derive direction relative to entity
  const nodes = asArray(rec["nodes"], []) as Array<Record<string, unknown>>;
  const edges = asArray(rec["edges"] ?? rec["relationships"], []) as Array<Record<string, unknown>>;
  if (nodes.length > 0 && edges.length > 0) {
    const nameById = new Map<string, string>();
    for (const n of nodes) {
      const id = typeof n["entity_id"] === "string" ? n["entity_id"] : null;
      if (id) nameById.set(id, typeof n["name"] === "string" ? n["name"] : id);
    }
    const up: string[] = [];
    const down: string[] = [];
    for (const e of edges) {
      const from = typeof e["from_id"] === "string" ? e["from_id"] : null;
      const to = typeof e["to_id"] === "string" ? e["to_id"] : null;
      if (to === entityId && from) up.push(nameById.get(from) ?? from);
      else if (from === entityId && to) down.push(nameById.get(to) ?? to);
    }
    renderNameList(parent, "upstream", up);
    renderNameList(parent, "downstream", down);
    if (up.length === 0 && down.length === 0) {
      renderNameList(parent, "neighbors", [...nameById.values()].filter((n) => n !== entityId));
    }
    return;
  }

  // Shape 3: flat neighbor list
  const neighbors = asArray(json, ["neighbors", "entities"]).map(nameOf).filter((n): n is string => n !== null);
  if (neighbors.length > 0) {
    renderNameList(parent, "neighbors", neighbors);
    return;
  }
  parent.appendChild(el("div", "panel-empty", "no neighborhood data"));
}

function renderInferenceList(parent: HTMLElement, json: unknown): void {
  const inferences = asArray(json, ["inferences", "items"]) as InferenceRecord[];
  if (inferences.length === 0) {
    parent.appendChild(el("div", "panel-empty", "no inferences"));
    return;
  }
  for (const inf of inferences) {
    if (!asRecord(inf)) continue;
    const status = inf.status ?? "INFERRED";
    const card = el("div", `inference-card status-${status.toLowerCase()}`);
    const head = el("div", "inference-head");
    head.appendChild(el("span", `chip chip-inf-status s-${status.toLowerCase()}`, status));
    if (inf.tier) head.appendChild(el("span", "chip chip-tier", `tier ${inf.tier}`));
    card.appendChild(head);
    card.appendChild(el("div", "inference-claim", inf.claim ?? ""));

    const conf = typeof inf.confidence === "number" ? Math.max(0, Math.min(1, inf.confidence)) : null;
    if (conf !== null) {
      const bar = el("div", "confidence-bar");
      const fill = el("div", "confidence-fill");
      fill.style.width = `${Math.round(conf * 100)}%`;
      bar.appendChild(fill);
      const wrap = el("div", "confidence-wrap");
      wrap.appendChild(bar);
      wrap.appendChild(el("span", "confidence-label", `${Math.round(conf * 100)}%`));
      card.appendChild(wrap);
    }
    if (inf.method) card.appendChild(el("div", "inference-method", inf.method));

    const contrary = inf.contrary_evidence ?? [];
    if (contrary.length > 0) {
      // Honesty rule: contrary evidence is visibly marked, never buried.
      const block = el("div", "contrary-evidence");
      block.appendChild(
        el("div", "contrary-title", `⚠ contrary evidence (${contrary.length})`),
      );
      const list = el("ul", "contrary-list");
      for (const ev of contrary) {
        list.appendChild(el("li", "contrary-item", `${ev.kind}: ${ev.ref}`));
      }
      block.appendChild(list);
      card.appendChild(block);
    }
    parent.appendChild(card);
  }
}
