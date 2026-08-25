export type RangeKey = "24h" | "7d" | "30d" | "90d";

export interface RangeSpec {
  /** SQL interval string for the period length */
  interval: string;
  /** date_trunc unit for bucketing */
  bucket: "hour" | "day";
  /** number of buckets in the period */
  points: number;
}

export const RANGES: Record<RangeKey, RangeSpec> = {
  "24h": { interval: "24 hours", bucket: "hour", points: 24 },
  "7d": { interval: "7 days", bucket: "day", points: 7 },
  "30d": { interval: "30 days", bucket: "day", points: 30 },
  "90d": { interval: "90 days", bucket: "day", points: 90 },
};

export function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}
