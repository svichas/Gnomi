import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { startGym } from "./server.ts";

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
    assert.deepEqual(toggles, ["D01", "D02", "D03"]);
  });
});
