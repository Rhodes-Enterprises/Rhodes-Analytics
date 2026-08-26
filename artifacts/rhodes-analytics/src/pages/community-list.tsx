import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useGetCommunities, useGetSnowflakeStatus } from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Breadcrumb, LiveStatusBadge, fmt } from "@/components/dashboard-shared";

export default function CommunityListPage() {
  const [search, setSearch] = useState("");
  const [onlyWithGoals, setOnlyWithGoals] = useState(false);

  const dash = useGetCommunities();
  const status = useGetSnowflakeStatus();

  const rows = useMemo(() => {
    let list = dash.data?.communities ?? [];
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
    return list;
  }, [dash.data, search, onlyWithGoals]);

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
            <span className="text-xs text-muted-foreground ml-auto" data-testid="text-count">
              {rows.length} communities
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
                    <th className="py-2 pr-4">Development</th>
                    <th className="py-2 pr-4">Division</th>
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4">Flags</th>
                    <th className="py-2 pr-4 text-right">Leads YTD</th>
                    <th className="py-2 pr-4 text-right">Tours YTD</th>
                    <th className="py-2 text-right">Sales YTD</th>
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
                        </div>
                      </td>
                      <td className="py-1.5 pr-4 text-right">{fmt(c.leadsYtd)}</td>
                      <td className="py-1.5 pr-4 text-right">{fmt(c.toursYtd)}</td>
                      <td className="py-1.5 text-right">{fmt(c.salesYtd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
