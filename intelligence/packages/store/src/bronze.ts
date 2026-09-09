// Bronze: verbatim fetched bytes + fetch metadata. Immutable — a changed re-fetch is a
// new artifact (content-addressed suffix), never an overwrite.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface BronzeMeta {
  artifact_id: string;
  source_id: string;
  url: string;
  fetched_at: string;
  sha256: string;
  http_status: number;
  content_type?: string;
  bytes: number;
}

export interface BronzePut {
  source_id: string;
  url: string;
  fetched_at: string;
  http_status: number;
  content_type?: string;
  body: Buffer;
}

export class BronzeStore {
  constructor(private readonly root: string) {}

  private dirFor(sourceId: string, fetchedAt: string): string {
    const day = fetchedAt.slice(0, 10);
    const [yyyy = "0000", mm = "00", dd = "00"] = day.split("-");
    return join(this.root, sourceId.replaceAll(":", "_"), yyyy, mm, dd);
  }

  put(input: BronzePut): BronzeMeta {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    const stamp = input.fetched_at.replace(/[:.]/g, "-");
    const artifactId = `${stamp}-${sha256.slice(0, 12)}`;
    const dir = this.dirFor(input.source_id, input.fetched_at);
    mkdirSync(dir, { recursive: true });
    const binPath = join(dir, `${artifactId}.bin`);
    const meta: BronzeMeta = {
      artifact_id: artifactId,
      source_id: input.source_id,
      url: input.url,
      fetched_at: input.fetched_at,
      sha256,
      http_status: input.http_status,
      ...(input.content_type !== undefined ? { content_type: input.content_type } : {}),
      bytes: input.body.length,
    };
    if (!existsSync(binPath)) {
      writeFileSync(binPath, input.body);
      writeFileSync(join(dir, `${artifactId}.meta.json`), JSON.stringify(meta, null, 2));
    }
    return meta;
  }

  get(sourceId: string, artifactId: string): { meta: BronzeMeta; body: Buffer } | null {
    // Artifact IDs embed their fetch timestamp, which locates the directory.
    const fetchedAt = artifactId.slice(0, 10);
    const dir = this.dirFor(sourceId, fetchedAt);
    const binPath = join(dir, `${artifactId}.bin`);
    if (!existsSync(binPath)) return null;
    const meta = JSON.parse(readFileSync(join(dir, `${artifactId}.meta.json`), "utf8")) as BronzeMeta;
    return { meta, body: readFileSync(binPath) };
  }

  list(sourceId: string): BronzeMeta[] {
    const base = join(this.root, sourceId.replaceAll(":", "_"));
    const out: BronzeMeta[] = [];
    const walk = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (name.endsWith("/")) walk(join(dir, name.slice(0, -1)));
        else if (name.endsWith(".meta.json")) {
          out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as BronzeMeta);
        }
      }
    };
    walk(base);
    return out;
  }
}
