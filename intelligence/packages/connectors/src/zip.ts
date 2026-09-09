// NEMWEB artifacts are standard ZIP files containing a single CSV report.
// fflate's unzipSync does the work; we return the first real (non-directory)
// entry.

import { unzipSync } from "fflate";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Unzip and return the first non-directory entry. Throws on an empty archive. */
export function unzipFirst(buf: Buffer): ZipEntry {
  const entries = unzipSync(new Uint8Array(buf));
  for (const name of Object.keys(entries)) {
    if (name.endsWith("/")) continue; // directory marker
    const data = entries[name];
    if (data === undefined) continue;
    return { name, data: Buffer.from(data) };
  }
  throw new Error("zip: archive contains no file entries");
}
