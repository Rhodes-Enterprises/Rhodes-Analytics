import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";
import { useGetCommunities, useGetSnowflakeStatus } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Breadcrumb, LiveStatusBadge, fmt } from "@/components/dashboard-shared";

type SortKey = "development" | "division" | "leadsYtd" | "toursYtd" | "salesYtd";
type SortDir = "asc" | "desc";

const NUMERIC_KEYS = new Set<SortKey>(["leadsYtd", "toursYtd", "salesYtd"]);

function SortHeader({
  label,
  colKey,
  sortKey,
  sortDir,
  onSort,
  align = "left",
  last = false,
}: {
  label: string;
  colKey: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  last?: boolean;
}) {
  const active = sortKey === colKey;
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <th
      className={`py-2 ${last ? "" : "pr-4"} ${align === "right" ? "text-right" : ""}`}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(colKey)}
        data-testid={`button-sort-${colKey}`}
        className={`inline-flex items-center gap-1 hover:text-foreground ${
          active ? "text-foreground font-medium" : ""
        } ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {label}
        <Icon className="h-3 w-3 shrink-0" />
      </button>
    </th>
  );
}

export default function CommunityListPage() {
  const [search, setSearch] = useState("");
  const [onlyWithGoals, setOnlyWithGoals] = useState(false);
  const [showNonSelling, setShowNonSelling] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("leadsYtd");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const dash = useGetCommunities();
  const status = useGetSnowflakeStatus();

  const total = dash.data?.communities.length ?? 0;

  const rows = useMemo(() => {
    let list = dash.data?.communities ?? [];
    if (!showNonSelling) list = list.filter((c) => c.isSelling);
    if (onlyWithGoals) list = list.filter((c) => c.hasGoals);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.development.toLowerCase().includes(q) ||
          c.division.toLowerCase().includes(q) ||
          c.city.toLowerCase().includes(q),
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const cmp = NUMERIC_KEYS.has(sortKey)
        ? (a[sortKey] as number) - (b[sortKey] as number)
        : String(a[sortKey]).localeCompare(String(b[sortKey]));
      return cmp !== 0 ? dir * cmp : a.development.localeCompare(b.development);
    });
  }, [dash.data, search, onlyWithGoals, showNonSelling, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Numeric columns start with the biggest numbers on top.
      setSortDir(NUMERIC_KEYS.has(key) ? "desc" : "asc");
    }
  };

  return (
    <Layout>
      <div className="space-y-6">
        <Breadcrumb page="Community List" />
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Community List</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Esperanza communities with year-to-date funnel activity
          </p>
          <LiveStatusBadge
            status={status.data}
            checking={status.isLoading}
            lastRefreshed={dash.dataUpdatedAt}
          />
        </div>

        <Card>
          <CardContent className="pt-4 pb-4 flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-56">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search development, division, or city…"
                data-testid="input-search"
                className="w-full h-9 rounded-md border bg-background pl-8 pr-2 text-sm"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={onlyWithGoals}
                onChange={(e) => setOnlyWithGoals(e.target.checked)}
                data-testid="checkbox-has-goals"
              />
              Only communities with goals
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showNonSelling}
                onChange={(e) => setShowNonSelling(e.target.checked)}
                data-testid="checkbox-show-non-selling"
              />
              Show non-selling projects
            </label>
            <span className="text-xs text-muted-foreground ml-auto" data-testid="text-count">
              {rows.length} of {total} projects
            </span>
          </CardContent>
        </Card>

        {dash.isError && (
          <Alert variant="destructive">
            <AlertTitle>Failed to load community list</AlertTitle>
            <AlertDescription>
              {(dash.error as Error)?.message ?? "Snowflake query failed."}
            </AlertDescription>
          </Alert>
        )}

        {dash.isLoading && <Skeleton className="h-96" />}

        {dash.data && (
          <Card>
            <CardContent className="pt-4 overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-communities">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <SortHeader
                      label="Development"
                      colKey="development"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      label="Division"
                      colKey="division"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                    />
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4">Flags</th>
                    <SortHeader
                      label="Leads YTD"
                      colKey="leadsYtd"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Tours YTD"
                      colKey="toursYtd"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Sales YTD"
                      colKey="salesYtd"
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                      align="right"
                      last
                    />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={`${c.division}-${c.development}`} className="border-b last:border-0">
                      <td className="py-1.5 pr-4 font-medium">{c.development}</td>
                      <td className="py-1.5 pr-4 text-muted-foreground">{c.division}</td>
                      <td className="py-1.5 pr-4 text-muted-foreground">
                        {[c.city, c.state].filter(Boolean).join(", ") || "–"}
                      </td>
                      <td className="py-1.5 pr-4">
                        <div className="flex gap-1">
                          {c.hasGoals && <Badge variant="secondary">Goals</Badge>}
                          {c.isRental && <Badge variant="outline">Rental</Badge>}
                          {!c.isSelling && (
                            <Badge variant="outline" className="text-muted-foreground">
                              No activity
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 pr-4 text-right">{fmt(c.leadsYtd)}</td>
                      <td className="py-1.5 pr-4 text-right">{fmt(c.toursYtd)}</td>
                      <td className="py-1.5 text-right">{fmt(c.salesYtd)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-6 text-center text-muted-foreground">
                        No communities match the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
