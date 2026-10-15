import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { DEFECT_IDS, GYM_ACCOUNTS, startGym } from "./server.ts";

const submitLabel = (html: string) => html.match(/<button[^>]*>([^<]*)<\/button>/)?.[1];
const departmentLabel = (html: string) => html.match(/<label for="department">([^<]*)<\/label>/)?.[1];
const jobsNavHref = (html: string) => html.match(/<a href="([^"]*)"[^>]*>Jobs<\/a>/)?.[1];

async function request(url: string, path: string, init?: RequestInit) {
  const res = await fetch(url + path, { redirect: "manual", ...init });
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

const postJob = (url: string, fields: Record<string, string>) =>
  request(url, "/jobs", { method: "POST", body: new URLSearchParams(fields) });

async function withGym(defects: string, run: (url: string) => Promise<void>) {
  const gym = await startGym({ port: 0, defects });
  try {
    await run(gym.url);
  } finally {
    await gym.close();
  }
}

describe("Gym ATS", () => {
  it("all defects: D01, D02 and D03 are visible", () =>
    withGym("all", async (url) => {
      const form = (await request(url, "/jobs/new")).body;
      assert.equal(submitLabel(form), "Save draft"); // D01
      assert.equal(departmentLabel(form), "Department"); // D02
      const href = jobsNavHref((await request(url, "/")).body) ?? "";
      assert.equal(href, "/job"); // D03
      assert.equal((await request(url, href)).status, 404);
      const res = await postJob(url, { title: "Data Engineer", department: "" });
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.body, /Choose a department/);
    }));

  it("no defects: the plain build works end to end", () =>
    withGym("none", async (url) => {
      const form = (await request(url, "/jobs/new")).body;
      assert.equal(submitLabel(form), "Publish job");
      assert.equal(departmentLabel(form), "Department *");
      const href = jobsNavHref((await request(url, "/")).body) ?? "";
      assert.equal(href, "/jobs");
      assert.equal((await request(url, href)).status, 200);
      const res = await postJob(url, { title: "Data Engineer", department: "" });
      assert.equal(res.status, 200);
      assert.match(res.body, /<p class="error" id="department-error">Choose a department<\/p>/);
      assert.match(res.body, /<select id="department"[^>]*aria-invalid="true"[^>]*aria-describedby="department-error"/);
      assert.match(res.body, /value="Data Engineer"/);
    }));

  it("a comma list switches on only the named defects", () =>
    withGym("D01,D03", async (url) => {
      const form = (await request(url, "/jobs/new")).body;
      assert.equal(submitLabel(form), "Save draft");
      assert.equal(departmentLabel(form), "Department *");
      assert.equal(jobsNavHref((await request(url, "/")).body), "/job");
    }));

  for (const defects of ["all", "none"]) {
    it(`${defects}: a valid POST publishes a live job and redirects to it`, () =>
      withGym(defects, async (url) => {
        const created = await postJob(url, {
          title: "Data Engineer",
          department: "Engineering",
          type: "Contract",
          location: "Berlin",
          description: "Build pipelines.",
        });
        assert.equal(created.status, 303);
        assert.match(created.location ?? "", /^\/jobs\/\d+\?published=1$/);
        const page = await request(url, created.location ?? "");
        assert.equal(page.status, 200);
        assert.match(page.body, /Job published/);
        assert.match(page.body, /<span class="badge live">Live<\/span>/);
        assert.match((await request(url, "/jobs")).body, /Data Engineer/);
        assert.match((await request(url, "/")).body, /Data Engineer/);
      }));

    it(`${defects}: a missing job title always shows an error`, () =>
      withGym(defects, async (url) => {
        const res = await postJob(url, { title: "", department: "Design" });
        assert.equal(res.status, 200);
        assert.match(res.body, /<p class="error" id="title-error">Enter a job title<\/p>/);
      }));

    it(`${defects}: unknown paths return 404 with the header and nav`, () =>
      withGym(defects, async (url) => {
        const res = await request(url, "/no-such-page");
        assert.equal(res.status, 404);
        assert.match(res.body, /Page not found/);
        assert.match(res.body, /<nav aria-label="Main">/);
        assert.match(res.body, />Candidates<\/a>/);
      }));
  }

  it("escapes user input in HTML", () =>
    withGym("none", async (url) => {
      const created = await postJob(url, { title: "<img src=x onerror=alert(1)>", department: "Sales" });
      const page = await request(url, created.location ?? "");
      assert.doesNotMatch(page.body, /<img/);
      assert.match(page.body, /&#60;img/);
    }));

  it("rejects unknown defect ids", () => assert.rejects(startGym({ port: 0, defects: "D99" }), /Unknown defect D99/));

  it("defects.yaml has a toggle for each defect", async () => {
    const yaml = await readFile(new URL("./defects.yaml", import.meta.url), "utf8");
    const toggles = [...yaml.matchAll(/^ {2}toggle: (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(toggles, DEFECT_IDS);
  });
});

describe("Gym ATS options", () => {
  const [recruiter, manager] = GYM_ACCOUNTS;
  type Account = (typeof GYM_ACCOUNTS)[number];

  async function withOptions(opts: Parameters<typeof startGym>[0], run: (url: string) => Promise<void>) {
    const gym = await startGym({ port: 0, ...opts });
    try {
      await run(gym.url);
    } finally {
      await gym.close();
    }
  }

  async function visit(url: string, path: string, init: RequestInit & { cookie?: string } = {}) {
    const { cookie, ...rest } = init;
    const res = await fetch(url + path, { redirect: "manual", ...rest, headers: cookie ? { cookie } : undefined });
    return { status: res.status, location: res.headers.get("location"), setCookie: res.headers.get("set-cookie") ?? "", body: await res.text() };
  }

  async function signIn(url: string, account: Account, next = "/") {
    const res = await visit(url, "/login", {
      method: "POST",
      body: new URLSearchParams({ email: account.email, password: account.password, next }),
    });
    return res.setCookie.split(";")[0];
  }

  it("login: every page redirects to sign-in carrying next", () =>
    withOptions({ login: true }, async (url) => {
      assert.equal((await visit(url, "/jobs")).location, "/login?next=%2Fjobs");
      assert.equal((await visit(url, "/jobs?x=1")).location, "/login?next=%2Fjobs%3Fx%3D1");
      for (const path of ["/", "/jobs/new", "/candidates", "/settings", "/billing"]) {
        assert.equal((await visit(url, path)).status, 303, path);
      }
      assert.equal((await visit(url, "/login")).status, 200);
    }));

  it("login: a wrong password says so and never echoes the password", () =>
    withOptions({ login: true }, async (url) => {
      const res = await visit(url, "/login", {
        method: "POST",
        body: new URLSearchParams({ email: recruiter.email, password: "not-the-password-123", next: "/jobs" }),
      });
      assert.equal(res.status, 200);
      assert.match(res.body, /Wrong email or password/);
      assert.match(res.body, /value="recruiter@gym\.test"/);
      assert.doesNotMatch(res.body, /not-the-password-123/);
      assert.doesNotMatch(res.body, /gym-recruiter-pass-1/);
    }));

  it("login: a right login sets an HttpOnly session cookie and redirects to next", () =>
    withOptions({ login: true }, async (url) => {
      const res = await visit(url, "/login", {
        method: "POST",
        body: new URLSearchParams({ email: recruiter.email, password: recruiter.password, next: "/jobs" }),
      });
      assert.equal(res.status, 303);
      assert.equal(res.location, "/jobs");
      assert.match(res.setCookie, /^gym_session=[0-9a-f]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800$/);
    }));

  it("login: absolute, protocol-relative and backslash next values go to /", () =>
    withOptions({ login: true }, async (url) => {
      for (const next of ["https://evil.test", "//evil.test", "/\\evil.test"]) {
        const res = await visit(url, "/login", {
          method: "POST",
          body: new URLSearchParams({ email: recruiter.email, password: recruiter.password, next }),
        });
        assert.equal(res.location, "/", next);
      }
    }));

  it("login: the header shows the signed-in name and role, never the email", () =>
    withOptions({ login: true }, async (url) => {
      const asRecruiter = await visit(url, "/", { cookie: await signIn(url, recruiter) });
      assert.match(asRecruiter.body, /Signed in as Priya Natarajan · Recruiter/);
      assert.match(asRecruiter.body, />Sign out</);
      assert.doesNotMatch(asRecruiter.body, /recruiter@gym\.test/);
      const asManager = await visit(url, "/", { cookie: await signIn(url, manager) });
      assert.match(asManager.body, /Signed in as Dana Okafor · Hiring manager/);
    }));

  it("login: /__sessions/expire signs everyone out", () =>
    withOptions({ login: true }, async (url) => {
      const cookie = await signIn(url, recruiter);
      assert.equal((await visit(url, "/", { cookie })).status, 200);
      assert.equal((await visit(url, "/__sessions/expire", { method: "POST" })).status, 204);
      assert.equal((await visit(url, "/", { cookie })).location, "/login?next=%2F");
    }));

  it("login: sign out forgets the session", () =>
    withOptions({ login: true }, async (url) => {
      const cookie = await signIn(url, manager);
      assert.equal((await visit(url, "/logout", { method: "POST", cookie })).location, "/login");
      assert.equal((await visit(url, "/", { cookie })).location, "/login?next=%2F");
    }));

  it("/__ routes need no session, even with login on", () =>
    withOptions({ login: true }, async (url) => {
      assert.equal((await visit(url, "/__reset", { method: "POST" })).status, 204);
      assert.equal((await visit(url, "/__sessions/expire", { method: "POST" })).status, 204);
      assert.equal((await visit(url, "/")).status, 303);
    }));

  it("/__reset restores the seed jobs and drops created ones", () =>
    withGym("all", async (url) => {
      await visit(url, "/jobs", { method: "POST", body: new URLSearchParams({ title: "Data Engineer", department: "Engineering" }) });
      assert.equal((await visit(url, "/__reset", { method: "POST" })).status, 204);
      const list = (await visit(url, "/jobs")).body;
      assert.doesNotMatch(list, /Data Engineer/);
      assert.match(list, /Senior Backend Engineer/);
      assert.match(list, /Account Executive/);
      assert.equal((await visit(url, "/jobs/4")).status, 404);
    }));

  it("login off: /login is not a route and pages need no session", () =>
    withGym("all", async (url) => {
      assert.equal((await visit(url, "/login")).status, 404);
      assert.equal((await visit(url, "/")).status, 200);
    }));

  it("thirdParty: every page loads the analytics script and pixel only when set", async () => {
    const origin = "http://127.0.0.1:5555";
    await withOptions({ thirdParty: origin }, async (url) => {
      for (const path of ["/", "/nope"]) {
        const body = (await visit(url, path)).body;
        assert.ok(body.includes(`<script async src="${origin}/analytics.js"></script>`), path);
        assert.ok(body.includes(`<img src="${origin}/pixel.gif"`), path);
      }
    });
    await withGym("all", async (url) => {
      assert.doesNotMatch((await visit(url, "/")).body, /analytics\.js|pixel\.gif/);
    });
  });

  it("/billing embeds a live key only when liveKey is on", async () => {
    const live = ["pk", "live", ""].join("_");
    const test = ["pk", "test", ""].join("_");
    await withOptions({ liveKey: true }, async (url) => {
      const body = (await visit(url, "/billing")).body;
      assert.ok(body.includes(`window.GYM_STRIPE_KEY = "${live}`));
      assert.ok(!body.includes(test));
    });
    await withGym("all", async (url) => {
      const body = (await visit(url, "/billing")).body;
      assert.ok(body.includes(`window.GYM_STRIPE_KEY = "${test}`));
      assert.ok(!body.includes(live));
      assert.ok((await visit(url, "/settings")).body.includes('<a href="/billing">Billing</a>'));
    });
  });

  it("captcha: /candidates shows the challenge only when captcha is on", async () => {
    await withOptions({ captcha: true }, async (url) => {
      const body = (await visit(url, "/candidates")).body;
      assert.match(body, /<title>Verify you are human/);
      assert.ok(body.includes('<div class="g-recaptcha" data-sitekey="6LeGYMFAKEsitekey"></div>'));
      assert.match(body, /Complete the check to continue/);
    });
    await withGym("all", async (url) => {
      assert.doesNotMatch((await visit(url, "/candidates")).body, /g-recaptcha|Verify you are human/);
    });
  });

  const admin = GYM_ACCOUNTS[2];
  const navLabels = (body: string) =>
    [...(body.match(/<nav aria-label="Main">([\s\S]*?)<\/nav>/)?.[1] ?? "").matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]);

  it("nav: with login off it is the M0 nav", () =>
    withGym("all", async (url) => {
      assert.deepEqual(navLabels((await visit(url, "/")).body), ["Dashboard", "Jobs", "Candidates", "Settings"]);
    }));

  it("nav: with login on it depends on the role", () =>
    withOptions({ login: true, defects: "none" }, async (url) => {
      const asRecruiter = (await visit(url, "/", { cookie: await signIn(url, recruiter) })).body;
      const asManager = (await visit(url, "/", { cookie: await signIn(url, manager) })).body;
      const asAdmin = (await visit(url, "/", { cookie: await signIn(url, admin) })).body;
      assert.deepEqual(navLabels(asRecruiter), ["Dashboard", "Jobs", "Candidates", "Settings"]);
      assert.deepEqual(navLabels(asManager), ["Dashboard", "Reviews"]);
      assert.deepEqual(navLabels(asAdmin), ["Dashboard", "Jobs", "Candidates", "Settings"]);
    }));

  it("login: the admin account signs in and shows its role", () =>
    withOptions({ login: true, defects: "none" }, async (url) => {
      const page = (await visit(url, "/", { cookie: await signIn(url, admin) })).body;
      assert.match(page, /Signed in as Sam Rivera · Admin/);
    }));

  it("dashboard: the review widget counts candidates awaiting review and links to /reviews", () =>
    withGym("none", async (url) => {
      assert.match((await request(url, "/")).body, /<a href="\/reviews">Awaiting your review \(2\)<\/a>/);
    }));

  it("review flow: queue, candidate page, feedback sent", () =>
    withOptions({ login: true, defects: "none" }, async (url) => {
      const cookie = await signIn(url, manager);
      const queue = (await visit(url, "/reviews", { cookie })).body;
      assert.match(queue, /<a href="\/reviews\/1">Mateo Alvarez<\/a>/);
      assert.match(queue, /<a href="\/reviews\/2">Jun Park<\/a>/);
      assert.match((await visit(url, "/reviews/1", { cookie })).body, /<h1>Mateo Alvarez<\/h1>/);
      const sent = await visit(url, "/reviews/1", {
        method: "POST",
        cookie,
        body: new URLSearchParams({ feedback: "Strong on systems design." }),
      });
      assert.match(sent.body, /Feedback sent/);
    }));

  it("invite flow: an admin invites an email and it lists as invited", () =>
    withOptions({ login: true, defects: "none" }, async (url) => {
      const cookie = await signIn(url, admin);
      const sent = await visit(url, "/settings/users", {
        method: "POST",
        cookie,
        body: new URLSearchParams({ email: "new.person@gym.test", role: "recruiter" }),
      });
      assert.match(sent.body, /Invitation sent to new\.person@gym\.test/);
      assert.match((await visit(url, "/settings/users", { cookie })).body, /new\.person@gym\.test<\/td><td>Recruiter<\/td><td>Invited<\/td>/);
    }));

  it("settings links to users, approvals and billing", () =>
    withGym("none", async (url) => {
      const body = (await request(url, "/settings")).body;
      assert.match(body, /<a href="\/settings\/users">Users<\/a>/);
      assert.match(body, /<a href="\/settings\/approvals">Approvals<\/a>/);
      assert.match(body, /<a href="\/billing">Billing<\/a>/);
    }));

  it("D04 on: an unknown hiring manager links to the users page and the draft is lost", () =>
    withGym("D04", async (url) => {
      const res = await postJob(url, { title: "Data Engineer", department: "Engineering", hiring_manager: "Ines Moreau" });
      assert.equal(res.status, 200);
      assert.match(res.body, /No user found/);
      assert.match(res.body, /<a href="\/settings\/users">Invite user<\/a>/);
      assert.doesNotMatch(res.body, /Invite Ines Moreau/);
      assert.doesNotMatch((await request(url, "/jobs/new")).body, /value="Data Engineer"/);
    }));

  it("D04 off: an inline invite keeps the draft and sends the invitation", () =>
    withGym("none", async (url) => {
      const draft = { title: "Data Engineer", department: "Engineering", hiring_manager: "Ines Moreau" };
      assert.match((await postJob(url, draft)).body, /<button[^>]*>Invite Ines Moreau<\/button>/);
      const sent = await postJob(url, { ...draft, intent: "invite" });
      assert.match(sent.body, /Invitation sent to Ines Moreau/);
      assert.match(sent.body, /value="Data Engineer"/);
      assert.match(sent.body, /value="Ines Moreau"/);
      assert.match((await request(url, "/settings/users")).body, /Ines Moreau/);
      assert.equal((await postJob(url, { ...draft, hiring_manager: "ines moreau" })).status, 303);
    }));

  it("D05: the actions sit after the resume on narrow screens only when on", async () => {
    let on = "";
    let off = "";
    await withGym("D05", async (url) => {
      on = (await request(url, "/reviews/1")).body;
    });
    await withGym("none", async (url) => {
      off = (await request(url, "/reviews/1")).body;
    });
    assert.match(on, /@media \(max-width: 599px\) \{ \.review-actions \{ order: 1; \} \}/);
    assert.doesNotMatch(off, /order: 1;/);
    for (const body of [on, off]) {
      // The markup puts the actions first, so narrow screens show them above the resume unless the defect moves them.
      assert.ok(body.indexOf('class="card review-actions"') < body.indexOf('class="card resume"'));
      assert.match(body, /@media \(min-width: 600px\)/);
      assert.match(body, /\.review-actions \{ grid-column: 2; grid-row: 1; \}/);
    }
  });

  it("D06: decision buttons are icon-only when on and labelled when off", async () => {
    await withGym("D06", async (url) => {
      const body = (await request(url, "/reviews/1")).body;
      assert.ok(body.includes(">✓</button>") && body.includes(">✕</button>"));
      assert.doesNotMatch(body, />Advance<\/button>/);
    });
    await withGym("none", async (url) => {
      const body = (await request(url, "/reviews/1")).body;
      assert.match(body, />Advance<\/button>/);
      assert.match(body, />Reject<\/button>/);
    });
  });

  it("D07: the description is cut to 200 characters when on, kept with a hint when off", async () => {
    const long = "z".repeat(300);
    await withGym("D07", async (url) => {
      const created = await postJob(url, { title: "Data Engineer", department: "Engineering", description: long });
      const page = (await request(url, created.location ?? "")).body;
      assert.ok(page.includes("z".repeat(200)) && !page.includes("z".repeat(201)));
      assert.doesNotMatch((await request(url, "/jobs/new")).body, /Up to 2,000 characters/);
    });
    await withGym("none", async (url) => {
      const created = await postJob(url, { title: "Data Engineer", department: "Engineering", description: long });
      assert.ok((await request(url, created.location ?? "")).body.includes(long));
      assert.match((await request(url, "/jobs/new")).body, /Up to 2,000 characters/);
    });
  });

  it("D08: inviting an existing email shows a generic error when on and a clear one when off", async () => {
    const invite = (url: string) =>
      request(url, "/settings/users", { method: "POST", body: new URLSearchParams({ email: "recruiter@gym.test", role: "recruiter" }) });
    await withGym("D08", async (url) => {
      const body = (await invite(url)).body;
      assert.match(body, /Something went wrong/);
      assert.doesNotMatch(body, /already a user/);
    });
    await withGym("none", async (url) => {
      assert.match((await invite(url)).body, /recruiter@gym\.test is already a user/);
    });
  });

  it("D09: /candidates waits for the delay when on and answers at once when off", async () => {
    await withOptions({ defects: "D09", candidatesDelayMs: 400 }, async (url) => {
      const start = Date.now();
      await visit(url, "/candidates");
      assert.ok(Date.now() - start >= 390);
    });
    await withOptions({ defects: "none", candidatesDelayMs: 400 }, async (url) => {
      const start = Date.now();
      await visit(url, "/candidates");
      assert.ok(Date.now() - start < 300);
    });
  });

  it("D10: job form hints are light grey when on and muted when off", async () => {
    await withGym("D10", async (url) => {
      assert.match((await request(url, "/jobs/new")).body, /<p class="hint" id="hiring-manager-hint" style="color: #c8c8c8">/);
    });
    await withGym("none", async (url) => {
      const body = (await request(url, "/jobs/new")).body;
      assert.match(body, /<p class="hint" id="hiring-manager-hint" style="color: #5b6475">/);
      assert.doesNotMatch(body, /#c8c8c8/);
    });
  });

  it("D11: a hiring manager's next is ignored when on and honoured when off", async () => {
    for (const [defects, expected] of [["D11", "/"], ["none", "/reviews/2"]]) {
      await withOptions({ login: true, defects }, async (url) => {
        const res = await visit(url, "/login", {
          method: "POST",
          body: new URLSearchParams({ email: manager.email, password: manager.password, next: "/reviews/2" }),
        });
        assert.equal(res.location, expected, defects);
      });
    }
  });

  it("D12: the approval checkbox label; the default 'all' includes it", async () => {
    await withGym("D12", async (url) => {
      assert.match((await request(url, "/settings/approvals")).body, /Disable approval bypass/);
    });
    await withGym("none", async (url) => {
      const body = (await request(url, "/settings/approvals")).body;
      assert.match(body, /Require approval before a job goes live/);
      assert.doesNotMatch(body, /Disable approval bypass/);
    });
    await withGym("all", async (url) => {
      assert.match((await request(url, "/settings/approvals")).body, /Disable approval bypass/);
    });
  });
});
