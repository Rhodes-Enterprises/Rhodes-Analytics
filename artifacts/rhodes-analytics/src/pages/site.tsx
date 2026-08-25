import * as React from "react";
import { useLocation, useParams } from "wouter";
import { 
  useGetSite, 
  useGetStatsSummary, 
  useGetStatsTimeseries, 
  useGetStatsPages, 
  useGetStatsReferrers, 
  useGetStatsDevices, 
  useGetStatsCountries, 
  useGetRecentEvents,
  useUpdateSite,
  useDeleteSite,
  useCollectEvent,
  getGetSiteQueryKey,
  getGetStatsSummaryQueryKey,
  getGetStatsTimeseriesQueryKey,
  getGetStatsPagesQueryKey,
  getGetStatsReferrersQueryKey,
  getGetStatsDevicesQueryKey,
  getGetStatsCountriesQueryKey,
  getGetRecentEventsQueryKey,
  RangeParameter
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer
} from "recharts";
import { 
  ArrowUpRight, ArrowDownRight, Activity, Users, Eye, Clock, MousePointerClick, 
  Globe, Laptop, LayoutTemplate, MoreVertical, Copy, Terminal, Trash2, Settings, AlertTriangle
} from "lucide-react";
import { formatNumber, formatPercentage, formatDuration, cn } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function SiteDashboard() {
  const { id } = useParams();
  const siteId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const [range, setRange] = React.useState<RangeParameter>("7d");

  // Queries
  const { data: site, isLoading: isSiteLoading, error: siteError } = useGetSite(siteId, {
    query: { enabled: !!siteId, queryKey: getGetSiteQueryKey(siteId) }
  });

  const queryParams = { range };
  const { data: summary, isLoading: isSummaryLoading } = useGetStatsSummary(siteId, queryParams, { query: { enabled: !!siteId, queryKey: getGetStatsSummaryQueryKey(siteId, queryParams) } });
  const { data: timeseries, isLoading: isTimeseriesLoading } = useGetStatsTimeseries(siteId, queryParams, { query: { enabled: !!siteId, queryKey: getGetStatsTimeseriesQueryKey(siteId, queryParams) } });
  const { data: pages, isLoading: isPagesLoading } = useGetStatsPages(siteId, queryParams, { query: { enabled: !!siteId, queryKey: getGetStatsPagesQueryKey(siteId, queryParams) } });
  const { data: referrers, isLoading: isReferrersLoading } = useGetStatsReferrers(siteId, queryParams, { query: { enabled: !!siteId, queryKey: getGetStatsReferrersQueryKey(siteId, queryParams) } });
  const { data: devices, isLoading: isDevicesLoading } = useGetStatsDevices(siteId, queryParams, { query: { enabled: !!siteId, queryKey: getGetStatsDevicesQueryKey(siteId, queryParams) } });
  const { data: countries, isLoading: isCountriesLoading } = useGetStatsCountries(siteId, queryParams, { query: { enabled: !!siteId, queryKey: getGetStatsCountriesQueryKey(siteId, queryParams) } });
  
  // Live events feed (poll every 10s)
  const { data: recentEvents, isLoading: isEventsLoading } = useGetRecentEvents(
    siteId, 
    { limit: 15 }, 
    { query: { enabled: !!siteId, refetchInterval: 10000, queryKey: getGetRecentEventsQueryKey(siteId, { limit: 15 }) } }
  );

  if (siteError) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center py-20">
          <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
          <h2 className="text-xl font-bold">Site Not Found</h2>
          <p className="text-muted-foreground mt-2 mb-6">This site may have been deleted or you don't have access.</p>
          <Button onClick={() => setLocation("/")}>Back to Dashboard</Button>
        </div>
      </Layout>
    );
  }

  if (isSiteLoading) {
    return (
      <Layout>
        <div className="space-y-6">
          <Skeleton className="h-12 w-1/3" />
          <div className="grid gap-4 md:grid-cols-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32" />)}
          </div>
          <Skeleton className="h-[400px]" />
        </div>
      </Layout>
    );
  }

  if (!site) return null;

  return (
    <Layout>
      <div className="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
        
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold tracking-tight text-foreground">{site.name}</h1>
              {summary && summary.liveVisitors > 0 && (
                <Badge variant="success" className="animate-in fade-in h-6">
                  <div className="w-1.5 h-1.5 rounded-full bg-success-foreground mr-1.5 animate-pulse" />
                  {summary.liveVisitors} Live
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 text-muted-foreground font-mono text-sm">
              <Globe className="h-3 w-3" />
              <span>{site.domain}</span>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Tabs value={range} onValueChange={(v) => setRange(v as RangeParameter)} className="w-auto">
              <TabsList>
                <TabsTrigger value="24h">24h</TabsTrigger>
                <TabsTrigger value="7d">7d</TabsTrigger>
                <TabsTrigger value="30d">30d</TabsTrigger>
                <TabsTrigger value="90d">90d</TabsTrigger>
              </TabsList>
            </Tabs>
            
            <SiteSettingsMenu site={site} onDelete={() => setLocation("/")} />
          </div>
        </div>

        {/* Snippet Install Alert - show if no data yet or optionally always available */}
        {summary && summary.pageviews === 0 && (
          <SnippetAlert site={site} />
        )}

        {/* Headline Stats */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard 
            title="Unique Visitors" 
            value={summary?.visitors} 
            change={summary?.visitorsChange} 
            isLoading={isSummaryLoading}
            icon={<Users className="h-4 w-4 text-muted-foreground" />}
          />
          <StatCard 
            title="Total Pageviews" 
            value={summary?.pageviews} 
            change={summary?.pageviewsChange} 
            isLoading={isSummaryLoading}
            icon={<Eye className="h-4 w-4 text-muted-foreground" />}
          />
          <StatCard 
            title="Bounce Rate" 
            value={summary?.bounceRate} 
            formatter={formatPercentage}
            change={summary?.bounceRateChange} 
            inverted // lower bounce rate is better
            isLoading={isSummaryLoading}
            icon={<MousePointerClick className="h-4 w-4 text-muted-foreground" />}
          />
          <StatCard 
            title="Avg. Visit Duration" 
            value={summary?.avgDurationSeconds} 
            formatter={formatDuration}
            change={summary?.avgDurationChange} 
            isLoading={isSummaryLoading}
            icon={<Clock className="h-4 w-4 text-muted-foreground" />}
          />
        </div>

        {/* Main Chart */}
        <Card className="border-card-border shadow-xs">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <div>
              <CardTitle>Traffic Overview</CardTitle>
              <CardDescription>Visitors and pageviews over time</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {isTimeseriesLoading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : timeseries && timeseries.length > 0 ? (
              <div className="h-[300px] w-full mt-4">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeseries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorVisitors" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorPageviews" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0.1}/>
                        <stop offset="95%" stopColor="hsl(var(--muted-foreground))" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis 
                      dataKey="bucket" 
                      tickFormatter={(val) => {
                        const date = parseISO(val);
                        return range === '24h' ? format(date, 'HH:mm') : format(date, 'MMM d');
                      }} 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false} 
                    />
                    <YAxis 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false} 
                      tickFormatter={(val) => val >= 1000 ? `${(val/1000).toFixed(1)}k` : val}
                    />
                    <RechartsTooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        borderColor: 'hsl(var(--border))',
                        borderRadius: 'var(--radius)',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                      }}
                      labelFormatter={(val) => format(parseISO(val as string), range === '24h' ? 'MMM d, yyyy HH:mm' : 'MMM d, yyyy')}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="pageviews" 
                      name="Pageviews"
                      stroke="hsl(var(--muted-foreground))" 
                      fillOpacity={1} 
                      fill="url(#colorPageviews)" 
                      strokeWidth={2}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="visitors" 
                      name="Visitors"
                      stroke="hsl(var(--primary))" 
                      fillOpacity={1} 
                      fill="url(#colorVisitors)" 
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground border-2 border-dashed rounded-lg mt-4">
                No traffic data for this period.
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Top Pages */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LayoutTemplate className="h-4 w-4" /> Top Pages
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <DataTable 
                data={pages} 
                isLoading={isPagesLoading} 
                columns={[
                  { key: 'path', label: 'Path', render: (val) => <span className="font-mono text-xs">{val}</span> },
                  { key: 'visitors', label: 'Visitors', render: (val) => <span className="font-mono">{formatNumber(val)}</span>, align: 'right' },
                ]}
                emptyMessage="No page views yet."
              />
            </CardContent>
          </Card>

          {/* Top Referrers */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowUpRight className="h-4 w-4" /> Top Referrers
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <DataTable 
                data={referrers} 
                isLoading={isReferrersLoading} 
                columns={[
                  { key: 'referrer', label: 'Source', render: (val) => val === 'Direct' ? <Badge variant="secondary" className="font-normal">Direct</Badge> : val },
                  { key: 'visitors', label: 'Visitors', render: (val) => <span className="font-mono">{formatNumber(val)}</span>, align: 'right' },
                ]}
                emptyMessage="No referrers yet."
              />
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {/* Top Countries */}
          <Card className="md:col-span-1">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-4 w-4" /> Top Countries
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <DataTable 
                data={countries} 
                isLoading={isCountriesLoading} 
                columns={[
                  { 
                    key: 'countryName', 
                    label: 'Country', 
                    render: (val, row) => (
                      <div className="flex items-center gap-2">
                        {row.country && <img src={`https://flagcdn.com/20x15/${row.country.toLowerCase()}.png`} width="20" height="15" alt={row.country} className="rounded-sm opacity-90 shadow-xs" />}
                        <span className="truncate max-w-[120px]">{val || 'Unknown'}</span>
                      </div>
                    ) 
                  },
                  { key: 'visitors', label: 'Visitors', render: (val) => <span className="font-mono">{formatNumber(val)}</span>, align: 'right' },
                ]}
                emptyMessage="No country data yet."
              />
            </CardContent>
          </Card>

          {/* Devices Breakdown */}
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Laptop className="h-4 w-4" /> Device Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isDevicesLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              ) : devices ? (
                <Tabs defaultValue="deviceTypes" className="w-full">
                  <TabsList className="grid w-full grid-cols-3 mb-4">
                    <TabsTrigger value="deviceTypes">Devices</TabsTrigger>
                    <TabsTrigger value="browsers">Browsers</TabsTrigger>
                    <TabsTrigger value="operatingSystems">OS</TabsTrigger>
                  </TabsList>
                  
                  <TabsContent value="deviceTypes" items={devices.deviceTypes} />
                  <TabsContent value="browsers" items={devices.browsers} />
                  <TabsContent value="operatingSystems" items={devices.operatingSystems} />
                </Tabs>
              ) : (
                <div className="py-8 text-center text-sm text-muted-foreground">No device data yet.</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent Events Live Feed */}
        <Card className="border-primary/20 shadow-xs">
          <CardHeader className="bg-primary/5 border-b border-primary/10">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-primary">
                <Activity className="h-4 w-4" /> Live Events Feed
              </CardTitle>
              <div className="flex items-center gap-2 text-xs font-medium text-primary/70">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
                Polling every 10s
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isEventsLoading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : recentEvents && recentEvents.length > 0 ? (
              <div className="divide-y divide-border">
                {recentEvents.map((event) => (
                  <div key={event.id} className="flex items-center gap-4 p-4 hover:bg-muted/30 transition-colors">
                    <div className="text-xs text-muted-foreground font-mono w-16 shrink-0">
                      {format(parseISO(event.occurredAt), 'HH:mm:ss')}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium truncate">{event.path}</span>
                        {event.referrer && event.referrer !== 'Direct' && (
                          <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0 h-4">
                            from {event.referrer}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        {event.country && (
                          <span className="flex items-center gap-1">
                            <img src={`https://flagcdn.com/16x12/${event.country.toLowerCase()}.png`} width="12" height="9" alt={event.countryName || ''} className="rounded-[1px]" />
                            {event.countryName}
                          </span>
                        )}
                        {event.browser && <span>{event.browser} on {event.os}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center">
                <Terminal className="h-8 w-8 mb-2 opacity-20" />
                Waiting for events... <br/>
                Install the snippet and visit your site to see data flow in real-time.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

// Sub-components

function TabsContent({ value, items }: { value: string, items: any[] }) {
  if (!items || items.length === 0) {
    return <div className="py-6 text-center text-sm text-muted-foreground">No data available.</div>;
  }
  
  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {items.map((item, i) => (
        <div key={i} className="space-y-1.5">
          <div className="flex justify-between text-sm">
            <span className="font-medium">{item.name || 'Unknown'}</span>
            <div className="flex items-center gap-4">
              <span className="text-muted-foreground">{formatPercentage(item.percentage)}</span>
              <span className="font-mono text-xs w-12 text-right">{formatNumber(item.visitors)}</span>
            </div>
          </div>
          <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
            <div 
              className="h-full bg-primary rounded-full transition-all duration-1000 ease-out" 
              style={{ width: `${item.percentage}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function StatCard({ 
  title, 
  value, 
  change,
  formatter = formatNumber,
  inverted = false,
  isLoading,
  icon
}: { 
  title: string; 
  value?: number; 
  change?: number | null;
  formatter?: (val: number) => string;
  inverted?: boolean;
  isLoading: boolean;
  icon?: React.ReactNode;
}) {
  const isPositive = change && change > 0;
  const isNegative = change && change < 0;
  
  const isGood = inverted ? isNegative : isPositive;
  const isBad = inverted ? isPositive : isNegative;
  
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-5">
        <div className="flex flex-row items-center justify-between space-y-0 pb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</p>
          {icon}
        </div>
        <div className="flex items-baseline justify-between mt-1">
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <div className="text-2xl font-bold font-mono tracking-tight">
              {value !== undefined ? formatter(value) : "—"}
            </div>
          )}
          
          {!isLoading && change !== undefined && change !== null && (
            <div className={cn(
              "flex items-center text-xs font-medium px-1.5 py-0.5 rounded-md",
              isGood ? "text-success bg-success/10" : isBad ? "text-destructive bg-destructive/10" : "text-muted-foreground bg-muted"
            )}>
              {isPositive && <ArrowUpRight className="h-3 w-3 mr-1" />}
              {isNegative && <ArrowDownRight className="h-3 w-3 mr-1" />}
              {!isPositive && !isNegative && <span className="mr-1">~</span>}
              {Math.abs(change).toFixed(1)}%
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface DataTableColumn {
  key: string;
  label: string;
  render: (val: any, row: any) => React.ReactNode;
  align?: "left" | "right";
}

function DataTable({ data, isLoading, columns, emptyMessage }: { data: any, isLoading: boolean, columns: DataTableColumn[], emptyMessage: string }) {
  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground border-t border-border/50">
        {emptyMessage}
      </div>
    );
  }

  return (
    <Table>
      <TableHeader className="bg-muted/30">
        <TableRow>
          {columns.map((col, i) => (
            <TableHead key={i} className={col.align === 'right' ? 'text-right' : ''}>{col.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row: any, rowIndex: number) => (
          <TableRow key={rowIndex}>
            {columns.map((col, colIndex) => (
              <TableCell key={colIndex} className={cn("py-3", col.align === 'right' ? 'text-right' : '')}>
                {col.render(row[col.key], row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SnippetAlert({ site }: { site: any }) {
  const snippet = `<script async src="https://rhodes.app/ra.js" data-tracking-id="${site.trackingId}"></script>`;
  const { toast } = useToast();
  const sendTestEvent = useCollectEvent();
  
  const handleCopy = () => {
    navigator.clipboard.writeText(snippet);
    toast({ title: "Copied to clipboard!" });
  };

  const handleTest = () => {
    sendTestEvent.mutate({
      data: {
        trackingId: site.trackingId,
        path: "/",
        visitorId: `test-${Math.random().toString(36).substring(7)}`,
        userAgent: navigator.userAgent,
        durationSeconds: 15
      }
    }, {
      onSuccess: () => toast({ title: "Test event sent successfully", variant: "default" }),
      onError: () => toast({ title: "Failed to send test event", variant: "destructive" })
    });
  };

  return (
    <div className="bg-primary/5 border border-primary/20 rounded-lg overflow-hidden">
      <div className="p-4 border-b border-primary/10">
        <h4 className="text-base font-semibold text-primary flex items-center gap-2">
          <Terminal className="h-4 w-4" /> Install Tracking Snippet
        </h4>
        <p className="text-sm text-muted-foreground mt-1">
          Add this code to the <code className="text-xs bg-muted px-1 py-0.5 rounded">&lt;head&gt;</code> of your website.
        </p>
      </div>
      <div className="p-4">
        <div className="relative flex-1">
          <pre className="p-3 bg-card border rounded-md text-xs font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all">
            {snippet}
          </pre>
          <Button size="icon" variant="ghost" className="absolute top-2 right-2 h-6 w-6 text-muted-foreground bg-card" onClick={handleCopy}>
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div className="px-4 py-3 bg-primary/5 border-t border-primary/10 flex justify-end">
        <Button variant="outline" size="sm" onClick={handleTest} disabled={sendTestEvent.isPending}>
          {sendTestEvent.isPending ? "Sending..." : "Send Test Event"}
        </Button>
      </div>
    </div>
  );
}

const updateSiteSchema = z.object({
  name: z.string().min(1).max(50),
  domain: z.string().min(1).max(100),
});

function SiteSettingsMenu({ site, onDelete }: { site: any, onDelete: () => void }) {
  const [openUpdate, setOpenUpdate] = React.useState(false);
  const [openDelete, setOpenDelete] = React.useState(false);
  const [openSnippet, setOpenSnippet] = React.useState(false);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateSite = useUpdateSite();
  const deleteSite = useDeleteSite();

  const form = useForm<z.infer<typeof updateSiteSchema>>({
    resolver: zodResolver(updateSiteSchema),
    defaultValues: { name: site.name, domain: site.domain },
  });

  const handleUpdate = (values: z.infer<typeof updateSiteSchema>) => {
    updateSite.mutate({ id: site.id, data: values }, {
      onSuccess: (updatedSite) => {
        toast({ title: "Site updated" });
        queryClient.setQueryData(getGetSiteQueryKey(site.id), updatedSite);
        queryClient.invalidateQueries({ queryKey: ["/api/sites"] });
        setOpenUpdate(false);
      }
    });
  };

  const handleDelete = () => {
    deleteSite.mutate({ id: site.id }, {
      onSuccess: () => {
        toast({ title: "Site deleted" });
        queryClient.invalidateQueries({ queryKey: ["/api/sites"] });
        queryClient.invalidateQueries({ queryKey: ["/api/overview"] });
        setOpenDelete(false);
        onDelete();
      }
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setOpenUpdate(true)}>
            <Settings className="h-4 w-4 mr-2" /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setOpenSnippet(true)}>
            <Terminal className="h-4 w-4 mr-2" /> Tracking Code
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setOpenDelete(true)} className="text-destructive focus:text-destructive">
            <Trash2 className="h-4 w-4 mr-2" /> Delete Site
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={openUpdate} onOpenChange={setOpenUpdate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Site Settings</DialogTitle>
            <DialogDescription>Update your site details.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleUpdate)} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem>
                  <FormLabel>Site Name</FormLabel>
                  <FormControl><Input {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="domain" render={({ field }) => (
                <FormItem>
                  <FormLabel>Domain</FormLabel>
                  <FormControl><Input {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpenUpdate(false)}>Cancel</Button>
                <Button type="submit" disabled={updateSite.isPending}>Save Changes</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={openDelete} onOpenChange={setOpenDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">Delete Site</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{site.name}</strong>? This action cannot be undone and will delete all analytics data forever.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setOpenDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteSite.isPending}>
              {deleteSite.isPending ? "Deleting..." : "Delete Permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={openSnippet} onOpenChange={setOpenSnippet}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Tracking Code</DialogTitle>
            <DialogDescription>Add this snippet to your site to start tracking.</DialogDescription>
          </DialogHeader>
          <SnippetAlert site={site} />
        </DialogContent>
      </Dialog>
    </>
  );
}
