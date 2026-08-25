import { Link, useLocation } from "wouter";
import { BarChart2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { WORKSPACES } from "@/lib/workspaces";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background selection:bg-primary/20 selection:text-primary">
      {/* Top Navbar */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center px-4 md:px-6">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm transition-transform group-hover:scale-105">
              <BarChart2 className="h-5 w-5" />
            </div>
            <span className="font-bold tracking-tight text-foreground">
              Rhodes Analytics
            </span>
          </Link>
          <nav className="ml-8 flex items-center gap-1">
            {WORKSPACES.map((workspace) => {
              const href = `/workspaces/${workspace.slug}`;
              const active = location.startsWith(href);
              return (
                <Link
                  key={workspace.slug}
                  href={href}
                  className={cn(
                    "text-sm font-medium px-3 py-2 rounded-md transition-colors",
                    active
                      ? "text-foreground bg-accent"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent",
                  )}
                >
                  {workspace.name}
                </Link>
              );
            })}
          </nav>
          <div className="flex-1" />
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-4 py-8 md:px-6">{children}</div>
      </main>
    </div>
  );
}
