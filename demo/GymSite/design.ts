// Gym v3 content as pure functions of whether a defect is on: the HTML behind the design frames (rendered to PNG by generate-assets.ts) and the pricing copy.
// shortcut: system font stack, so a PNG regenerated on another OS differs in glyph shapes; assets/manifest.json hashes this HTML rather than pixels.
import { COPY_SAMPLES, FRAME_SEQUENCES, copyKey, frameKey } from "./assets.ts";

const BASE = `
*{box-sizing:border-box;margin:0;padding:0}
body{width:1280px;height:800px;overflow:hidden;background:#f4f6f8;color:#1f2933;font:16px/1.5 Helvetica,Arial,sans-serif}
h1{font-size:28px;line-height:1.25}
h2{font-size:20px;line-height:1.3}
.muted{color:#5f6c7b}.small{font-size:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 20px;border-radius:8px;border:1px solid transparent;background:var(--brand);color:#fff;font-weight:600}
.btn.ghost{background:#fff;color:#1f2933;border-color:#c5ccd3}
.card{background:#fff;border:1px solid #dde2e7;border-radius:12px;padding:24px}
.field{margin-bottom:16px}
.field label{display:block;margin-bottom:4px;font-size:14px;font-weight:600}
.input{display:flex;align-items:center;height:44px;padding:0 12px;border:1px solid #b8c0c8;border-radius:8px;background:#fff}
.row{display:flex;justify-content:space-between;align-items:center}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
`;
const page = (brand: string, css: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frame</title><style>${BASE}:root{--brand:${brand}}${css}</style></head><body>${body}</body></html>`;

// --- checkout: Fieldhouse, a guest checkout in six frames ---

const SHOP_CSS = `
header{display:flex;align-items:center;justify-content:space-between;height:64px;padding:0 48px;background:#fff;border-bottom:1px solid #dde2e7}
.logo{font-size:22px;font-weight:700;color:var(--brand)}
main{width:1040px;margin:32px auto 0}
.steps{display:flex;gap:12px;margin-bottom:28px}
.steps span{padding:6px 14px;border-radius:999px;background:#e6eaee;color:#5f6c7b;font-size:14px}
.steps .done{background:#d7eadf;color:#245a40}
.steps .now{background:var(--brand);color:#fff;font-weight:600}
.cols{display:grid;grid-template-columns:1fr 340px;gap:24px;align-items:start}
.item{display:flex;gap:16px;align-items:center;padding:16px 0;border-bottom:1px solid #eef1f4}
.item:last-child{border-bottom:0}
.thumb{width:64px;height:64px;border-radius:8px}
.item .grow{flex:1}
.sum .row{margin-top:10px}
.sum .total{margin-top:16px;padding-top:12px;border-top:1px solid #dde2e7;font-weight:700;font-size:18px}
.center{width:560px;margin:56px auto 0;text-align:center}
.center .field,.center .item{text-align:left}
.badge{display:flex;align-items:center;justify-content:center;width:64px;height:64px;margin:0 auto 16px;border-radius:50%;background:#d7eadf}
.timeline{display:flex;margin:28px 0 8px}
.timeline div{flex:1;position:relative;padding-top:28px;font-size:14px}
.timeline div:before{content:"";position:absolute;top:6px;left:0;right:0;height:4px;background:#dde2e7}
.timeline div:after{content:"";position:absolute;top:0;left:0;width:16px;height:16px;border-radius:50%;background:#b8c0c8}
.timeline .done:before,.timeline .done:after{background:var(--brand)}
table{width:100%;border-collapse:collapse}
td,th{padding:10px 0;border-bottom:1px solid #eef1f4;text-align:left;font-weight:400}
td:last-child,th:last-child{text-align:right}
`;
const shop = (body: string) =>
  page("#2f6f4f", SHOP_CSS, `<header><span class="logo">Fieldhouse</span><span class="muted small">Secure checkout</span></header><main>${body}</main>`);
const steps = (now: number) =>
  `<div class="steps">${["Cart", "Shipping", "Payment", "Confirmation"].map((s, i) => `<span class="${i + 1 < now ? "done" : i + 1 === now ? "now" : ""}">${i + 1}. ${s}</span>`).join("")}</div>`;
const input = (label: string, value = "") => `<div class="field"><label>${label}</label><div class="input">${value}</div></div>`;
const jacket = `<div class="item"><div class="thumb" style="background:#6b8f71"></div><div class="grow"><strong>Ridgeline rain jacket</strong><div class="muted small">Moss, size M · Qty 1</div></div><strong>$119.00</strong></div>`;
const socks = `<div class="item"><div class="thumb" style="background:#c9a66b"></div><div class="grow"><strong>Merino hiking socks, 2 pack</strong><div class="muted small">Sand, size M · Qty 1</div></div><strong>$24.00</strong></div>`;
const summary = (cta = "") =>
  `<aside class="card sum"><h2>Order summary</h2><div class="row"><span>Subtotal</span><span>$143.00</span></div><div class="row"><span>Delivery</span><span>Free</span></div><div class="row total"><span>Total</span><span>$143.00</span></div>${cta}</aside>`;

const checkoutFrames = (defect: boolean) => [
  shop(`${steps(1)}<div class="cols"><section class="card"><h1>Your cart</h1>${jacket}${socks}</section>${summary('<div class="btn" style="width:100%;margin-top:20px">Checkout</div>')}</div>`),
  shop(`${steps(2)}<div class="cols"><section class="card"><h1>Shipping</h1><p class="muted" style="margin:4px 0 20px">Checking out as a guest. No account needed.</p>${input("Email, for order updates", "maya.lindqvist@example.com")}<div class="grid2">${input("Full name", "Maya Lindqvist")}${input("Phone (optional)")}</div>${input("Street address", "Storgatan 14")}<div class="grid2">${input("Postcode", "114 55")}${input("City", "Stockholm")}</div>${input("Delivery", "Standard, 3 to 5 days, free")}<div class="btn" style="margin-top:8px">Continue to payment</div></section>${summary()}</div>`),
  shop(`${steps(3)}<div class="cols"><section class="card"><h1>Payment</h1><p class="muted" style="margin:4px 0 20px">Review your details, then place your order.</p>${input("Card number", "4242 4242 4242 4242")}<div class="grid2">${input("Expiry", "08 / 29")}${input("Security code", "•••")}</div>${input("Name on card", "Maya Lindqvist")}<p class="small muted" style="margin-bottom:16px">Shipping to Storgatan 14, 114 55 Stockholm. By placing your order you agree to our terms.</p><div class="btn" style="width:100%">Place order · $143.00</div></section>${summary()}</div>`),
  defect
    ? shop(`<section class="card center"><h1>Sign in to continue</h1><p class="muted" style="margin:8px 0 24px">Sign in to your Fieldhouse account to see your order.</p>${input("Email")}${input("Password", "")}<div class="btn" style="width:100%">Sign in</div><p class="small" style="margin-top:12px;color:#2f6f4f">Forgot your password?</p><p class="small muted" style="margin:24px 0 12px">New to Fieldhouse?</p><div class="btn ghost" style="width:100%">Create an account</div></section>`)
    : shop(`${steps(5)}<section class="card center"><div class="badge"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2f6f4f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div><h1>Thanks, Maya. Your order is placed.</h1><p class="muted" style="margin:8px 0 24px">Order FH-48213. We sent a confirmation to maya.lindqvist@example.com.</p>${jacket}${socks}<div style="margin-top:24px;display:flex;gap:12px;justify-content:center"><div class="btn">Track your order</div><div class="btn ghost">Continue shopping</div></div></section>`),
  shop(`<section class="card" style="margin-top:0"><div class="row"><h1>Track your order</h1><span class="muted">Order FH-48213</span></div><div class="timeline"><div class="done"><strong>Order placed</strong><br><span class="muted">Fri 16 Oct</span></div><div><strong>Packed</strong><br><span class="muted">Mon 19 Oct</span></div><div><strong>Shipped</strong><br><span class="muted">Mon 19 Oct</span></div><div><strong>Delivered</strong><br><span class="muted">Est. Thu 22 Oct</span></div></div><p class="muted" style="margin:24px 0 8px">Delivering to Storgatan 14, 114 55 Stockholm</p>${jacket}${socks}<div class="btn ghost" style="margin-top:16px">View receipt</div></section>`),
  shop(`<section class="card" style="margin-top:0"><div class="row"><h1>Receipt</h1><span class="muted">Order FH-48213 · Fri 16 Oct 2026</span></div><table style="margin-top:16px"><tr><td>Ridgeline rain jacket, Moss, M</td><td>$119.00</td></tr><tr><td>Merino hiking socks, 2 pack</td><td>$24.00</td></tr><tr><td>Delivery</td><td>Free</td></tr><tr><th>Total paid</th><th>$143.00</th></tr></table><p class="muted" style="margin:16px 0 24px">Paid with Visa ending 4242</p><div style="display:flex;gap:12px"><div class="btn">Download PDF</div><div class="btn ghost">Start a return</div></div></section>`),
];

// --- invite: Plotline, adding a teammate in four frames ---

const APP_CSS = `
body{display:flex}
nav{width:220px;height:800px;padding:24px 16px;background:#1b2559;color:#c9d1f5}
nav .logo{margin:0 8px 28px;font-size:22px;font-weight:700;color:#fff}
nav div{padding:10px 12px;margin-bottom:4px;border-radius:8px}
nav .on{background:#3b5bdb;color:#fff;font-weight:600}
.content{flex:1;padding:32px 48px;position:relative}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.tools{display:flex;gap:12px;align-items:center}
.btn.sq{width:44px;padding:0}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
.stats strong{display:block;font-size:32px}
table{width:100%;border-collapse:collapse}
td,th{padding:12px 16px;border-bottom:1px solid #eef1f4;text-align:left}
th{font-size:14px;color:#5f6c7b;font-weight:600}
.av{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;margin-right:12px;border-radius:50%;background:#dbe4ff;color:#3b5bdb;font-size:13px;font-weight:700;vertical-align:middle}
.pill{padding:2px 10px;border-radius:999px;background:#fff3bf;color:#7a5b00;font-size:13px}
.dim{position:fixed;inset:0;background:rgba(15,23,42,.45)}
.dialog{position:fixed;left:50%;top:150px;width:480px;margin-left:-240px;box-shadow:0 20px 50px rgba(15,23,42,.3)}
.toast{position:absolute;right:48px;bottom:32px;padding:12px 18px;border-radius:8px;background:#1f7a4d;color:#fff;font-weight:600}
`;
const app = (active: string, body: string) =>
  page("#3b5bdb", APP_CSS, `<nav><div class="logo">Plotline</div>${["Overview", "Tasks", "Team", "Reports", "Settings"].map((n) => `<div${n === active ? ' class="on"' : ""}>${n}</div>`).join("")}</nav><div class="content">${body}</div>`);
// The one icon in the product with no label, tooltip or conventional shape: a hexagon with a dot and a stem.
const GLYPH = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 4v6l-7 4-7-4V7z"/><circle cx="12" cy="10" r="1.6" fill="currentColor"/><path d="M12 17v4"/></svg>`;
const member = (name: string, role: string, seen: string, extra = "") =>
  `<tr><td><span class="av">${name.split(" ").map((w) => w[0]).join("")}</span>${name}${extra}</td><td>${role}</td><td class="muted">${seen}</td></tr>`;
const team = (defect: boolean, state: "plain" | "dialog" | "sent") => {
  const invite = defect ? `<div class="btn sq" aria-hidden="true">${GLYPH}</div>` : `<div class="btn">${GLYPH}Invite teammate</div>`;
  const pending = state === "sent" ? member("jordan.mills@northwind.example", "Editor", "Invited just now", ' <span class="pill">Pending</span>') : "";
  return app("Team", `${state === "sent" ? '<div class="toast">Invite sent to jordan.mills@northwind.example</div>' : ""}<div class="top"><div><h1>Team</h1><p class="muted">Northwind redesign · ${state === "sent" ? "5 people, 1 invited" : "5 people"}</p></div><div class="tools"><div class="btn ghost">Filter</div><div class="btn ghost">Export</div>${invite}</div></div><div class="card" style="padding:0"><table><tr><th>Name</th><th>Role</th><th>Last active</th></tr>${member("Priya Natarajan", "Owner", "Today")}${member("Dana Okafor", "Editor", "Today")}${member("Sam Rivera", "Admin", "Yesterday")}${member("Lea Schneider", "Editor", "2 days ago")}${member("Tomás Ibarra", "Viewer", "Last week")}${pending}</table></div>${state === "dialog" ? `<div class="dim"></div><div class="card dialog"><h2>Invite a teammate</h2><p class="muted small" style="margin:4px 0 20px">They get an email with a link to join Northwind redesign.</p>${input("Email", "jordan.mills@northwind.example")}${input("Role", "Editor")}<div class="row" style="justify-content:flex-end;gap:12px"><div class="btn ghost">Cancel</div><div class="btn">Send invite</div></div></div>` : ""}`);
};
const inviteFrames = (defect: boolean) => [
  app("Overview", `<div class="top"><div><h1>Good morning, Priya</h1><p class="muted">Here is where Northwind redesign stands.</p></div></div><div class="stats"><div class="card"><strong>42</strong><span class="muted">Open tasks</span></div><div class="card"><strong>11</strong><span class="muted">Due this week</span></div><div class="card"><strong>5</strong><span class="muted">Team members</span></div></div><div class="card" style="padding:0"><table><tr><th>Project</th><th>Owner</th><th>Progress</th></tr><tr><td>Northwind redesign</td><td>Priya Natarajan</td><td>68%</td></tr><tr><td>Mobile app v2</td><td>Dana Okafor</td><td>31%</td></tr><tr><td>Brand refresh</td><td>Sam Rivera</td><td>90%</td></tr></table></div>`),
  team(defect, "plain"),
  team(defect, "dialog"),
  team(defect, "sent"),
];

const DESIGN_FRAMES = { checkout: checkoutFrames, invite: inviteFrames };

// Every frame of every variant: its key under demo/GymSite/assets and its HTML.
export function framePlan() {
  return (Object.keys(FRAME_SEQUENCES) as (keyof typeof FRAME_SEQUENCES)[]).flatMap((sequence) =>
    [false, true].flatMap((defect) =>
      DESIGN_FRAMES[sequence](defect).map((html, i) => ({ key: frameKey(sequence, defect ? FRAME_SEQUENCES[sequence].defect : "control", i), html }))));
}

// --- pricing: Plotline's pricing page; the defect adds SSO to the Team card while the table and FAQ give it to Business only ---

export function pricingCopy(defect: boolean) {
  return `# Plotline pricing

Plan the work, share the plan. Pick the plan that fits your team today and change it whenever you like.

## Plans

### Starter: $0

For individuals and small side projects.

- Up to 3 projects
- Up to 5 collaborators per project
- 30 days of task history
- Email and password sign-in
- Email support

### Team: $12 per person per month

For teams that run several projects at once. Billed annually, or $15 per person per month when billed monthly.

- Unlimited projects
- Unlimited collaborators
- Full task history
- Timeline and workload views
- Google and Microsoft sign-in
${defect ? "- Single sign-on (SAML SSO)\n" : ""}- Priority email support

### Business: $24 per person per month

For companies that need control and compliance. Billed annually, or $29 per person per month when billed monthly.

- Everything in Team
- Single sign-on (SAML SSO)
- Audit log and admin controls
- Custom roles and permissions
- 99.9% uptime SLA
- A dedicated success manager

## Compare plans

| | Starter | Team | Business |
|---|---|---|---|
| Price per person per month, billed annually | $0 | $12 | $24 |
| Projects | 3 | Unlimited | Unlimited |
| Collaborators per project | 5 | Unlimited | Unlimited |
| Task history | 30 days | Full | Full |
| Timeline and workload views | Not included | Included | Included |
| Google and Microsoft sign-in | Not included | Included | Included |
| Single sign-on (SAML SSO) | Not included | Not included | Included |
| Audit log and admin controls | Not included | Not included | Included |
| Custom roles and permissions | Not included | Not included | Included |
| Uptime SLA | None | None | 99.9% |
| Support | Email | Priority email | Dedicated success manager |

## Frequently asked questions

**Can I switch plans later?**
Yes. Upgrades apply straight away and downgrades apply at the end of your billing period.

**Is single sign-on available on Team?**
No. Single sign-on (SAML SSO) is part of Business. Team supports Google and Microsoft sign-in.

**What happens when I reach the project limit on Starter?**
Your existing projects keep working. To create a fourth project, move to Team.

**Do you offer discounts?**
Non-profits and schools get 30% off Team and Business. Write to sales@plotline.example.
`;
}

export const copyPlan = () =>
  [false, true].map((defect) => ({ key: copyKey("pricing", defect ? COPY_SAMPLES.pricing.defect : "control"), text: pricingCopy(defect) }));
