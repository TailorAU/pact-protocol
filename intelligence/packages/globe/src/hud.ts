// Top-left HUD: title, LOD tier, connection status, entity count.
// DOM is reserved for HUD + side panel — never for geographic objects.

import type { LodTier } from "./lod.js";

export type ConnectionKind = "live" | "offline" | "connecting";

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Hud {
  private tierEl: HTMLElement;
  private connEl: HTMLElement;
  private countEl: HTMLElement;

  constructor(parent: HTMLElement) {
    const root = el("div", "hud");
    root.appendChild(
      el("div", "hud-title", "PACT.TAILOR — physical-economy intelligence"),
    );
    const row = el("div", "hud-row");
    this.tierEl = el("span", "hud-chip hud-tier", "global");
    this.connEl = el("span", "hud-chip hud-conn is-connecting", "connecting…");
    this.countEl = el("span", "hud-chip hud-count", "0 entities");
    row.appendChild(this.tierEl);
    row.appendChild(this.connEl);
    row.appendChild(this.countEl);
    root.appendChild(row);
    parent.appendChild(root);
  }

  setTier(tier: LodTier): void {
    this.tierEl.textContent = tier;
  }

  setConnection(kind: ConnectionKind, text: string): void {
    this.connEl.textContent = text;
    this.connEl.className = `hud-chip hud-conn is-${kind}`;
  }

  setEntityCount(n: number): void {
    this.countEl.textContent = `${n.toLocaleString()} ${n === 1 ? "entity" : "entities"}`;
  }
}
