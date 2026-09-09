// Canonical metric vocabulary. Observations may carry unknown metrics
// (the schema only enforces the dotted-lowercase grammar); unknown metrics
// should be flagged by tooling via isKnownMetric().

export interface MetricSpec {
  /** Canonical unit, or "object" for structured values, or null for dimensionless. */
  unit: string | null;
  description: string;
}

export const METRICS = {
  "power.output.mw": {
    unit: "MW",
    description: "Instantaneous electrical output of a generator/unit",
  },
  "power.load.mw": {
    unit: "MW",
    description: "Metered electrical load of a facility",
  },
  "power.load.estimated_mw": {
    unit: "MW",
    description: "Estimated (not metered) electrical load of a facility",
  },
  "power.capacity_factor": {
    unit: null,
    description: "Output / nameplate capacity, dimensionless 0..1",
  },
  "market.price.energy": {
    unit: "AUD/MWh",
    description: "Spot/dispatch energy price",
  },
  "grid.demand.mw": {
    unit: "MW",
    description: "Total grid or region demand",
  },
  "grid.frequency.hz": {
    unit: "Hz",
    description: "System frequency",
  },
  "grid.generation.mw": {
    unit: "MW",
    description: "Total grid or region generation",
  },
  "grid.generation.fuel_mix": {
    unit: "object",
    description: "Generation by fuel, object keyed by fuel with MW values",
  },
  "intercon.flow.mw": {
    unit: "MW",
    description: "Interconnector flow, signed (positive = forward direction)",
  },
  "storage.level.pct": {
    unit: "%",
    description: "Storage level as percentage of usable capacity",
  },
  "storage.flow.mw": {
    unit: "MW",
    description: "Storage charge/discharge rate, signed",
  },
  "vessel.position": {
    unit: "object",
    description: "Vessel position object {lat, lon, speed_kn, heading_deg, draught_m?}",
  },
  "vessel.speed.kn": {
    unit: "kn",
    description: "Vessel speed over ground",
  },
  "vessel.heading.deg": {
    unit: "deg",
    description: "Vessel heading, degrees true",
  },
  "vessel.draught.m": {
    unit: "m",
    description: "Vessel reported draught",
  },
  "weather.temp.c": {
    unit: "degC",
    description: "Air temperature",
  },
  "weather.wind.speed_ms": {
    unit: "m/s",
    description: "Wind speed",
  },
  "gas.pipeline.flow.tj_day": {
    unit: "TJ/day",
    description: "Gas pipeline flow rate",
  },
  "production.rate.tph": {
    unit: "t/h",
    description: "Industrial production rate, tonnes per hour",
  },
} as const satisfies Record<string, MetricSpec>;

export type KnownMetric = keyof typeof METRICS;

/** Grammar every metric name must satisfy (known or not). */
export const METRIC_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** True if the metric is part of the canonical vocabulary. */
export function isKnownMetric(metric: string): metric is KnownMetric {
  return Object.prototype.hasOwnProperty.call(METRICS, metric);
}

/** True if the metric name satisfies the metric grammar (canonical or not). */
export function isValidMetricName(metric: string): boolean {
  return METRIC_RE.test(metric);
}
