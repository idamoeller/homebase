// Homebase — sync calendar links (ICS / webcal) into public.events.
// Called two ways:
//   • by the app ("Sync now" / after adding a calendar) with the signed-in user's token → syncs their household
//   • by the 30-minute pg_cron job with the x-cron-secret header → syncs every household
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import ICAL from "npm:ical.js@1.5.0";

const HOME_TZ = Deno.env.get("HOME_TZ") ?? "America/New_York";
const DAYS_BACK = 183; // about 6 months of history
const DAYS_AHEAD = 730; // two years ahead (repeating events need some limit)

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ── time helpers ─────────────────────────────────────────────────────────────
const tzOk = new Map<string, boolean>();
function validTz(tz?: string | null): tz is string {
  if (!tz) return false;
  if (!tzOk.has(tz)) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); tzOk.set(tz, true); } catch { tzOk.set(tz, false); }
  }
  return tzOk.get(tz)!;
}

// Intl formatters are slow to build, so keep one per zone.
const partsFmt = new Map<string, Intl.DateTimeFormat>();
const dayFmt = new Map<string, Intl.DateTimeFormat>();

// Offset (ms) of a time zone from UTC at a given instant.
function tzOffset(ms: number, tz: string): number {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsFmt.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ms;
}

function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz); // second pass handles DST edges
}

function localDate(ms: number, tz = HOME_TZ): string {
  let f = dayFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFmt.set(tz, f);
  }
  return f.format(new Date(ms));
}

function addDaysStr(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// An ICAL.Time → UTC milliseconds, using its own zone when we can, else the home zone.
// deno-lint-ignore no-explicit-any
function timeToMs(t: any): number {
  const tzid: string | undefined = t.zone?.tzid;
  if (tzid === "UTC" || t.zone === ICAL.Timezone.utcTimezone) return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  const tz = validTz(tzid) && tzid !== "floating" ? tzid : validTz(t.timezone) ? t.timezone : HOME_TZ;
  return wallToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, tz);
}

