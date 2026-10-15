// Gym ATS, a seeded-defect demo app Gnomi is measured against (catalogue: gym/defects.yaml). No dependencies.
// startGym({ port, defects, login, thirdParty, liveKey, captcha }): port defaults to 4317 (0 = any free port); defects default to all of DEFECT_IDS; other options default off. Env: PORT, GYM_DEFECTS, GYM_LOGIN=1, GYM_THIRD_PARTY, GYM_LIVE_KEY=1, GYM_CAPTCHA=1.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const DEFECT_IDS = ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "D10", "D11", "D12"];
const DEPARTMENTS = ["Engineering", "Design", "Product", "Sales", "People"];
const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contract", "Internship"];
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export const GYM_ACCOUNTS = [
  { email: 'recruiter@gym.test', password: 'gym-recruiter-pass-1', name: 'Priya Natarajan', role: 'recruiter' },
  { email: 'manager@gym.test', password: 'gym-manager-pass-1', name: 'Dana Okafor', role: 'hiring_manager' },
  { email: 'admin@gym.test', password: 'gym-admin-pass-1', name: 'Sam Rivera', role: 'admin' },
] as const;
type Account = (typeof GYM_ACCOUNTS)[number];
type Role = Account["role"];
const ROLES: Role[] = ["recruiter", "hiring_manager", "admin"];
const ROLE_LABELS: Record<Role, string> = { recruiter: "Recruiter", hiring_manager: "Hiring manager", admin: "Admin" };

type On = (id: string) => boolean;
type Ctx = { on: On; thirdParty?: string; liveKey: boolean; captcha: boolean; account?: Account };
type Config = { defects: Set<string>; login: boolean; thirdParty?: string; liveKey: boolean; captcha: boolean; candidatesDelayMs: number };
type Job = {
  id: number;
  title: string;
  department: string;
  type: string;
  location: string;
  description: string;
  hiringManager: string;
  status: "Live" | "Draft";
};
type JobForm = Omit<Job, "id" | "status">;
type FormErrors = { title?: string; department?: string; hiringManager?: string };
type User = { name: string; email: string; role: Role; status: "Active" | "Invited" };
type Resume = { heading: string; lines: string[] }[];
type Candidate = { id: number; name: string; job: string; resume: Resume; feedback: string[]; decision?: "Advance" | "Reject" };

const SEED: Job[] = [
  { id: 1, title: "Senior Backend Engineer", department: "Engineering", type: "Full-time", location: "Remote (EU)", description: "Own the services behind our applicant pipeline.", hiringManager: "Dana Okafor", status: "Live" },
  { id: 2, title: "Product Designer", department: "Design", type: "Full-time", location: "London", description: "Shape the hiring manager experience end to end.", hiringManager: "Dana Okafor", status: "Live" },
  { id: 3, title: "Account Executive", department: "Sales", type: "Full-time", location: "New York", description: "Bring new customers onto the platform.", hiringManager: "", status: "Draft" },
];
const BLANK: JobForm = { title: "", department: "", type: "Full-time", location: "", description: "", hiringManager: "" };

