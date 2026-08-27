import { Link } from "wouter";
import { ChevronRight, Database, Download } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Shared pieces for the migrated marketing dashboards. */

export const ALL = "__all__";

export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export const TARGETS = [
  { value: "proforma", label: "Proforma" },
  { value: "business_plan", label: "Business Plan" },
  { value: "goal", label: "Goal" },
  { value: "waterfall", label: "Waterfall" },
] as const;

export type TargetValue = (typeof TARGETS)[number]["value"];

export function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return "–";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return "–";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

/** PTG traffic-light: on-track, slipping, at-risk */
export function ptgColor(ptg: number | null | undefined): string {
  if (ptg == null) return "text-muted-foreground";
  if (ptg >= -2) return "text-emerald-600 dark:text-emerald-400";
  if (ptg >= -15) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function ptgBg(ptg: number | null | undefined): string {
  if (ptg == null) return "";
  if (ptg >= -2) return "bg-emerald-500/10";
  if (ptg >= -15) return "bg-amber-500/10";
  return "bg-red-500/10";
}

export function LiveStatusBadge({
  status,
  checking,
  lastRefreshed,
}: {
  status: { connected: boolean; database?: string; error?: string } | undefined;
  checking: boolean;
  lastRefreshed: number;
}) {
  const time =
    lastRefreshed > 0
      ? new Date(lastRefreshed).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;
  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 text-xs"
      data-testid="badge-data-source"
    >
      {checking && !status ? (
        <span className="text-muted-foreground">Checking data source…</span>
      ) : status?.connected ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span className="font-medium text-emerald-700 dark:text-emerald-400">
            Live · Snowflake
          </span>
          <Database className="h-3 w-3 text-muted-foreground" />
          {time && <span className="text-muted-foreground">refreshed {time}</span>}
        </>
      ) : (
        <>
          <span className="h-2 w-2 rounded-full bg-red-500" />
          <span className="font-medium text-red-600 dark:text-red-400">
            Snowflake connection unavailable
          </span>
        </>
      )}
    </div>
  );
}

export function Breadcrumb({ page }: { page: string }) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Link
        href="/workspaces/marketing"
        className="hover:text-foreground transition-colors"
      >
        Marketing Dashboards
      </Link>
      <ChevronRight className="h-3.5 w-3.5" />
      <span className="text-foreground font-medium">{page}</span>
    </nav>
  );
}

export function TargetToggle({
  target,
  onChange,
}: {
  target: TargetValue;
  onChange: (t: TargetValue) => void;
}) {
  return (
    <div className="flex rounded-lg border p-0.5 bg-muted/40">
      {TARGETS.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          data-testid={`button-target-${t.value}`}
          className={cn(
            "px-3 py-1.5 text-sm rounded-md transition-colors",
            target === t.value
              ? "bg-background shadow font-semibold"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  testId: string;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Small icon button that sits in a card header's top-right corner and
 * downloads the card's underlying data as CSV. Every instance gets a stable
 * test id (`button-download-<slug>`) so audits/e2e can find it.
 */
export function DownloadDataButton({
  slug,
  onDownload,
  label = "Download CSV",
  className,
}: {
  /** Stable kebab-case identifier; becomes data-testid `button-download-<slug>`. */
  slug: string;
  onDownload: () => void;
  /** Tooltip / accessible label. */
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onDownload}
      title={label}
      aria-label={label}
      data-testid={`button-download-${slug}`}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      <Download className="h-3.5 w-3.5" />
    </button>
  );
}
/**
 * Gentle inline hint shown under the date inputs while the typed end date is
 * before the start date. The dashboards keep the last valid range applied
 * (see useCommittedDateRange) instead of querying the impossible range.
 */
export function InvertedRangeHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p
      className="mt-2 text-xs text-amber-600 dark:text-amber-500"
      data-testid="hint-inverted-date-range"
    >
      End date is before the start date — still showing the last valid range.
    </p>
  );
}

/**
 * Gentle inline hint shown under the date inputs while the typed range spans
 * two calendar years — a range the API rejects because goals are issued per
 * fiscal year. The dashboards keep the last valid range applied (see
 * useCommittedDateRange) instead of surfacing the error banner.
 */
export function CrossYearRangeHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p
      className="mt-2 text-xs text-amber-600 dark:text-amber-500"
      data-testid="hint-cross-year-date-range"
    >
      Date ranges are limited to a single calendar year because goals are set
      per year — still showing the last valid range.
    </p>
  );
}
