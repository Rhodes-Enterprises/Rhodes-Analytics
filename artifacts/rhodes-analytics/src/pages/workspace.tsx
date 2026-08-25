import { Link, useParams } from "wouter";
import { ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Layout } from "@/components/layout";
import { cn } from "@/lib/utils";
import { getWorkspace, type DashboardEntry } from "@/lib/workspaces";
import NotFound from "@/pages/not-found";

export default function WorkspacePage() {
  const { workspaceSlug } = useParams();
  const workspace = getWorkspace(workspaceSlug ?? "");

  if (!workspace) return <NotFound />;

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Workspace
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">
            {workspace.name}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm max-w-2xl">
            {workspace.description}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {workspace.dashboards.map((dashboard, i) => (
            <DashboardTile
              key={dashboard.slug}
              workspaceSlug={workspace.slug}
              dashboard={dashboard}
              index={i}
            />
          ))}
        </div>
      </div>
    </Layout>
  );
}

function DashboardTile({
  workspaceSlug,
  dashboard,
  index,
}: {
  workspaceSlug: string;
  dashboard: DashboardEntry;
  index: number;
}) {
  const Icon = dashboard.icon;
  const comingSoon = dashboard.status === "coming-soon";

  return (
    <Card
      className={cn(
        "group relative flex flex-col transition-colors animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both",
        comingSoon ? "bg-muted/30" : "hover:border-primary/50",
      )}
      style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
    >
      <Link
        href={`/workspaces/${workspaceSlug}/${dashboard.slug}`}
        className="absolute inset-0 z-10"
      >
        <span className="sr-only">Open {dashboard.name}</span>
      </Link>
      <CardContent className="p-5 flex flex-col flex-1">
        <div className="flex items-start justify-between">
          <div
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg",
              comingSoon
                ? "bg-muted text-muted-foreground"
                : "bg-primary/10 text-primary",
            )}
          >
            <Icon className="h-4.5 w-4.5" />
          </div>
          {comingSoon ? (
            <Badge
              variant="secondary"
              className="text-[10px] font-medium text-muted-foreground"
            >
              Coming soon
            </Badge>
          ) : (
            <Badge variant="success" className="text-[10px] font-medium">
              Live
            </Badge>
          )}
        </div>
        <h2
          className={cn(
            "mt-4 text-sm font-semibold leading-snug",
            !comingSoon && "group-hover:text-primary transition-colors",
          )}
        >
          {dashboard.name}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground line-clamp-2 flex-1">
          {dashboard.description}
        </p>
        <div className="mt-4 flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span>{comingSoon ? "In migration" : "Open dashboard"}</span>
          <ArrowRight className="h-3 w-3 group-hover:translate-x-1 transition-transform" />
        </div>
      </CardContent>
    </Card>
  );
}
