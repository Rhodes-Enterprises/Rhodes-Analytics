import { Link, useParams } from "wouter";
import { ChevronRight, HardHat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { getDashboard } from "@/lib/workspaces";
import NotFound from "@/pages/not-found";
import OverviewWithTargetsPage from "@/pages/overview-with-targets";

/** Dashboards that have been migrated get a dedicated component. */
const MIGRATED: Record<string, React.ComponentType> = {
  "marketing/overview-with-targets": OverviewWithTargetsPage,
};

export default function DashboardPage() {
  const { workspaceSlug, dashboardSlug } = useParams();
  const entry = getDashboard(workspaceSlug ?? "", dashboardSlug ?? "");

  if (!entry) return <NotFound />;

  const Migrated = MIGRATED[`${workspaceSlug}/${dashboardSlug}`];
  if (Migrated) return <Migrated />;

  const { workspace, dashboard } = entry;

  return (
    <Layout>
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link
            href={`/workspaces/${workspace.slug}`}
            className="hover:text-foreground transition-colors"
          >
            {workspace.name}
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground font-medium">{dashboard.name}</span>
        </nav>

        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {dashboard.name}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm max-w-2xl">
            {dashboard.description}
          </p>
        </div>

        {/* Placeholder body until the dashboard is migrated */}
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed py-24 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <HardHat className="h-6 w-6" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">
            This dashboard is being migrated
          </h2>
          <p className="mt-2 mb-6 max-w-sm text-sm text-muted-foreground">
            {dashboard.name} is queued for migration from Qlik. It will appear
            here, connected to live Snowflake data, once the build is complete.
          </p>
          <Button asChild variant="outline">
            <Link href={`/workspaces/${workspace.slug}`}>
              Back to {workspace.name}
            </Link>
          </Button>
        </div>
      </div>
    </Layout>
  );
}