const CANDIDATES: Omit<Candidate, "feedback">[] = [
  {
    id: 1,
    name: "Mateo Alvarez",
    job: "Senior Backend Engineer",
    resume: [
      { heading: "Summary", lines: [
        "Backend engineer with nine years building payment and scheduling systems. I like owning services end to end: schema design, the on-call rotation, and the dashboards that show whether a change worked.",
        "Most recently a staff engineer at a payments company, where I led the move from a monolith to event-driven services.",
      ] },
      { heading: "Experience", lines: [
        "Staff Engineer, Ledgerline (2021 to 2026)",
        "Led the migration of a 14-service payments monolith to event-driven services, cutting median settlement time from 52 minutes to 6.",
        "Designed the idempotency layer for webhook delivery, removing duplicate charges across three regions during peak load.",
        "Mentored five engineers through their first on-call rotations and wrote the runbooks the team still uses.",
        "Introduced consumer-driven contract tests between internal services, which roughly halved integration failures in staging.",
        "Owned the Postgres fleet: partitioning strategy, vacuum tuning and a quarterly restore drill that found two backup gaps.",
        "Senior Backend Engineer, Parcelwise (2018 to 2021)",
        "Built the routing service that assigns courier jobs across 40 cities, handling about two million assignments a day.",
        "Replaced a nightly batch job with a streaming pipeline, so delivery estimates update within seconds instead of hours.",
        "Added structured logging and distributed tracing across the fleet; an incident that used to take a week to diagnose took an afternoon.",
        "Ran the weekly architecture review and kept the decision log that onboarded new hires for three years.",
        "Backend Engineer, Brightpath Health (2015 to 2018)",
        "Built HL7 and FHIR integrations with eleven clinical systems, with no data-loss incidents reported in production.",
        "Wrote the scheduling API used by roughly 300 clinics, including timezone handling that clinics had been patching by hand.",
        "Set up the team's first CI pipeline, turning a half-day manual release into a single approval step.",
        "Software Engineer, Tallyhouse (2013 to 2015)",
        "Shipped features across a Rails monolith, including the invoice export that became the most requested feature of 2014.",
        "Wrote the first automated test suite for billing, which caught a rounding bug before it reached a customer.",
      ] },
      { heading: "Education", lines: [
        "BSc Computer Science, University of Valencia (2013)",
        "Certificate in Distributed Systems, online (2019)",
      ] },
      { heading: "Skills", lines: [
        "Go, Python, TypeScript, PostgreSQL, Kafka, Kubernetes, Terraform, OpenTelemetry, incident response, technical mentoring.",
      ] },
      { heading: "Projects and talks", lines: [
        "Maintainer of a small open-source rate limiter used by several Node.js services.",
        "Spoke at two regional meetups on event sourcing and the trade-offs of exactly-once delivery.",
        "Wrote an internal guide to database migrations that the wider engineering organization adopted in 2024.",
        "Co-runs a monthly backend reading group with about 60 members across Valencia and Madrid, mostly on reliability papers and postmortems.",
        "Reviews design documents for two engineering communities, focusing on failure modes and rollback plans rather than naming.",
      ] },
    ],
  },
  {
    id: 2,
    name: "Jun Park",
    job: "Product Designer",
    resume: [
      { heading: "Summary", lines: [
        "Product designer with seven years across B2B software, mostly in hiring and workforce tools. I work closely with engineers and recruiters, and I look for the moments where a tool slows people down.",
        "I lead research on the hiring manager workflow and run usability sessions every sprint.",
        "I am most useful early in a project, when the problem is still fuzzy and a prototype can settle an argument faster than a meeting.",
      ] },
      { heading: "Experience", lines: [
        "Lead Product Designer, Crewmark (2022 to 2026)",
        "Redesigned the interview scheduling flow from six screens to two, which cut scheduling errors by about 40 percent.",
        "Ran monthly usability sessions with recruiters and hiring managers and turned the findings into a public design backlog.",
        "Built and maintained the component library used by four product teams, with accessibility checks running in CI.",
        "Mentored three designers and set up the critique format the design team still runs every Thursday.",
        "Partnered with recruiting operations to design an offer approval flow that cut average approval time from nine days to three, with the rules documented in the component library.",
        "Ran a quarterly survey of hiring managers on tool satisfaction and used the results to set the team roadmap for two years.",
        "Led accessibility audits of the candidate portal with an external consultant, resolving 31 of 34 findings before launch.",
        "Product Designer, Talentframe (2019 to 2022)",
        "Designed the candidate pipeline board, which became the most used screen in the product within a quarter of launch.",
        "Worked with data analysts to define funnel metrics, so design decisions could be checked against real drop-off numbers.",
        "Prototyped offline-friendly interview kits for field recruiting teams in three countries.",
        "Redesigned the interviewer feedback form after research showed most notes were written after the candidate had left the room, which moved note-taking into the call.",
        "Created a shared glossary of hiring stage names with the product manager, which ended a long-running argument about what counted as a screen.",
        "Interaction Designer, Pixelvale (2016 to 2019)",
        "Shipped marketing sites and product onboarding for consumer and enterprise clients across six industries.",
        "Designed onboarding for a payments client, including a plain-language explainer for verification steps that reduced support tickets in its first month.",
        "Introduced design tokens to a team of four, which removed most of the handoff questions in the first sprint.",
      ] },
      { heading: "Education", lines: [
        "BA Visual Communication, Escola Massana, Barcelona (2016)",
        "Certificate in Inclusive Design, online (2020)",
      ] },
      { heading: "Skills", lines: [
        "Figma, prototyping, user research, accessibility (WCAG 2.2), design systems, usability testing, workshop facilitation, design tokens.",
      ] },
      { heading: "Projects and talks", lines: [
        "Volunteer designer on a food bank's volunteer scheduling tool, used by about 80 volunteers each week.",
        "Spoke at a regional design meetup about writing for interfaces and microcopy.",
        "Co-wrote a short guide to designing hiring tools that work well with screen readers.",
        "Co-organizes a monthly design critique for local freelancers, with about 40 regular attendees.",
        "Contributed translations and alt-text reviews to an open-source recruiting toolkit used by nonprofits.",
      ] },
    ],
  },
];

