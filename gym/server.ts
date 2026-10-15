// Gym ATS, a seeded-defect demo app Gnomi is measured against (catalogue: gym/defects.yaml). No dependencies.
// startGym({ port, defects, login, thirdParty, liveKey, captcha }): port defaults to 4317 (0 = any free port); the other options default off. Env: PORT, GYM_DEFECTS, GYM_LOGIN=1, GYM_THIRD_PARTY, GYM_LIVE_KEY=1, GYM_CAPTCHA=1.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const DEFECT_IDS = ["D01", "D02", "D03"];
const DEPARTMENTS = ["Engineering", "Design", "Product", "Sales", "People"];
const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contract", "Internship"];

export const GYM_ACCOUNTS = [
  { email: 'recruiter@gym.test', password: 'gym-recruiter-pass-1', name: 'Priya Natarajan', role: 'recruiter' },
  { email: 'manager@gym.test', password: 'gym-manager-pass-1', name: 'Dana Okafor', role: 'hiring_manager' },
] as const;
type Account = (typeof GYM_ACCOUNTS)[number];
const ROLE_LABELS: Record<Account["role"], string> = { recruiter: "Recruiter", hiring_manager: "Hiring manager" };

type On = (id: string) => boolean;
type Ctx = { on: On; thirdParty?: string; liveKey: boolean; captcha: boolean; account?: Account };
type Config = { defects: Set<string>; login: boolean; thirdParty?: string; liveKey: boolean; captcha: boolean };
type Job = {
  id: number;
  title: string;
  department: string;
  type: string;
  location: string;
  description: string;
  status: "Live" | "Draft";
};
type JobForm = Omit<Job, "id" | "status">;
type FormErrors = { title?: string; department?: string };

const SEED: Job[] = [
  { id: 1, title: "Senior Backend Engineer", department: "Engineering", type: "Full-time", location: "Remote (EU)", description: "Own the services behind our applicant pipeline.", status: "Live" },
  { id: 2, title: "Product Designer", department: "Design", type: "Full-time", location: "London", description: "Shape the hiring manager experience end to end.", status: "Live" },
  { id: 3, title: "Account Executive", department: "Sales", type: "Full-time", location: "New York", description: "Bring new customers onto the platform.", status: "Draft" },
];
const BLANK: JobForm = { title: "", department: "", type: "Full-time", location: "", description: "" };

