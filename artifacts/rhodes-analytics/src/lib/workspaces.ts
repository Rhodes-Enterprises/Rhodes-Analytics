import type { LucideIcon } from "lucide-react";
import {
  Target,
  Globe,
  Users,
  Footprints,
  DollarSign,
  CalendarRange,
  Goal,
  ListChecks,
  KeyRound,
} from "lucide-react";

export type DashboardStatus = "available" | "coming-soon";

export interface DashboardEntry {
  slug: string;
  name: string;
  description: string;
  status: DashboardStatus;
  icon: LucideIcon;
}

export interface Workspace {
  slug: string;
  name: string;
  description: string;
  dashboards: DashboardEntry[];
}

/**
 * Registry of workspaces and their dashboards.
 * Adding a menu item or a dashboard tile is configuration only:
 * append to this array and the menu, catalog, and routes pick it up.
 */
export const WORKSPACES: Workspace[] = [
  {
    slug: "marketing",
    name: "Marketing Dashboards",
    description:
      "Marketing performance across divisions and developments: traffic, leads, tours, and sales against goals.",
    dashboards: [
      {
        slug: "overview-with-targets",
        name: "Overview with Targets",
        description:
          "Sales and traffic performance against Proforma, Business Plan, Goal, and Waterfall targets with PTG tracking.",
        status: "available",
        icon: Target,
      },
      {
        slug: "leasing",
        name: "Rhodes Living Leasing",
        description:
          "Leases ratified, cancelled, and net vs RL goals for the Rhodes Living communities.",
        status: "available",
        icon: KeyRound,
      },
      {
        slug: "website-traffic",
        name: "Website Traffic",
        description: "Website users, sessions, and engagement from Google Analytics.",
        status: "available",
        icon: Globe,
      },
      {
        slug: "leads",
        name: "Leads",
        description: "Lead volume, sources, and conversion by division and development.",
        status: "available",
        icon: Users,
      },
      {
        slug: "tours",
        name: "Tours",
        description: "Scheduled and completed tours across onsite and online channels.",
        status: "available",
        icon: Footprints,
      },
      {
        slug: "gross-sales",
        name: "Gross Sales",
        description: "Gross sales volume and trends by division.",
        status: "available",
        icon: DollarSign,
      },
      {
        slug: "year-over-year",
        name: "Year Over Year",
        description: "Current year vs prior year comparisons for key funnel metrics.",
        status: "available",
        icon: CalendarRange,
      },
      {
        slug: "ehi-goals",
        name: "EHI Goals",
        description: "Esperanza Homes goal tracking and attainment.",
        status: "available",
        icon: Goal,
      },
      {
        slug: "community-list",
        name: "Community List",
        description: "Directory of communities with key attributes.",
        status: "available",
        icon: ListChecks,
      },
    ],
  },
];

export function getWorkspace(slug: string): Workspace | undefined {
  return WORKSPACES.find((w) => w.slug === slug);
}

export function getDashboard(
  workspaceSlug: string,
  dashboardSlug: string,
): { workspace: Workspace; dashboard: DashboardEntry } | undefined {
  const workspace = getWorkspace(workspaceSlug);
  const dashboard = workspace?.dashboards.find((d) => d.slug === dashboardSlug);
  return workspace && dashboard ? { workspace, dashboard } : undefined;
}
