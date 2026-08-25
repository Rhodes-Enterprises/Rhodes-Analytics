import { Link } from "wouter";
import { ArrowRight, LayoutGrid } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Layout } from "@/components/layout";
import { WORKSPACES } from "@/lib/workspaces";

export default function Home() {
  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            Workspaces
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Dashboard collections organized by business area.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {WORKSPACES.map((workspace) => {
            const available = workspace.dashboards.filter(
              (d) => d.status === "available",
            ).length;
            return (
              <Card
                key={workspace.slug}
                className="group relative hover:border-primary/50 transition-colors"
              >
                <Link
                  href={`/workspaces/${workspace.slug}`}
                  className="absolute inset-0 z-10"
                >
                  <span className="sr-only">Open {workspace.name}</span>
                </Link>
                <CardContent className="p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary mb-4">
                    <LayoutGrid className="h-5 w-5" />
                  </div>
                  <h2 className="text-lg font-semibold group-hover:text-primary transition-colors">
                    {workspace.name}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                    {workspace.description}
                  </p>
                  <div className="mt-4 flex items-center justify-between text-xs font-medium text-muted-foreground">
                    <span>
                      {workspace.dashboards.length} dashboards
                      {available > 0 ? ` · ${available} live` : ""}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-1 transition-transform" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </Layout>
  );
}
