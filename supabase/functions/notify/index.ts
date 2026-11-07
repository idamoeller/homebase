// Homebase — send phone notifications (web push) about new Who's where entries and calendar events.
// Called two ways:
//   • by the 1-minute pg_cron job with the x-cron-secret header → sends everything queued (see 031_notifications.sql)
//   • by the app with the signed-in user's token and {test:true} → sends a test to that person's own devices
// Deploy with verify_jwt off (the cron call has no user token); both paths check who's calling.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const HOME_TZ = "America/New_York";
const APP_URL = "https://idamoeller.github.io/homebase/";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Sub = { endpoint: string; p256dh: string; auth: string; user_id: string; household_id: string };
type Msg = { title: string; body: string; tag: string; go: string };

// ── wording ──────────────────────────────────────────────────────────────────
const KINDS: Record<string, string> = {
  travel: "Traveling", office_drive: "Office · drive", office_boat: "Office · boat", wfh: "Working from home", off: "Off",
};
const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: HOME_TZ });
const day = (d: string) => dayFmt.format(new Date(d + "T12:00:00Z"));
const time = (iso: string) => timeFmt.format(new Date(iso)).replace(":00", "");
const range = (a: string, b: string) => (a === b ? day(a) : day(a) + " – " + day(b));
const list = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];

// deno-lint-ignore no-explicit-any
type Item = { household_id: string; kind: "schedule" | "event"; actor: string | null; row: any };

function lines(items: Item[], personName: (id: string) => string | null, actorName: (id: string | null) => string) {
  const out: string[] = [];
  for (const it of items.filter((i) => i.kind === "schedule")) {
    const r = it.row;
    const who = (r.person_ids || []).map(personName).filter(Boolean) as string[];
    out.push([who.length ? list(who) : actorName(it.actor), KINDS[r.kind] || r.kind, r.place, range(r.start_date, r.end_date)]
      .filter(Boolean).join(" · "));
  }
  // Same title added several times at once = a weekly event; say it once.
  const byTitle = new Map<string, Item[]>();
  for (const it of items.filter((i) => i.kind === "event")) {
    const k = String(it.row.title).trim().toLowerCase();
    byTitle.set(k, [...(byTitle.get(k) || []), it]);
  }
  for (const group of byTitle.values()) {
    group.sort((a, b) => String(a.row.start_date).localeCompare(String(b.row.start_date)));
    const r = group[0].row;
    const when = group.length > 1
      ? `${group.length} times, ${day(r.start_date)} – ${day(group[group.length - 1].row.start_date)}`
      : day(r.start_date) + (!r.all_day && r.starts_at ? ", " + time(r.starts_at) : "");
    out.push([r.title, when, r.person_id ? personName(r.person_id) : null].filter(Boolean).join(" · "));
  }
  return out;
}

function message(items: Item[], personName: (id: string) => string | null, actorName: (id: string | null) => string): Msg {
  const ls = lines(items, personName, actorName);
  const actors = [...new Set(items.map((i) => actorName(i.actor)))];
  const by = actors.length === 1 ? actors[0] : "Your family";
  const onlySched = items.every((i) => i.kind === "schedule");
  const onlyEvents = items.every((i) => i.kind === "event");
  const title = ls.length > 1
    ? `${by} added ${ls.length} things`
    : `${by} added to ${onlySched ? "Who's where" : "the calendar"}`;
  return {
    title,
    body: ls.slice(0, 6).join("\n") + (ls.length > 6 ? `\n+${ls.length - 6} more` : ""),
    tag: "hb-" + Date.now(),
    go: onlySched ? "schedule" : onlyEvents ? "calendar" : "today",
  };
}

// ── sending ──────────────────────────────────────────────────────────────────
let keysReady = false;
async function setupKeys() {
  if (keysReady) return;
  const { data, error } = await admin.rpc("push_keys");
  if (error || !data?.public || !data?.private) throw new Error("push keys missing: " + (error?.message || "not set"));
  webpush.setVapidDetails(APP_URL, data.public, data.private);
  keysReady = true;
}

// Returns the push service's status (201 = delivered to Apple/Google; 404/410 = that device turned notifications off).
async function send(sub: Sub, msg: Msg): Promise<number> {
  const req = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(msg),
    { TTL: 60 * 60 * 24, urgency: "normal" },
  );
  try {
    const r = await fetch(req.endpoint, { method: req.method, headers: req.headers as Record<string, string>, body: req.body });
    await r.body?.cancel();
    return r.status;
  } catch {
    return 0;
  }
}

async function deliver(pairs: Array<[Sub, Msg]>) {
  const results = await Promise.all(pairs.map(async ([s, m]) => [s.endpoint, await send(s, m)] as const));
  const ok = results.filter(([, st]) => st >= 200 && st < 300).map(([e]) => e);
  const gone = results.filter(([, st]) => st === 404 || st === 410).map(([e]) => e);
  if (ok.length || gone.length) await admin.rpc("push_report", { p_ok: ok, p_gone: gone });
  return { sent: ok.length, removed: gone.length, statuses: results.map(([, st]) => st) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: { test?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  try {
    const secret = req.headers.get("x-cron-secret");
    if (secret) {
      const { data: okSecret } = await admin.rpc("cron_secret_ok", { p: secret });
      if (okSecret !== true) return json({ error: "not allowed" }, 401);
      const { data, error } = await admin.rpc("push_take");
      if (error) throw error;
      if (!data) return json({ sent: 0 });
      const items = (data.items as Item[]).filter((i) => i.row); // skip things deleted before sending
      const subs = data.subs as Sub[];
      if (!items.length || !subs.length) return json({ sent: 0 });
      await setupKeys();

      const people = data.people as { id: string; name: string; user_id: string | null }[];
      const members = data.members as { user_id: string; name: string }[];
      const personName = (id: string) => people.find((p) => p.id === id)?.name || null;
      const actorName = (id: string | null) =>
        (id && (people.find((p) => p.user_id === id)?.name || members.find((m) => m.user_id === id)?.name)) || "Someone";

      // Each person hears about what others added in their household, never about their own adds.
      const pairs: Array<[Sub, Msg]> = [];
      const byUser = new Map<string, Sub[]>();
      for (const s of subs) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s]);
      for (const [user, devices] of byUser) {
        const mine = items.filter((i) => i.household_id === devices[0].household_id && i.actor !== user);
        if (!mine.length) continue;
        const msg = message(mine, personName, actorName);
        for (const d of devices) pairs.push([d, msg]);
      }
      return json(await deliver(pairs));
    }

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "sign in first" }, 401);
    if (!body.test) return json({ error: "nothing to do" }, 400);
    const { data: subs } = await admin.from("push_subs").select("*").eq("user_id", u.user.id);
    if (!subs?.length) return json({ error: "Notifications aren't on for any of your devices yet." }, 400);
    await setupKeys();
    const msg: Msg = { title: "Homebase", body: "Notifications are working on this device.", tag: "hb-test", go: "family" };
    return json(await deliver((subs as Sub[]).map((s) => [s, msg])));
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
