// Shared NEMWEB behaviour (documented file-drop layout at
// https://nemweb.com.au/Reports/Current/...): each report directory is an
// IIS-style HTML listing of ZIP files named
// PUBLIC_<REPORT>_<yyyymmddhhmm>_<sequence>.zip, each ZIP containing a single
// AEMO MMS CSV report. The timestamp in the filename sorts lexicographically,
// so "newest" is the max filename.

import type { ArtifactRef, ConnectorCtx, ParsedRecord, RawArtifact } from "../sdk.js";
import { parseAemoCsv } from "../aemo-csv.js";
import { unzipFirst } from "../zip.js";

/** Discover the newest report ZIP in a NEMWEB Current directory listing. */
export function makeNemwebDiscover(baseUrl: string, filenameRe: RegExp): (ctx: ConnectorCtx) => Promise<ArtifactRef[]> {
  return async (ctx: ConnectorCtx): Promise<ArtifactRef[]> => {
    const res = await ctx.gate.get(baseUrl);
    if (res.status !== 200) {
      throw new Error(`nemweb: directory listing ${baseUrl} returned HTTP ${res.status}`);
    }
    const html = res.body.toString("utf8");
    const names = new Set<string>();
    const re = new RegExp(filenameRe.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) names.add(m[0]);
    const sorted = [...names].sort();
    const newest = sorted[sorted.length - 1];
    if (newest === undefined) return [];
    return [{ url: baseUrl + newest, name: newest }];
  };
}

/** Fetch a NEMWEB ZIP artifact verbatim. */
export async function nemwebFetch(ref: ArtifactRef, ctx: ConnectorCtx): Promise<RawArtifact> {
  const res = await ctx.gate.get(ref.url);
  if (res.status !== 200) {
    throw new Error(`nemweb: GET ${ref.url} returned HTTP ${res.status}`);
  }
  return {
    ref,
    body: res.body,
    fetched_at: ctx.now(),
    http_status: res.status,
    ...(res.content_type !== undefined ? { content_type: res.content_type } : {}),
  };
}

/** Unzip the single CSV report and flatten its MMS tables into ParsedRecords. */
export async function nemwebParseZip(raw: RawArtifact): Promise<ParsedRecord[]> {
  const entry = unzipFirst(raw.body);
  const tables = parseAemoCsv(entry.data.toString("utf8"));
  const records: ParsedRecord[] = [];
  for (const table of tables) {
    for (const row of table.rows) records.push({ table: table.table, row });
  }
  return records;
}

/**
 * Correction detection (documented simplification): AEMO re-runs a dispatch
 * interval by publishing further rows for the same SETTLEMENTDATE with a
 * higher RUNNO, and intervention runs carry INTERVENTION=1. WITHIN one batch
 * we mark a row as a correction when its INTERVENTION flag is non-zero or a
 * lower RUNNO for the same (table, entity, SETTLEMENTDATE) key was already
 * seen. Cross-batch correction detection (against silver history) is
 * deliberately out of scope here — the state engine reconciles batches by
 * `source_sequence` (= "SETTLEMENTDATE:RUNNO").
 */
export class CorrectionTracker {
  private readonly firstRunno = new Map<string, number>();

  isCorrection(key: string, runno: number, intervention: number): boolean {
    const first = this.firstRunno.get(key);
    if (first === undefined) this.firstRunno.set(key, runno);
    if (intervention > 0) return true;
    return first !== undefined && runno > first;
  }
}