export async function startGym(opts: {
  port?: number;
  defects?: string;
  login?: boolean;
  thirdParty?: string;
  liveKey?: boolean;
  captcha?: boolean;
} = {}): Promise<{ url: string; close(): Promise<void> }> {
  const app = createApp({
    defects: parseDefects(opts.defects ?? "all"),
    login: opts.login ?? false,
    thirdParty: opts.thirdParty ? new URL(opts.thirdParty).origin : undefined,
    liveKey: opts.liveKey ?? false,
    captcha: opts.captcha ?? false,
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

function createApp(config: Config) {
  const base = {
    on: (id: string) => config.defects.has(id),
    thirdParty: config.thirdParty,
    liveKey: config.liveKey,
    captcha: config.captcha,
  };
  const jobs = [...SEED];
  // shortcut: sessions never expire on a clock (/__sessions/expire stands in), add one if a test needs real timeouts.
  const sessions = new Map<string, Account>();

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const post = req.method === "POST";
    const token = req.headers.cookie?.match(/(?:^|;\s*)gym_session=([0-9a-f]+)/)?.[1];
    const account = token ? sessions.get(token) : undefined;
    const c: Ctx = { ...base, account };

    // shortcut: test hooks are unauthenticated, safe only while bound to loopback; add a token before any other bind.
    if (post && path === "/__reset") {
      jobs.splice(0, jobs.length, ...SEED);
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
      return redirect(res, next, `gym_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
    }
    // Sign-out needs no session: it clears whatever cookie is there.
    if (config.login && post && path === "/logout") {
      if (token) sessions.delete(token);
      return redirect(res, "/login", "gym_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    }
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
      };
      const errors: FormErrors = {};
      if (!values.title) errors.title = "Enter a job title";
      if (!DEPARTMENTS.includes(values.department)) errors.department = "Choose a department";
      if (errors.title || errors.department) return send(res, 200, jobFormPage(c, values, errors));
      const job: Job = { ...values, id: jobs.length + 1, status: "Live" };
      jobs.push(job);
      // The banner rides on the redirect so the job page needs no session state.
      res.writeHead(303, { location: `/jobs/${job.id}?published=1` }).end();
      return;
    }

    const jobMatch = /^\/jobs\/(\d+)$/.exec(path);
    const found = jobMatch ? jobs.find((j) => j.id === Number(jobMatch[1])) : undefined;
    if (path === "/") return send(res, 200, dashboardPage(c, jobs));
    if (path === "/jobs") return send(res, 200, jobsPage(c, jobs));
    if (path === "/jobs/new") return send(res, 200, jobFormPage(c, BLANK, {}));
    if (path === "/candidates") return send(res, 200, candidatesPage(c));
    if (path === "/settings") return send(res, 200, settingsPage(c));
    if (path === "/billing") return send(res, 200, billingPage(c));
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

function layout(c: Ctx, section: string, title: string, body: string): string {
  const link = (key: string, label: string, href: string) =>
    `<a href="${href}"${key === section ? ' aria-current="page"' : ""}>${label}</a>`;
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
${link("dashboard", "Dashboard", "/")}
${link("jobs", "Jobs", c.on("D03") ? "/job" : "/jobs")}
${link("candidates", "Candidates", "/candidates")}
${link("settings", "Settings", "/settings")}
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

function dashboardPage(c: Ctx, jobs: Job[]): string {
  const live = jobs.filter((j) => j.status === "Live");
  return layout(c, "dashboard", "Dashboard", `
<h1>Dashboard</h1>
<div class="stats">
<div class="card"><p class="stat-label">Live jobs</p><p class="stat-value">${live.length}</p></div>
<div class="card"><p class="stat-label">Draft jobs</p><p class="stat-value">${jobs.length - live.length}</p></div>
<div class="card"><p class="stat-label">Total jobs</p><p class="stat-value">${jobs.length}</p></div>
</div>
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

function jobFormPage(c: Ctx, v: JobForm, errors: FormErrors): string {
  const deptError = c.on("D02") ? undefined : errors.department;
  return layout(c, "jobs", "Create job", `
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
<textarea id="description" name="description" rows="6">${esc(v.description)}</textarea>
</div>
<div class="field">
<label for="department">${c.on("D02") ? "Department" : "Department *"}</label>
<select id="department" name="department"${deptError ? ' aria-invalid="true" aria-describedby="department-error"' : ""}>
<option value="">Select…</option>${options(DEPARTMENTS, v.department)}
</select>
${deptError ? `<p class="error" id="department-error">${deptError}</p>` : ""}
</div>
<div class="actions">
<button class="btn primary" type="submit">${c.on("D01") ? "Save draft" : "Publish job"}</button>
<a class="btn secondary" href="/jobs">Cancel</a>
</div>
</form>`);
}

function jobPage(c: Ctx, job: Job, published: boolean): string {
  const facts = [job.department, job.type, job.location].filter(Boolean).map((s) => esc(s)).join(" · ");
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

function settingsPage(c: Ctx): string {
  return layout(c, "settings", "Settings", `
<h1>Settings</h1>
<section class="card"><p>Account and team settings arrive in a later release.</p><p><a href="/billing">Billing</a></p></section>`);
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
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); }
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
.actions { display: flex; align-items: center; gap: 12px; }
.btn { display: inline-block; padding: 8px 14px; border: 1px solid transparent; border-radius: 6px; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
.btn.primary { background: var(--brand); color: #fff; }
.btn.secondary { background: #fff; color: var(--ink); border-color: var(--line); }
.description { white-space: pre-line; }
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