export async function startGym(opts: {
  port?: number;
  defects?: string;
  login?: boolean;
  thirdParty?: string;
  liveKey?: boolean;
  captcha?: boolean;
  candidatesDelayMs?: number; // test-only: shortens the D09 delay, which defaults to 4 s
} = {}): Promise<{ url: string; close(): Promise<void> }> {
  const app = createApp({
    defects: parseDefects(opts.defects ?? "all"),
    login: opts.login ?? false,
    thirdParty: opts.thirdParty ? new URL(opts.thirdParty).origin : undefined,
    liveKey: opts.liveKey ?? false,
    captcha: opts.captcha ?? false,
    candidatesDelayMs: opts.candidatesDelayMs ?? 4000,
  });
  const server = createServer((req, res) => {
    // A client that aborts mid-body rejects readBody; drop that socket instead of crashing the process.
    app(req, res).catch((err) => {
      console.error(err);
      res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: the test hooks and fixture accounts are not for the LAN.
    server.listen(opts.port ?? 4317, "localhost", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function parseDefects(spec: string): Set<string> {
  if (spec === "all") return new Set(DEFECT_IDS);
  if (spec === "none") return new Set();
  const ids = spec.split(",").map((id) => id.trim()).filter(Boolean);
  const unknown = ids.find((id) => !DEFECT_IDS.includes(id));
  if (unknown) throw new Error(`Unknown defect ${unknown}`);
  return new Set(ids);
}

function seedStore() {
  return {
    jobs: SEED.map((j) => ({ ...j })),
    users: GYM_ACCOUNTS.map((a): User => ({ name: a.name, email: a.email, role: a.role, status: "Active" })),
    candidates: CANDIDATES.map((x): Candidate => ({ ...x, feedback: [] })),
    approvals: false,
  };
}
type Store = ReturnType<typeof seedStore>;

function createApp(config: Config) {
  const store = seedStore();
  // shortcut: sessions never expire on a clock (/__sessions/expire stands in), add one if a test needs real timeouts.
  const sessions = new Map<string, Account>();
  const base = {
    on: (id: string) => config.defects.has(id),
    thirdParty: config.thirdParty,
    liveKey: config.liveKey,
    captcha: config.captcha,
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const post = req.method === "POST";
    const token = req.headers.cookie?.match(/(?:^|;\s*)gym_session=([0-9a-f]+)/)?.[1];
    const account = token ? sessions.get(token) : undefined;
    const c: Ctx = { ...base, account };

    // shortcut: test hooks are unauthenticated, safe only while bound to loopback; add a token before any other bind.
    if (post && path === "/__reset") {
      Object.assign(store, seedStore());
      res.writeHead(204).end();
      return;
    }
    if (post && path === "/__sessions/expire") {
      sessions.clear();
      res.writeHead(204).end();
      return;
    }

    if (config.login && path === "/login") {
      if (!post) return send(res, 200, loginPage(c, "", safeNext(url.searchParams.get("next"))));
      const form = new URLSearchParams(await readBody(req));
      const email = (form.get("email") ?? "").trim();
      const next = safeNext(form.get("next"));
      // shortcut: demo passwords are plain constants compared directly, hash them before any real account exists.
      const match = GYM_ACCOUNTS.find((a) => a.email === email && a.password === form.get("password"));
      if (!match) return send(res, 200, loginPage(c, email, next, "Wrong email or password"));
      const sid = randomBytes(16).toString("hex");
      sessions.set(sid, match);
      // D11 (defect): hiring managers land on the dashboard and next is ignored.
      const dest = c.on("D11") && match.role === "hiring_manager" ? "/" : next;
      return redirect(res, dest, `gym_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
    }
    // Sign-out needs no session: it clears whatever cookie is there.
    if (config.login && post && path === "/logout") {
      if (token) sessions.delete(token);
      return redirect(res, "/login", "gym_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    }
    // shortcut: roles only shape the nav; any signed-in user can open any URL, add route guards when a test needs them.
    if (config.login && !account && !path.startsWith("/__") && path !== "/logout") {
      return redirect(res, `/login?${new URLSearchParams({ next: path + url.search })}`);
    }

    if (post && path === "/jobs") {
      const form = new URLSearchParams(await readBody(req));
      const field = (name: string) => (form.get(name) ?? "").trim();
      const type = field("type");
      const values: JobForm = {
        title: field("title"),
        department: field("department"),
        type: EMPLOYMENT_TYPES.includes(type) ? type : "Full-time",
        location: field("location"),
        description: field("description"),
        hiringManager: field("hiring_manager"),
      };
      const errors: FormErrors = {};
      if (!values.title) errors.title = "Enter a job title";
      if (!DEPARTMENTS.includes(values.department)) errors.department = "Choose a department";
      if (values.hiringManager && !hasUserNamed(store.users, values.hiringManager)) errors.hiringManager = "No user found";
      if (field("intent") === "invite" && errors.hiringManager) {
        // The invite only adds the person; the draft is re-rendered as typed.
        store.users.push({ name: values.hiringManager, email: "", role: "hiring_manager", status: "Invited" });
        delete errors.hiringManager;
        return send(res, 200, jobFormPage(c, values, errors, `Invitation sent to ${values.hiringManager}`));
      }
      if (errors.title || errors.department || errors.hiringManager) return send(res, 200, jobFormPage(c, values, errors));
      const job: Job = {
        ...values,
        // D07 (defect): the description is silently cut to 200 characters on save.
        description: c.on("D07") ? values.description.slice(0, 200) : values.description,
        id: store.jobs.length + 1,
        status: "Live",
      };
      store.jobs.push(job);
      // The banner rides on the redirect so the job page needs no session state.
      res.writeHead(303, { location: `/jobs/${job.id}?published=1` }).end();
      return;
    }

    if (post && path === "/settings/users") {
      const form = new URLSearchParams(await readBody(req));
      const email = (form.get("email") ?? "").trim();
      const role = ROLES.find((r) => r === form.get("role")) ?? "recruiter";
      if (!EMAIL.test(email)) return send(res, 200, usersPage(c, store.users, { email, role, error: "Enter an email address" }));
      if (store.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
        // D08 (defect): an existing email gets a generic error instead of a clear one.
        const error = c.on("D08") ? "Something went wrong" : `${email} is already a user`;
        return send(res, 200, usersPage(c, store.users, { email, role, error }));
      }
      store.users.push({ name: "", email, role, status: "Invited" });
      return send(res, 200, usersPage(c, store.users, { email: "", role: "recruiter", notice: `Invitation sent to ${email}` }));
    }

    if (post && path === "/settings/approvals") {
      const form = new URLSearchParams(await readBody(req));
      store.approvals = form.has("approval");
      return send(res, 200, approvalsPage(c, store.approvals, "Approval settings saved"));
    }

    const reviewMatch = /^\/reviews\/(\d+)$/.exec(path);
    const candidate = reviewMatch ? store.candidates.find((x) => x.id === Number(reviewMatch[1])) : undefined;
    if (candidate && post) {
      const form = new URLSearchParams(await readBody(req));
      const decision = form.get("decision");
      const feedback = (form.get("feedback") ?? "").trim();
      if (decision === "advance" || decision === "reject") {
        candidate.decision = decision === "advance" ? "Advance" : "Reject";
        return send(res, 200, reviewPage(c, candidate, `Decision recorded: ${candidate.decision}`));
      }
      if (!feedback) return send(res, 200, reviewPage(c, candidate, undefined, "Write some feedback before sending"));
      candidate.feedback.push(feedback);
      return send(res, 200, reviewPage(c, candidate, "Feedback sent"));
    }

    const jobMatch = /^\/jobs\/(\d+)$/.exec(path);
    const found = jobMatch ? store.jobs.find((j) => j.id === Number(jobMatch[1])) : undefined;
    if (path === "/") return send(res, 200, dashboardPage(c, store));
    if (path === "/jobs") return send(res, 200, jobsPage(c, store.jobs));
    if (path === "/jobs/new") return send(res, 200, jobFormPage(c, BLANK, {}));
    if (path === "/reviews") return send(res, 200, reviewsPage(c, pendingReviews(store)));
    if (candidate) return send(res, 200, reviewPage(c, candidate));
    if (path === "/candidates") {
      // D09 (defect): the candidates page answers after a delay with no loading state.
      if (c.on("D09")) await new Promise((resolve) => setTimeout(resolve, config.candidatesDelayMs));
      return send(res, 200, candidatesPage(c));
    }
    if (path === "/settings") return send(res, 200, settingsPage(c));
    if (path === "/settings/users") return send(res, 200, usersPage(c, store.users, { email: "", role: "recruiter" }));
    if (path === "/settings/approvals") return send(res, 200, approvalsPage(c, store.approvals));
    if (path === "/billing") return send(res, 200, billingPage(c));
    if (path === "/locale") return send(res, 200, localePage(c, req.headers["accept-language"] ?? "Not sent"));
    if (found) return send(res, 200, jobPage(c, found, url.searchParams.has("published")));
    send(res, 404, notFoundPage(c));
  };
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res: ServerResponse, location: string, setCookie?: string): void {
  res.writeHead(303, setCookie ? { location, "set-cookie": setCookie } : { location });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  req.setEncoding("utf8");
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

// Same-site paths only: a lone leading slash, no backslash or control characters (browsers strip tabs and newlines, so "/\t/evil" would become "//evil").
const safeNext = (next: string | null): string => (next && /^\/(?![\/\\])[\x20-\x7e]*$/.test(next) ? next : "/");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const options = (items: string[], selected: string) =>
  items.map((item) => `<option value="${esc(item)}"${item === selected ? " selected" : ""}>${esc(item)}</option>`).join("");
const badge = (status: Job["status"]) => `<span class="badge${status === "Live" ? " live" : ""}">${status}</span>`;
const banner = (message: string) => `<p class="banner" role="status">${esc(message)}</p>`;
const pendingReviews = (store: Store) => store.candidates.filter((x) => !x.decision);
const hasUserNamed = (users: User[], name: string) =>
  users.some((u) => u.name !== "" && u.name.toLowerCase() === name.toLowerCase());

function navLinks(c: Ctx): [string, string, string][] {
  if (c.account?.role === "hiring_manager") return [["dashboard", "Dashboard", "/"], ["reviews", "Reviews", "/reviews"]];
  return [
    ["dashboard", "Dashboard", "/"],
    ["jobs", "Jobs", c.on("D03") ? "/job" : "/jobs"],
    ["candidates", "Candidates", "/candidates"],
    ["settings", "Settings", "/settings"],
  ];
}

function layout(c: Ctx, section: string, title: string, body: string): string {
  const link = (key: string, label: string, href: string) =>
    `<a href="${href}"${key === section ? ' aria-current="page"' : ""}>${label}</a>`;
  const nav = navLinks(c).map(([key, label, href]) => link(key, label, href)).join("\n");
  const session = c.account
    ? `<div class="session"><span>Signed in as ${esc(c.account.name)} · ${ROLE_LABELS[c.account.role]}</span><form method="post" action="/logout"><button class="btn secondary" type="submit">Sign out</button></form></div>`
    : "";
  const analytics = c.thirdParty ? `<script async src="${esc(c.thirdParty)}/analytics.js"></script>` : "";
  const beacon = c.thirdParty ? `<img src="${esc(c.thirdParty)}/pixel.gif" alt="" width="1" height="1">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Gym ATS</title>
<link rel="icon" href="data:,">
<style>${CSS}</style>
${analytics}
</head>
<body>
<header class="topbar">
<span class="brand">Gym ATS</span>
<nav aria-label="Main">
${nav}
</nav>
${session}
</header>
<main>
${body}
</main>
${beacon}
</body>
</html>`;
}

function loginPage(c: Ctx, email: string, next: string, error?: string): string {
  const invalid = error ? ' aria-invalid="true" aria-describedby="login-error"' : "";
  return layout(c, "", "Sign in", `
<h1>Sign in</h1>
<form class="card" method="post" action="/login" novalidate>
<input type="hidden" name="next" value="${esc(next)}">
<div class="field">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" value="${esc(email)}"${invalid}>
</div>
<div class="field">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password"${invalid}>
</div>
${error ? `<p class="error" id="login-error">${error}</p>` : ""}
<div class="actions"><button class="btn primary" type="submit">Sign in</button></div>
</form>`);
}

function dashboardPage(c: Ctx, store: Store): string {
  const live = store.jobs.filter((j) => j.status === "Live");
  return layout(c, "dashboard", "Dashboard", `
<h1>Dashboard</h1>
<div class="stats">
<div class="card"><p class="stat-label">Live jobs</p><p class="stat-value">${live.length}</p></div>
<div class="card"><p class="stat-label">Draft jobs</p><p class="stat-value">${store.jobs.length - live.length}</p></div>
<div class="card"><p class="stat-label">Total jobs</p><p class="stat-value">${store.jobs.length}</p></div>
</div>
<section class="card" aria-labelledby="review-heading">
<h2 id="review-heading"><a href="/reviews">Awaiting your review (${pendingReviews(store).length})</a></h2>
</section>
<section class="card" aria-labelledby="open-jobs">
<div class="page-head"><h2 id="open-jobs">Open jobs</h2><a href="/jobs">View all jobs</a></div>
<ul>${live.map((j) => `<li><a href="/jobs/${j.id}">${esc(j.title)}</a> · ${esc(j.department)}</li>`).join("")}</ul>
</section>`);
}

function jobsPage(c: Ctx, jobs: Job[]): string {
  const rows = jobs
    .map((j) => `<tr><td><a href="/jobs/${j.id}">${esc(j.title)}</a></td><td>${esc(j.department)}</td><td>${badge(j.status)}</td></tr>`)
    .join("");
  return layout(c, "jobs", "Jobs", `
<div class="page-head"><h1>Jobs</h1><a class="btn primary" href="/jobs/new">Create job</a></div>
<table>
<thead><tr><th scope="col">Title</th><th scope="col">Department</th><th scope="col">Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>`);
}

function jobFormPage(c: Ctx, v: JobForm, errors: FormErrors, notice?: string): string {
  const hint = c.on("D10") ? "#c8c8c8" : "#5b6475";
  const deptError = c.on("D02") ? undefined : errors.department;
  // D04 (defect): an unknown hiring manager links away to the users page, losing the draft.
  const invite = errors.hiringManager
    ? c.on("D04")
      ? '<a href="/settings/users">Invite user</a>'
      : `<button class="btn secondary" type="submit" form="invite-form">Invite ${esc(v.hiringManager)}</button>`
    : "";
  // Its own form, so Enter in a field still publishes rather than invites (the default button is the first submit in the form).
  const inviteForm = errors.hiringManager && !c.on("D04")
    ? `<form id="invite-form" method="post" action="/jobs" hidden>${[
        ["title", v.title], ["location", v.location], ["type", v.type],
        ["description", v.description], ["department", v.department], ["hiring_manager", v.hiringManager],
      ].map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join("")}<input type="hidden" name="intent" value="invite"></form>`
    : "";
  return layout(c, "jobs", "Create job", `
${notice ? banner(notice) : ""}
<h1>Create job</h1>
<form class="card" method="post" action="/jobs">
<div class="field">
<label for="title">Job title *</label>
<input id="title" name="title" type="text" value="${esc(v.title)}"${errors.title ? ' aria-invalid="true" aria-describedby="title-error"' : ""}>
${errors.title ? `<p class="error" id="title-error">${errors.title}</p>` : ""}
</div>
<div class="field">
<label for="location">Location</label>
<input id="location" name="location" type="text" value="${esc(v.location)}">
</div>
<div class="field">
<label for="type">Employment type</label>
<select id="type" name="type">${options(EMPLOYMENT_TYPES, v.type)}</select>
</div>
<div class="field">
<label for="description">Description</label>
<textarea id="description" name="description" rows="6"${c.on("D07") ? "" : ' aria-describedby="description-hint"'}>${esc(v.description)}</textarea>
${c.on("D07") ? "" : `<p class="hint" id="description-hint" style="color: ${hint}">Up to 2,000 characters</p>`}
</div>
<div class="field">
<label for="department">${c.on("D02") ? "Department" : "Department *"}</label>
<select id="department" name="department"${deptError ? ' aria-invalid="true" aria-describedby="department-error"' : ""}>
<option value="">Select…</option>${options(DEPARTMENTS, v.department)}
</select>
${deptError ? `<p class="error" id="department-error">${deptError}</p>` : ""}
</div>
<div class="field">
<label for="hiring_manager">Hiring manager</label>
<input id="hiring_manager" name="hiring_manager" type="text" value="${esc(v.hiringManager)}"${errors.hiringManager ? ' aria-invalid="true" aria-describedby="hiring-manager-error"' : ' aria-describedby="hiring-manager-hint"'}>
${errors.hiringManager ? `<p class="error" id="hiring-manager-error">${errors.hiringManager}</p>${invite}` : ""}
<p class="hint" id="hiring-manager-hint" style="color: ${hint}">Must match an existing user's name</p>
</div>
<div class="actions">
<button class="btn primary" type="submit" name="intent" value="publish">${c.on("D01") ? "Save draft" : "Publish job"}</button>
<a class="btn secondary" href="/jobs">Cancel</a>
</div>
</form>
${inviteForm}`);
}

function jobPage(c: Ctx, job: Job, published: boolean): string {
  const facts = [job.department, job.type, job.location, job.hiringManager && `Hiring manager: ${job.hiringManager}`]
    .filter(Boolean)
    .map((s) => esc(s))
    .join(" · ");
  return layout(c, "jobs", job.title, `
${published ? '<p class="banner" role="status">Job published</p>' : ""}
<div class="page-head"><h1>${esc(job.title)}</h1>${badge(job.status)}</div>
<p>${facts}</p>
<section class="card"><h2>Description</h2><p class="description">${esc(job.description)}</p></section>
<p><a href="/jobs">Back to jobs</a></p>`);
}

function placeholderPage(c: Ctx, section: string, title: string, text: string): string {
  return layout(c, section, title, `<h1>${title}</h1>\n<section class="card"><p>${text}</p></section>`);
}

function candidatesPage(c: Ctx): string {
  if (!c.captcha) return placeholderPage(c, "candidates", "Candidates", "Candidate pipelines arrive in a later release.");
  return layout(c, "candidates", "Verify you are human", `
<h1>Verify you are human</h1>
<section class="card"><p>Complete the check to continue</p><div class="g-recaptcha" data-sitekey="6LeGYMFAKEsitekey"></div></section>`);
}

function reviewsPage(c: Ctx, pending: Candidate[]): string {
  const items = pending.map((x) => `<li><a href="/reviews/${x.id}">${esc(x.name)}</a> · ${esc(x.job)}</li>`).join("");
  return layout(c, "reviews", "Reviews", `
<h1>Reviews</h1>
<section class="card" aria-labelledby="queue-heading">
<h2 id="queue-heading">Awaiting your review</h2>
<ul>${items}</ul>
</section>`);
}

function reviewPage(c: Ctx, cand: Candidate, notice?: string, error?: string): string {
  const icons = c.on("D06");
  // D05 (defect): on narrow screens the actions are pushed below the tall resume.
  const narrow = c.on("D05") ? "<style>@media (max-width: 599px) { .review-actions { order: 1; } }</style>" : "";
  const resume = cand.resume.map((s) => `<h3>${esc(s.heading)}</h3>${s.lines.map((l) => `<p>${esc(l)}</p>`).join("")}`).join("");
  return layout(c, "reviews", cand.name, `
${notice ? banner(notice) : ""}
<div class="page-head"><h1>${esc(cand.name)}</h1><span class="badge">${esc(cand.job)}</span></div>
${cand.decision ? `<p>Decision: ${cand.decision}</p>` : ""}
${narrow}
<div class="review">
<section class="card review-actions" aria-labelledby="decision-heading">
<h2 id="decision-heading">Decision</h2>
<form method="post" action="/reviews/${cand.id}">
<button class="btn primary" type="submit" name="decision" value="advance">${icons ? "✓" : "Advance"}</button>
<button class="btn secondary" type="submit" name="decision" value="reject">${icons ? "✕" : "Reject"}</button>
</form>
<form method="post" action="/reviews/${cand.id}">
<h2>Leave feedback</h2>
<div class="field">
<label for="feedback">Feedback</label>
<textarea id="feedback" name="feedback" rows="4"${error ? ' aria-invalid="true" aria-describedby="feedback-error"' : ""}></textarea>
${error ? `<p class="error" id="feedback-error">${esc(error)}</p>` : ""}
</div>
<button class="btn primary" type="submit">Send feedback</button>
</form>
</section>
<article class="card resume" aria-label="Resume">${resume}</article>
</div>`);
}

function usersPage(c: Ctx, users: User[], form: { email: string; role: Role; notice?: string; error?: string }): string {
  const rows = users
    .map((u) => `<tr><td>${u.name ? esc(u.name) : "—"}</td><td>${u.email ? esc(u.email) : "—"}</td><td>${ROLE_LABELS[u.role]}</td><td>${u.status}</td></tr>`)
    .join("");
  const roles = ROLES.map((r) => `<option value="${r}"${r === form.role ? " selected" : ""}>${ROLE_LABELS[r]}</option>`).join("");
  return layout(c, "settings", "Users", `
${form.notice ? banner(form.notice) : ""}
<h1>Users</h1>
<table>
<thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<section class="card" aria-labelledby="invite-heading">
<h2 id="invite-heading">Invite user</h2>
<form method="post" action="/settings/users">
<div class="field">
<label for="invite-email">Email</label>
<input id="invite-email" name="email" type="email" value="${esc(form.email)}"${form.error ? ' aria-invalid="true" aria-describedby="invite-error"' : ""}>
${form.error ? `<p class="error" id="invite-error">${esc(form.error)}</p>` : ""}
</div>
<div class="field">
<label for="invite-role">Role</label>
<select id="invite-role" name="role">${roles}</select>
</div>
<button class="btn primary" type="submit">Send invitation</button>
</form>
</section>`);
}

function approvalsPage(c: Ctx, approvals: boolean, notice?: string): string {
  const label = c.on("D12") ? "Disable approval bypass" : "Require approval before a job goes live";
  return layout(c, "settings", "Approvals", `
${notice ? banner(notice) : ""}
<h1>Approvals</h1>
<form class="card" method="post" action="/settings/approvals">
<div class="field check">
<input id="approval" name="approval" type="checkbox" value="on"${approvals ? " checked" : ""}>
<label for="approval">${label}</label>
</div>
<button class="btn primary" type="submit">Save</button>
</form>`);
}

function settingsPage(c: Ctx): string {
  return layout(c, "settings", "Settings", `
<h1>Settings</h1>
<section class="card">
<p>Account and team settings arrive in a later release.</p>
<ul>
<li><a href="/settings/users">Users</a></li>
<li><a href="/settings/approvals">Approvals</a></li>
<li><a href="/billing">Billing</a></li>
<li><a href="/locale">Locale echo</a></li>
</ul>
</section>`);
}

function localePage(c: Ctx, acceptLanguage: string): string {
  return layout(c, "settings", "Locale echo", `
<h1>Locale echo</h1>
<section class="card" aria-label="Browser environment">
<p>This page shows the language sent to the server and the settings exposed by this browser.</p>
<p id="locale-http-language">Accept-Language: ${esc(acceptLanguage)}</p>
<p id="locale-language">Browser locale: Waiting for JavaScript</p>
<p id="locale-languages">Browser languages: Waiting for JavaScript</p>
<p id="locale-timezone">Browser timezone: Waiting for JavaScript</p>
</section>
<script>
document.getElementById("locale-language").textContent = "Browser locale: " + navigator.language;
document.getElementById("locale-languages").textContent = "Browser languages: " + navigator.languages.join(", ");
document.getElementById("locale-timezone").textContent = "Browser timezone: " + Intl.DateTimeFormat().resolvedOptions().timeZone;
</script>`);
}

function billingPage(c: Ctx): string {
  // Assembled at runtime so the source never contains a literal live-key prefix.
  const key = ["pk", c.liveKey ? "live" : "test", ""].join("_") + "GYMFAKE0123456789abcdef";
  return layout(c, "settings", "Billing", `
<h1>Billing</h1>
<section class="card"><h2>Plan</h2><p>Team plan, up to 25 seats, billed monthly.</p></section>
<script>window.GYM_STRIPE_KEY = "${key}";</script>`);
}

const notFoundPage = (c: Ctx) =>
  layout(c, "", "Page not found", `
<h1>Page not found</h1>
<section class="card"><p>The page you were looking for does not exist.</p><p><a href="/">Back to dashboard</a></p></section>`);

const CSS = `
:root { --ink: #1d2433; --muted: #5b6475; --line: #e3e6ec; --brand: #3b4cca; --bg: #f6f7fb; --ok: #1f7a4d; --ok-bg: #e6f6ee; --err: #b42318; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
.topbar { display: flex; align-items: center; gap: 32px; height: 56px; padding: 0 24px; background: #fff; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; }
nav { display: flex; gap: 20px; }
nav a { color: var(--muted); text-decoration: none; }
nav a[aria-current="page"] { color: var(--brand); font-weight: 600; }
.session { margin-left: auto; display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 14px; }
.session form { margin: 0; }
main { max-width: 960px; margin: 32px auto; padding: 0 16px; }
h1 { font-size: 24px; margin: 0 0 16px; }
h2 { font-size: 18px; margin: 0; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.page-head h1, .page-head h2 { margin: 0; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 20px; margin-bottom: 16px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 16px; }
.stats .card { margin: 0; }
.stat-label { margin: 0; color: var(--muted); }
.stat-value { margin: 0; font-size: 28px; font-weight: 700; }
ul { padding-left: 20px; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); margin-bottom: 16px; }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-size: 13px; font-weight: 600; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 13px; background: #eceef3; color: var(--muted); }
.badge.live { background: var(--ok-bg); color: var(--ok); }
.banner { margin: 0 0 16px; padding: 12px 16px; border-radius: 6px; background: var(--ok-bg); color: var(--ok); font-weight: 600; }
.field { margin-bottom: 16px; }
label { display: block; margin-bottom: 4px; font-weight: 600; }
input, select, textarea { width: 100%; max-width: 420px; padding: 8px 10px; font: inherit; color: inherit; background: #fff; border: 1px solid #c9ced8; border-radius: 6px; }
textarea { max-width: none; }
[aria-invalid="true"] { border-color: var(--err); }
.error { margin: 4px 0 0; color: var(--err); font-size: 14px; }
.hint { margin: 4px 0 0; font-size: 13px; }
.check { display: flex; align-items: center; gap: 8px; }
.check input { width: auto; max-width: none; }
.actions { display: flex; align-items: center; gap: 12px; }
.btn { display: inline-block; padding: 8px 14px; border: 1px solid transparent; border-radius: 6px; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
.btn.primary { background: var(--brand); color: #fff; }
.btn.secondary { background: #fff; color: var(--ink); border-color: var(--line); }
.description { white-space: pre-line; }
.review { display: grid; gap: 16px; }
.review-actions form { margin-bottom: 16px; }
.review-actions form:last-child { margin-bottom: 0; }
.resume h3 { font-size: 16px; margin: 20px 0 8px; }
.resume h3:first-child { margin-top: 0; }
.resume p { margin: 0 0 8px; }
@media (min-width: 600px) {
  .review { grid-template-columns: minmax(0, 1fr) 280px; align-items: start; }
  .review-actions { grid-column: 2; grid-row: 1; }
  .resume { grid-column: 1; grid-row: 1; }
}
`;

if (import.meta.main) {
  const gym = await startGym({
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    defects: process.env.GYM_DEFECTS || undefined,
    login: process.env.GYM_LOGIN === "1",
    thirdParty: process.env.GYM_THIRD_PARTY || undefined,
    liveKey: process.env.GYM_LIVE_KEY === "1",
    captcha: process.env.GYM_CAPTCHA === "1",
  });
  console.log(`Gym ATS running at ${gym.url}`);
}
