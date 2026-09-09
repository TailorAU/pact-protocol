// Silver: normalised Observation envelopes, append-only JSONL, partitioned by feed and
// event date. Corrections are new lines (is_correction: true); nothing is rewritten.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ObservationRecord } from "@pact-tailor/ontology";

export class SilverStore {
  constructor(private readonly root: string) {}

  private feedDir(feedId: string): string {
    return join(this.root, feedId.replaceAll(":", "_"));
  }

  append(observations: ObservationRecord[]): void {
    const byFile = new Map<string, string[]>();
    for (const obs of observations) {
      const day = obs.event_time.slice(0, 10);
      const file = join(this.feedDir(obs.feed_id), `${day}.jsonl`);
      let lines = byFile.get(file);
      if (!lines) byFile.set(file, (lines = []));
      lines.push(JSON.stringify(obs));
    }
    for (const [file, lines] of byFile) {
      mkdirSync(join(file, ".."), { recursive: true });
      appendFileSync(file, lines.join("\n") + "\n");
    }
  }

  readFeed(feedId: string, options: { fromDay?: string; toDay?: string } = {}): ObservationRecord[] {
    const dir = this.feedDir(feedId);
    if (!existsSync(dir)) return [];
    const out: ObservationRecord[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const day = name.slice(0, 10);
      if (options.fromDay && day < options.fromDay) continue;
      if (options.toDay && day > options.toDay) continue;
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (line.trim().length > 0) out.push(JSON.parse(line) as ObservationRecord);
      }
    }
    return out;
  }

  listFeeds(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .sort()
      .map((name) => name.replaceAll("_", ":"));
  }
}
