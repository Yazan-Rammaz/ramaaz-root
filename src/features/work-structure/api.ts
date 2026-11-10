import "server-only";
import { structureNodeSchema, type DataGroup, type DataOption, type Dashboard, type StructureNode } from "./schema";

/**
 * Single place the business work structure is read. Server-only.
 *
 * ⚠️ MOCKED — the screen is built from its XD frames ahead of the backend.
 * Everything below is what the design shows; every change on the screen
 * (settings, admins, data picks) stays there until a reload. Nothing is sent.
 *
 * When the backend publishes it, the swap keeps a parse boundary per read
 * (the project's data goes through `backendFetch`, which prefixes
 * `/v1/projects/{selected}`), e.g.
 *   const data = await backendFetch.get<unknown>("/work-structure");
 *   return structureNodeSchema.array().parse(data);
 * and every write in the panels becomes a Server Action in `actions.ts`.
 */

const TREE: unknown[] = [
  {
    id: "main",
    name: "Main Business Management",
    icon: "work/main-business",
    children: [
      {
        id: "company-tr",
        name: "Main Company | Projects Management",
        flag: "TR",
        locked: true,
        children: [
          {
            id: "office",
            name: "Main Office Structural Management",
            icon: "side/chat",
            locked: true,
            children: [{ id: "branch", name: "Branch Management", icon: "regions/map", locked: true, children: [] }],
          },
        ],
      },
      { id: "company-iq", name: "Main Company | Projects Management", flag: "IQ", locked: true, children: [] },
      { id: "company-lb", name: "Main Company | Projects Management", flag: "LB", locked: true, children: [] },
    ],
  },
];

export async function loadStructure(): Promise<StructureNode[]> {
  return structureNodeSchema.array().parse(TREE);
}

const opt = (label: string, on = true, children?: DataOption[]): DataOption => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  label,
  on,
  ...(children ? { children } : {}),
});
const levels = (n: number) => Array.from({ length: n }, (_, i) => opt(`Level ${i + 1}`));
const group = (id: string, title: string, icon: string, options: DataOption[]): DataGroup => ({ id, title, icon, options });

export async function loadDashboard(): Promise<Dashboard> {
  return {
    id: "main",
    title: "Main Company | Projects Management",
    icon: "work/main-business",
    allCountries: true,
    adminSeats: 2,
    type: { short: "M", name: "Management" },
    workType: { short: "BO", name: "Business Owners" },
    languages: ["EN", "AR", "TR", "KU"],
    language: "EN",
    link: "canroot.ramaaz.dev",
    access: {
      method: "browser",
      model: "mobile",
      browsers: ["chrome", "safari"],
      conditions: [],
      ips: "192.192.01.01, 193.111.01.09,",
      linkType: "permalink",
      contract: { required: true, which: "contract1" },
      verification: { required: true, which: "type1" },
      loginType: "management",
      approve: false,
    },
    admins: [],
    data: {
      regions: [
        group("regions", "Geographic Regions | Administrative Divisions", "regions/map", [
          opt("Turkiye", true, levels(5)),
          opt("Lebanon", true, levels(2)),
          opt("Iraq", false),
        ]),
      ],
      currencies: [
        group("currencies", "Currencies", "nav/currencies", [
          opt("Money", true, [
            opt("American Dollars"),
            opt("Turkish Lira"),
            opt("Syrian Pounds"),
            opt("Iraqi Dinar"),
            opt("Lebanese Pound"),
          ]),
          opt("Crypto", true, [opt("USDT, TRON, TRC20"), opt("ETH")]),
          opt("Gold", false),
          opt("Silver", false),
        ]),
      ],
      structure: [
        group("departments", "Administrative Structure | Departments", "nav/hierarchy", [
          opt("Human Resources"),
          opt("Finance", true, [opt("Finance 1")]),
          opt("Operations"),
          opt("Marketing"),
          opt("Sales"),
          opt("Technology"),
          opt("Research & Development"),
          opt("Legal"),
          opt("Production"),
          opt("Customer Service"),
        ]),
        group("levels", "Administrative Structure | Levels", "business/work-type", [
          opt("Board Of Directors"),
          opt("Senior Executive Management"),
          opt("Core Functional Departments"),
        ]),
        group("titles", "Administrative Structure | Job Title", "business/individual", [
          opt("Owner"),
          opt("Ceo"),
          opt("Director"),
          opt("Senior Manager"),
          opt("Manager"),
          opt("Asst. Manager"),
          opt("Team Lead"),
          opt("Supervisor", false),
          opt("Senior Staff", false),
          opt("Staff", false),
        ]),
      ],
      rbac: [
        group("roles", "System RBAC | Roles", "roles/tab-roles", [
          opt("Business Admin", false),
          opt("Super Admin", false),
          opt("Admin", false),
          opt("User", false),
          opt("Guest", false),
        ]),
        group("permissions", "System RBAC | Permissions", "roles/tab-tree", [
          opt("Create", false),
          opt("Update", false),
          opt("View", false),
          opt("Workflow", false),
          opt("Delete", false),
        ]),
      ],
      business: [
        group("work-types", "System Business Work Type", "business/corporate", [
          opt("Business Partner"),
          opt("Business Owners"),
          opt("Business Distributor"),
        ]),
        group("business-types", "System Business Type", "nav/business", [
          opt("Individual", true, [
            opt("Owner"),
            opt("Partner"),
            opt("Staff"),
            opt("Contract"),
            opt("Broker"),
            opt("Agent"),
            opt("Freelancer"),
          ]),
          opt("Corporate", true, [opt("Office"), opt("Center"), opt("Branch"), opt("Point")]),
        ]),
      ],
      legal: [
        group("legal", "The Legal Entity", "work/legal", [opt("Branch"), opt("Subsidiary"), opt("Representative")]),
      ],
    },
  };
}
