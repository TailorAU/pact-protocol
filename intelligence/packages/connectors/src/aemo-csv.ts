// AEMO MMS CSV report format parser (documented in the MMS Data Model report
// specifications). A report is a CSV where the first field of each line is a
// row type:
//
//   C  comment/header rows, including the trailing `C,"END OF REPORT",<count>`
//   I  column-header row:  I,<GROUP>,<TABLE>,<version>,<col1>,<col2>,...
//   D  data row matching the most recent I row for its GROUP/TABLE:
//      D,<GROUP>,<TABLE>,<version>,<val1>,<val2>,...
//
// Fields may be double-quoted (timestamps like "2026/08/12 11:05:00" always
// are); quotes escape embedded commas and doubled quotes ("").

export interface AemoTable {
  /** "GROUP.TABLE", e.g. "DISPATCH.REGIONSUM". */
  table: string;
  rows: Record<string, string>[];
}

/** Split one CSV line, honouring double-quoted fields and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse a full AEMO MMS CSV report into its tables. Repeated I rows for the
 * same GROUP.TABLE merge their D rows into one table (column set follows the
 * most recent I row). D rows arriving before any I row for their table are an
 * error — the format guarantees I precedes D.
 */
export function parseAemoCsv(text: string): AemoTable[] {
  const columnsByTable = new Map<string, string[]>();
  const tables = new Map<string, AemoTable>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const fields = splitCsvLine(line);
    const rowType = fields[0];
    if (rowType === "C") continue; // headers and "END OF REPORT"
    if (rowType !== "I" && rowType !== "D") continue; // unknown row types skipped
    const group = fields[1] ?? "";
    const tableName = fields[2] ?? "";
    const key = `${group}.${tableName}`;
    if (rowType === "I") {
      columnsByTable.set(key, fields.slice(4));
      if (!tables.has(key)) tables.set(key, { table: key, rows: [] });
      continue;
    }
    const columns = columnsByTable.get(key);
    if (columns === undefined) {
      throw new Error(`aemo-csv: D row for ${key} before its I row`);
    }
    const row: Record<string, string> = {};
    const values = fields.slice(4);
    columns.forEach((col, i) => {
      row[col] = values[i] ?? "";
    });
    tables.get(key)?.rows.push(row);
  }
  return [...tables.values()];
}

// ---------------------------------------------------------------------------
// NEM time
// ---------------------------------------------------------------------------

// AEMO NEM market time is Australian Eastern Standard Time, fixed UTC+10 with
// NO daylight saving — so the conversion is a constant 10-hour subtraction.
const NEM_UTC_OFFSET_MS = 10 * 3600 * 1000;

const NEM_TIME_RE = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * Convert a NEM timestamp ("2026/08/12 14:05:00", also the dashboard's
 * "2026-08-12T14:05:00" variant) to ISO-8601 UTC by subtracting 10 hours.
 */
export function nemTimeToIso(nemTime: string): string {
  const m = NEM_TIME_RE.exec(nemTime.trim());
  if (!m) throw new Error(`aemo-csv: unrecognised NEM timestamp "${nemTime}"`);
  const [, y, mo, d, h, mi, s] = m;
  const utcMs =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - NEM_UTC_OFFSET_MS;
  return new Date(utcMs).toISOString().replace(".000Z", "Z");
}
