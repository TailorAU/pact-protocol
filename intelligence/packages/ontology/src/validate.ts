// Runtime schema validation: loads the JSON Schemas from intelligence/schemas/
// into a single Ajv 2020-12 instance and exposes typed validators per envelope.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
// Node16 ESM<->CJS interop: the callable plugin lives on .default at runtime
// (ajv-formats sets `exports.default = formatsPlugin`) and in the CJS typings.
import addFormatsModule from "ajv-formats";
const addFormats = addFormatsModule.default;
import type {
  EntityRecord,
  GridRecord,
  InferenceRecord,
  ObservabilityGapRecord,
  ObservationRecord,
  RelationshipRecord,
  SduiPanelDoc,
  SourceRecord,
  TelemetryFeedRecord,
} from "./types.js";

export const SCHEMA_BASE = "https://pact.tailor.au/intelligence/schemas/";

/**
 * Default location of the schema JSON files.
 * Compiled output lives at intelligence/packages/ontology/dist/validate.js,
 * so ../../../schemas resolves to intelligence/schemas.
 */
export function defaultSchemasDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../schemas");
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export type Validate<T> = (input: unknown) => ValidationResult<T>;

export interface Validators {
  entity: Validate<EntityRecord>;
  relationship: Validate<RelationshipRecord>;
  observation: Validate<ObservationRecord>;
  source: Validate<SourceRecord>;
  gap: Validate<ObservabilityGapRecord>;
  inference: Validate<InferenceRecord>;
  grid: Validate<GridRecord>;
  feed: Validate<TelemetryFeedRecord>;
  sduiPanel: Validate<SduiPanelDoc>;
  /** The underlying Ajv instance (all schemas registered by $id). */
  ajv: Ajv2020;
}

function loadSchemaFiles(dir: string): AnySchemaObject[] {
  const schemas: AnySchemaObject[] = [];
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".schema.json")) {
      schemas.push(JSON.parse(readFileSync(path.join(dir, file), "utf8")) as AnySchemaObject);
    }
  }
  const subDir = path.join(dir, "entity-types");
  for (const file of readdirSync(subDir)) {
    if (file.endsWith(".json")) {
      schemas.push(JSON.parse(readFileSync(path.join(subDir, file), "utf8")) as AnySchemaObject);
    }
  }
  return schemas;
}

function formatErrors(errors: ErrorObject[]): string[] {
  return errors.map((e) => {
    const where = e.instancePath === "" ? "(root)" : e.instancePath;
    const params = e.params as Record<string, unknown>;
    let detail = "";
    if (e.keyword === "additionalProperties" && typeof params["additionalProperty"] === "string") {
      detail = ` ("${String(params["additionalProperty"])}")`;
    } else if (e.keyword === "enum" && params["allowedValues"] !== undefined) {
      detail = `: ${JSON.stringify(params["allowedValues"])}`;
    }
    return `${where} ${e.message ?? "is invalid"}${detail} [${e.schemaPath}]`;
  });
}

/**
 * Load every schema from the schemas directory, compile them in one
 * Ajv 2020-12 instance, and return typed per-envelope validators.
 * Throws if any schema fails to compile or has unresolved $refs.
 */
export function createValidators(schemasDir: string = defaultSchemasDir()): Validators {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  for (const schema of loadSchemaFiles(schemasDir)) {
    ajv.addSchema(schema);
  }

  const compiled = (name: string): ValidateFunction => {
    // getSchema compiles on first access; unresolved $refs throw here.
    const fn = ajv.getSchema(`${SCHEMA_BASE}${name}`);
    if (fn === undefined) {
      throw new Error(`ontology: schema not registered: ${name}`);
    }
    return fn;
  };

  const wrap = <T>(fn: ValidateFunction): Validate<T> => {
    return (input: unknown): ValidationResult<T> => {
      if (fn(input)) {
        return { ok: true, value: input as T };
      }
      return { ok: false, errors: formatErrors(fn.errors ?? []) };
    };
  };

  return {
    entity: wrap<EntityRecord>(compiled("entity.schema.json")),
    relationship: wrap<RelationshipRecord>(compiled("relationship.schema.json")),
    observation: wrap<ObservationRecord>(compiled("observation.schema.json")),
    source: wrap<SourceRecord>(compiled("source.schema.json")),
    gap: wrap<ObservabilityGapRecord>(compiled("observability-gap.schema.json")),
    inference: wrap<InferenceRecord>(compiled("inference.schema.json")),
    grid: wrap<GridRecord>(compiled("grid.schema.json")),
    feed: wrap<TelemetryFeedRecord>(compiled("telemetry-feed.schema.json")),
    sduiPanel: wrap<SduiPanelDoc>(compiled("sdui-panel.schema.json")),
    ajv,
  };
}
