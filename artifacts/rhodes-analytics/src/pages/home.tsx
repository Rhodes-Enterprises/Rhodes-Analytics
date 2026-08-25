import { useGetOverview, useListSites, useCreateSite, getListSitesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Layout } from "@/components/layout";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { Globe, Users, Plus, ArrowRight, Eye } from "lucide-react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { cn, formatNumber } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import React from "react";

const createSiteSchema = z.object({
  name: z.string().min(1, "Name is required").max(50),
  domain: z.string().min(1, "Domain is required").max(100),
});

export default function Home() {
  const { data: overview, isLoading: isOverviewLoading } = useGetOverview();
  const { data: sites, isLoading: isSitesLoading } = useListSites({ query: { refetchInterval: 60000, queryKey: getListSitesQueryKey() } });
  
  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        {/* Header & Overview Stats */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Overview</h1>
          <p className="text-muted-foreground mt-1 text-sm">Cross-site traffic across all registered properties.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard 
            title="Total Sites" 
            value={overview?.totalSites} 
            icon={<Globe className="h-4 w-4 text-muted-foreground" />} 
            isLoading={isOverviewLoading} 
          />
          <StatCard 
            title="Live Visitors" 
            value={overview?.liveVisitors} 
            icon={
              <div className="relative flex h-4 w-4">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                <span className="relative inline-flex rounded-full h-4 w-4 bg-success/20 items-center justify-center">
                  <span className="block h-2 w-2 rounded-full bg-success"></span>
                </span>
              </div>
            }
            isLoading={isOverviewLoading}
            valueClass="text-success"
          />
          <StatCard 
            title="Visitors (24h)" 
            value={overview?.visitors24h} 
            icon={<Users className="h-4 w-4 text-muted-foreground" />} 
            isLoading={isOverviewLoading} 
          />
          <StatCard 
            title="Pageviews (24h)" 
            value={overview?.pageviews24h} 
            icon={<Eye className="h-4 w-4 text-muted-foreground" />} 
            isLoading={isOverviewLoading} 
          />
        </div>

        {/* Sites List */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold tracking-tight">Your Sites</h2>
            <CreateSiteDialog />
          </div>

          {isSitesLoading ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[200px] w-full rounded-xl" />
              ))}
            </div>
          ) : sites && sites.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {sites.map((site) => (
                <SiteCard key={site.id} site={site} />
              ))}
            </div>
          ) : (
            <Card className="flex flex-col items-center justify-center p-12 text-center border-dashed">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <Globe className="h-6 w-6 text-primary" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">No sites yet</h3>
              <p className="mt-2 mb-6 text-sm text-muted-foreground max-w-sm">
                Register your first website to get the tracking snippet and start seeing insights.
              </p>
              <CreateSiteDialog />
            </Card>
          )}
        </div>
      </div>
    </Layout>
  );
}

function StatCard({ 
  title, 
  value, 
  icon, 
  isLoading,
  valueClass
}: { 
  title: string; 
  value?: number; 
  icon: React.ReactNode; 
  isLoading: boolean;
  valueClass?: string;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-6">
        <div className="flex flex-row items-center justify-between space-y-0 pb-2">
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
          {icon}
        </div>
        <div>
          {isLoading ? (
            <Skeleton className="h-8 w-24 mt-1" />
          ) : (
            <div className={cn("text-3xl font-bold font-mono tracking-tight", valueClass)}>
              {value !== undefined ? formatNumber(value) : "—"}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SiteCard({ site }: { site: any }) {
  const sparklineData = site.sparkline.map((val: number, i: number) => ({ index: i, value: val }));
  
  return (
    <Card className="flex flex-col hover:border-primary/50 transition-colors group relative overflow-hidden">
      <Link href={`/sites/${site.id}`} className="absolute inset-0 z-10">
        <span className="sr-only">View {site.name}</span>
      </Link>
      <CardHeader className="pb-4">
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="text-lg flex items-center gap-2 group-hover:text-primary transition-colors">
              {site.name}
            </CardTitle>
            <CardDescription className="mt-1 flex items-center gap-1 font-mono text-xs">
              {site.domain}
            </CardDescription>
          </div>
          {site.liveVisitors > 0 && (
            <Badge variant="success" className="animate-in fade-in">
              <div className="w-1.5 h-1.5 rounded-full bg-success-foreground mr-1.5 animate-pulse" />
              {site.liveVisitors} Live
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pb-0 flex-1">
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Visitors (24h)</p>
            <p className="text-xl font-bold font-mono">{formatNumber(site.visitors24h)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Pageviews</p>
            <p className="text-xl font-bold font-mono">{formatNumber(site.pageviews24h)}</p>
          </div>
        </div>
        
        <div className="h-[60px] w-full mt-2 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparklineData}>
              <Line 
                type="monotone" 
                dataKey="value" 
                stroke="hsl(var(--primary))" 
                strokeWidth={2} 
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
      <div className="px-5 py-3 border-t bg-muted/30 flex justify-between items-center text-xs font-medium text-muted-foreground">
        <span>View Analytics</span>
        <ArrowRight className="h-3 w-3 group-hover:translate-x-1 transition-transform" />
      </div>
    </Card>
  );
}

function CreateSiteDialog() {
  const [open, setOpen] = React.useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createSite = useCreateSite();

  const form = useForm<z.infer<typeof createSiteSchema>>({
    resolver: zodResolver(createSiteSchema),
    defaultValues: { name: "", domain: "" },
  });

  function onSubmit(values: z.infer<typeof createSiteSchema>) {
    createSite.mutate({ data: values }, {
      onSuccess: () => {
        toast({ title: "Site created successfully" });
        queryClient.invalidateQueries({ queryKey: ["/api/sites"] });
        queryClient.invalidateQueries({ queryKey: ["/api/overview"] });
        setOpen(false);
        form.reset();
      },
      onError: (err: any) => {
        toast({ 
          title: "Failed to create site", 
          description: err?.message || "An error occurred",
          variant: "destructive" 
        });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          Add Site
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a new site</DialogTitle>
          <DialogDescription>
            Register a website to get your tracking snippet.
          </DialogDescription>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Site Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. My Awesome Blog" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="domain"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Domain</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. blog.example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createSite.isPending}>
                {createSite.isPending ? "Creating..." : "Create Site"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