// deno-lint-ignore no-explicit-any
function dateStr(t: any): string {
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

// ── parsing ──────────────────────────────────────────────────────────────────
type Row = {
  uid: string; title: string; location: string | null; all_day: boolean;
  starts_at: string | null; ends_at: string | null; start_date: string; end_date: string;
};

// yyyymmdd as a number, from a Date in UTC.
function ymdNum(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// Big personal calendars hold years of history. Before the (slow) full parse, drop one-off
// events that are clearly outside the window and repeats that ended before it.
function trimCalendar(text: string, lo: number, hi: number): string {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const first = unfolded.search(/^BEGIN:VEVENT/m);
  if (first < 0) return unfolded;
  const head = unfolded.slice(0, first);
  const zones = head.match(/^BEGIN:VTIMEZONE[\s\S]*?^END:VTIMEZONE\r?$/gm) || [];
  const tzTail = unfolded.slice(first).match(/^BEGIN:VTIMEZONE[\s\S]*?^END:VTIMEZONE\r?$/gm) || [];
  const events = unfolded.match(/^BEGIN:VEVENT[\s\S]*?^END:VEVENT\r?$/gm) || [];
  const dateOf = (block: string, prop: string): number | null => {
    const m = block.match(new RegExp("^" + prop + "[^:\\r\\n]*:(\\d{8})", "m"));
    return m ? Number(m[1]) : null;
  };
  const kept = events.filter((b) => {
    if (/^RRULE/m.test(b)) {
      const until = b.match(/^RRULE[^\r\n]*UNTIL=(\d{8})/m);
      return !until || Number(until[1]) >= lo;
    }
    const start = dateOf(b, "RECURRENCE-ID") ?? dateOf(b, "DTSTART");
    const s2 = dateOf(b, "DTSTART");
    if (start === null || s2 === null) return true; // can't tell, keep it
    const end = dateOf(b, "DTEND") ?? s2;
    return Math.min(start, s2) <= hi && Math.max(end, start) >= lo;
  });
  const calHead = head.split(/^BEGIN:VTIMEZONE/m)[0];
  return calHead + [...zones, ...tzTail].join("\r\n") + "\r\n" + kept.join("\r\n") + "\r\nEND:VCALENDAR\r\n";
}

function parseIcs(text: string): Row[] {
  const now = Date.now();
  const winStart = now - DAYS_BACK * 86400000;
  const winEnd = now + DAYS_AHEAD * 86400000;
  // one-day margins so time-zone edges never drop a real event
  const loNum = ymdNum(winStart - 86400000), hiNum = ymdNum(winEnd + 86400000);
  const root = new ICAL.Component(ICAL.parse(trimCalendar(text, loNum, hiNum)));
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(tz); } catch { /* ignore bad zones */ }
  }

  const vevents = root.getAllSubcomponents("vevent");
  // deno-lint-ignore no-explicit-any
  const masters = new Map<string, any>();
  const exceptions: any[] = [];
  for (const ve of vevents) {
    const ev = new ICAL.Event(ve);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const m = masters.get(ex.uid);
    if (m) { try { m.relateException(ex); } catch { /* ignore */ } }
  }

  const rows: Row[] = [];
  // deno-lint-ignore no-explicit-any
  const push = (item: any, s: any, e: any, key: string) => {
    if (String(item.component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED") return;
    const title = (item.summary || "").trim() || "(no title)";
    const location = (item.location || "").trim() || null;
    if (s.isDate) {
      const sd = dateStr(s);
      const ed = e && dateStr(e) > sd ? addDaysStr(dateStr(e), -1) : sd; // DTEND is exclusive for all-day
      if (new Date(ed + "T23:59:59Z").getTime() < winStart || new Date(sd + "T00:00:00Z").getTime() > winEnd) return;
      rows.push({ uid: key, title, location, all_day: true, starts_at: null, ends_at: null, start_date: sd, end_date: ed });
    } else {
      const sMs = timeToMs(s);
      const eMs = e ? timeToMs(e) : sMs;
      if (eMs < winStart || sMs > winEnd) return;
      rows.push({
        uid: key, title, location, all_day: false,
        starts_at: new Date(sMs).toISOString(), ends_at: new Date(eMs).toISOString(),
        start_date: localDate(sMs), end_date: localDate(Math.max(sMs, eMs - 1)),
      });
    }
  };

  for (const ev of masters.values()) {
    if (ev.isRecurring()) {
      // how many days one occurrence lasts, so a long event that started before the window still counts
      const spanDays = ev.endDate ? Math.max(0, Math.ceil((ev.endDate.toUnixTime() - ev.startDate.toUnixTime()) / 86400)) : 0;
      const it = ev.iterator();
      let next; let guard = 0;
      while ((next = it.next()) && guard++ < 50000) {
        const n = next.year * 10000 + next.month * 100 + next.day;
        if (n > hiNum) break;
        if (n < loNum && spanDays < 2) continue; // before the window: skip without the costly details
        const details = ev.getOccurrenceDetails(next);
        if (timeToMs(details.startDate) > winEnd) break;
        push(details.item, details.startDate, details.endDate, `${ev.uid}|${details.startDate.toString()}`);
      }
    } else {
      push(ev, ev.startDate, ev.endDate, ev.uid || crypto.randomUUID());
    }
  }
  return rows;
}

// ── sync ─────────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function syncOne(c: any) {
  try {
    const url = String(c.url || "").trim().replace(/^webcals?:\/\//i, "https://");
    if (!/^https?:\/\//i.test(url)) throw new Error("That doesn't look like a calendar link");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Homebase calendar sync" } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`The calendar site answered ${res.status}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That link didn't return a calendar (no BEGIN:VCALENDAR)");
    const rows = parseIcs(text).map((r) => ({
      ...r, household_id: c.household_id, connection_id: c.id, created_by: c.created_by,
      person_id: c.person_id, visibility: c.visibility,
    }));
    const del = await admin.from("events").delete().eq("connection_id", c.id);
    if (del.error) throw del.error;
    for (let i = 0; i < rows.length; i += 500) {
      const ins = await admin.from("events").insert(rows.slice(i, i + 500));
      if (ins.error) throw ins.error;
    }
    await admin.from("connections").update({ last_synced_at: new Date().toISOString(), last_error: null, event_count: rows.length }).eq("id", c.id);
    return { id: c.id, ok: true, events: rows.length };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "The calendar site took too long to answer" : e.message) : String(e);
    await admin.from("connections").update({ last_synced_at: new Date().toISOString(), last_error: msg.slice(0, 300) }).eq("id", c.id);
    return { id: c.id, ok: false, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: { connection_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  let household: string | null = null;
  const secret = req.headers.get("x-cron-secret");
  if (secret) {
    const { data } = await admin.rpc("cron_secret_ok", { p: secret });
    if (data !== true) return json({ error: "not allowed" }, 401);
  } else {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: "sign in first" }, 401);
    const { data: m } = await admin.from("members").select("household_id").eq("user_id", u.user.id).maybeSingle();
    if (!m) return json({ error: "not in a household" }, 403);
    household = m.household_id;
  }

  let q = admin.from("connections").select("*").eq("kind", "ics").eq("enabled", true);
  if (household) q = q.eq("household_id", household);
  if (body.connection_id) q = q.eq("id", body.connection_id);
  const { data: conns, error } = await q;
  if (error) return json({ error: error.message }, 500);

  // The scheduled run fans out: each calendar syncs in its own invocation, so every one
  // gets its own CPU budget and one huge calendar can't stop the rest.
  if (secret && !body.connection_id) {
    const self = Deno.env.get("SUPABASE_URL") + "/functions/v1/sync-calendars";
    const results = await Promise.all((conns || []).map((c) =>
      fetch(self, { method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": secret }, body: JSON.stringify({ connection_id: c.id }) })
        .then((r) => r.json()).catch((e) => ({ id: c.id, ok: false, error: String(e) }))
    ));
    return json({ fanned_out: results.length, results });
  }

  const results = [];
  for (const c of conns || []) results.push(await syncOne(c));
  return json({ synced: results.length, results });
});
