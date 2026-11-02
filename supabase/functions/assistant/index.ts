// Homebase — "Ask Homebase": a chat that knows your to-dos, requests, calendar and schedule, and can change them.
//   POST {messages:[{role:'user'|'assistant', content}]} → {reply, changed}
// It reads and writes with the signed-in person's own login, so it only sees and changes what they could in the app.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";

const MODEL = Deno.env.get("HOMEBASE_CHAT_MODEL") ?? "claude-haiku-5-5";
const HOME_TZ = Deno.env.get("HOME_TZ") ?? "America/New_York";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function todayInHome(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(d: string, n: number): string {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const weekday = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const hhmm = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const clip = (t: string | null | undefined, n: number) => (t || "").replace(/\s+/g, " ").trim().slice(0, n);

// ── tools: what the chat can change ───────────────────────────────────────────
const S = (description: string) => ({ type: "string", description });
const TOOL_DEFS = [
  {
    name: "add_event",
    description: "Add an event to the Homebase calendar. For something that repeats weekly, set weekly_until (it adds one event per week through that date).",
    input_schema: { type: "object", additionalProperties: false, required: ["title", "date"], properties: {
      title: S("Event title"), date: S("YYYY-MM-DD (first date if weekly)"), start: S("HH:MM 24-hour; leave out for all day"), end: S("HH:MM 24-hour"),
      location: S("Place"), person: S("Who it's for: one family name"), visibility: { type: "string", enum: ["family", "personal"] },
      notes: S("Details"), weekly_until: S("YYYY-MM-DD: repeat every week through this date. If they say weekly with no end, use 12 weeks and say so."),
    } },
  },
  {
    name: "change_event",
    description: "Move or edit an event that was made in Homebase (not synced ones). Only include what changes.",
    input_schema: { type: "object", additionalProperties: false, required: ["event_id"], properties: {
      event_id: S("id from [event …]"), title: S("New title"), date: S("YYYY-MM-DD"), start: S("HH:MM, or \"none\" for all day"), end: S("HH:MM"),
      location: S("Place"), person: S("One family name, or \"none\""), notes: S("Replace the details"),
    } },
  },
  {
    name: "remove_event",
    description: "Delete an event made in Homebase, or hide a synced event from Homebase.",
    input_schema: { type: "object", additionalProperties: false, required: ["event_id"], properties: { event_id: S("id from [event …]") } },
  },
  {
    name: "set_event_details",
    description: "Set Homebase-only details on any event: drivers, a note, a clearer title, a color, arrival time, uniform. Only include what changes; \"none\" clears.",
    input_schema: { type: "object", additionalProperties: false, required: ["event_id"], properties: {
      event_id: S("id from [event …]"), drop_off: S("Who's driving there: one driver name, or \"none\""), pick_up: S("Who's picking up: one driver name, or \"none\""),
      every_week: { type: "boolean", description: "true = these drivers every week for this weekly event (same weekday and time)" },
      note: S("Note to add"), title: S("Clearer title shown in Homebase"), color: S("#RRGGBB (muted; red #A33B3B, orange #C27C0E, green #2C6B45, blue #3F5F8F, purple #6E4A7E, pink #B04A7A), or \"none\""),
      arrive: S("Arrival time HH:MM"), uniform: S("What to wear"),
    } },
  },
  {
    name: "add_todo",
    description: "Add a to-do.",
    input_schema: { type: "object", additionalProperties: false, required: ["title"], properties: {
      title: S("Short, specific"), due_date: S("YYYY-MM-DD"), due_time: S("HH:MM"), start_date: S("YYYY-MM-DD: keep it out of their list until this day (\"next week\" = coming Monday)"),
      person: S("Who it's for: one family name"), assign_to: S("Adult with a login to hand it to (makes it a family to-do)"),
      family: { type: "boolean", description: "Share with the family instead of personal" }, notes: S("Details"),
    } },
  },
  {
    name: "change_todo",
    description: "Change, finish, or sort a to-do or a waiting request. Only include what changes.",
    input_schema: { type: "object", additionalProperties: false, required: ["todo_id"], properties: {
      todo_id: S("id from [todo …]"), title: S("New title"), due_date: S("YYYY-MM-DD or \"none\""), due_time: S("HH:MM or \"none\""),
      start_date: S("YYYY-MM-DD or \"none\""), person: S("One family name or \"none\""), notes_add: S("Note to add"),
      done: { type: "boolean" }, dismiss: { type: "boolean", description: "Not needed: hide it" },
      sort: { type: "string", enum: ["mine", "family"], description: "For a waiting request: put it on my to-dos, or the family's" },
      assign_to: S("Adult with a login to hand it to"),
    } },
  },
];

// deno-lint-ignore no-explicit-any
function makeTools(ctx: { db: any; me: string; hid: string; today: string; people: any[]; members: any[] }) {
  const { db, me, hid, people, members } = ctx;
  const nm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;
  const personId = (s: string) => people.find((p) => nm(p.name) === nm(s))?.id;
  const driverId = (s: string) => people.find((p) => p.kind !== "kid" && nm(p.name) === nm(s))?.id;
  const adultId = (s: string) => members.find((m) => nm(m.display_name) === nm(s) || (m.user_id === me && ["me", "myself"].includes(nm(s))))?.user_id;
  const fail = (error: string) => ({ ok: false, error });
  // HH:MM on a date, home time → ISO timestamp
  const homeISO = (d: string, t: string) => {
    const guess = new Date(`${d}T${t}:00Z`);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(guess).map((x) => [x.type, x.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    return new Date(guess.getTime() - (local - guess.getTime())).toISOString();
  };
  const homeHM = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: HOME_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const getEvent = async (id: string) => {
    const { data } = await db.from("events").select("*").eq("id", id).eq("household_id", hid).maybeSingle();
    return data;
  };
  const saveHb = (e: Record<string, unknown>, id: string | null) => db.rpc("save_homebase_event", {
    p_household: hid, p_id: id, p_title: e.title, p_date: e.date, p_start: e.start || null, p_end: e.end || null,
    p_location: e.location || null, p_notes: e.notes || null, p_person: e.person_id || null, p_visibility: e.visibility || "family",
  });

  return {
    // deno-lint-ignore no-explicit-any
    async add_event(a: any) {
      if (!a.title || !DATE.test(a.date)) return fail("needs a title and a YYYY-MM-DD date");
      if (a.start && !TIME.test(a.start)) return fail("start must be HH:MM");
      const until = DATE.test(a.weekly_until || "") ? a.weekly_until : a.date;
      const base = { title: a.title, start: a.start, end: TIME.test(a.end || "") ? a.end : null, location: a.location, notes: a.notes,
        person_id: a.person ? personId(a.person) || null : null, visibility: a.visibility === "personal" ? "personal" : "family" };
      const dates: string[] = [];
      for (let d = a.date; d <= until && dates.length < 52; d = addDays(d, 7)) dates.push(d);
      for (const d of dates) {
        const { error } = await saveHb({ ...base, date: d }, null);
        if (error) return fail(error.message);
      }
      return { ok: true, added: dates.length, first: dates[0], last: dates[dates.length - 1] };
    },
    // deno-lint-ignore no-explicit-any
    async change_event(a: any) {
      const e = await getEvent(a.event_id);
      if (!e) return fail("no such event");
      if (!String(e.uid || "").startsWith("hb-")) return fail("this event comes from a synced calendar and can't be moved; use set_event_details for title/notes");
      const start = a.start === "none" ? null : TIME.test(a.start || "") ? a.start : e.all_day ? null : homeHM(e.starts_at);
      const end = TIME.test(a.end || "") ? a.end : (a.start !== undefined || e.all_day || !e.ends_at) ? null : homeHM(e.ends_at);
      const p = a.person === undefined ? e.person_id : nm(a.person) === "none" ? null : personId(a.person) || e.person_id;
      const { error } = await saveHb({ title: a.title || e.title, date: DATE.test(a.date || "") ? a.date : e.start_date, start, end,
        location: a.location ?? e.location, notes: a.notes ?? e.description, person_id: p, visibility: e.visibility }, e.id);
      return error ? fail(error.message) : { ok: true };
    },
    // deno-lint-ignore no-explicit-any
    async remove_event(a: any) {
      const e = await getEvent(a.event_id);
      if (!e) return fail("no such event");
      if (String(e.uid || "").startsWith("hb-")) {
        const { error } = await db.rpc("delete_homebase_event", { p_id: e.id });
        return error ? fail(error.message) : { ok: true, deleted: true };
      }
      const { error } = await upsertNote(e, { hidden: true });
      return error ? fail(error.message) : { ok: true, hidden: true };
    },
    // deno-lint-ignore no-explicit-any
    async set_event_details(a: any) {
      const e = await getEvent(a.event_id);
      if (!e) return fail("no such event");
      const f: Record<string, unknown> = {};
      const who = (s: string) => nm(s) === "none" ? null : driverId(s);
      if (a.drop_off !== undefined) { f.drop_off = who(a.drop_off); if (f.drop_off === undefined) return fail(`unknown driver ${a.drop_off}`); }
      if (a.pick_up !== undefined) { f.pick_up = who(a.pick_up); if (f.pick_up === undefined) return fail(`unknown driver ${a.pick_up}`); }
      if (a.title) f.title = clip(a.title, 200);
      if (a.color !== undefined) f.color = nm(a.color) === "none" ? null : /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : undefined;
      if (f.color === undefined) delete f.color;
      if (TIME.test(a.arrive || "")) f.arrive_at = homeISO(e.start_date, a.arrive);
      if (a.uniform) f.uniform = clip(a.uniform, 80);
      if (a.every_week && !e.all_day && e.starts_at && ("drop_off" in f || "pick_up" in f)) {
        // weekly drivers live on a rule for this weekday and start time, like the app's "every week" box
        const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const dow = DOW.indexOf(new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, weekday: "short" }).format(new Date(e.starts_at)));
        const { data: oldRule } = await db.from("event_rules").select("*").eq("connection_id", e.connection_id)
          .eq("title", String(e.title).trim()).eq("dow", dow).eq("start_time", homeHM(e.starts_at)).maybeSingle();
        const rule = { household_id: hid, connection_id: e.connection_id, title: String(e.title).trim(), dow, start_time: homeHM(e.starts_at),
          drop_off: "drop_off" in f ? f.drop_off : oldRule?.drop_off ?? null, pick_up: "pick_up" in f ? f.pick_up : oldRule?.pick_up ?? null,
          updated_at: new Date().toISOString() };
        const { error } = await db.from("event_rules").upsert(rule, { onConflict: "connection_id,title,dow,start_time" });
        if (error) return fail(error.message);
        f.drop_off = null; f.pick_up = null;
      }
      const old = await noteOf(e);
      if (a.note) f.note = (old?.note ? old.note + "\n" : "") + clip(a.note, 500);
      const { error } = await upsertNote(e, f);
      return error ? fail(error.message) : { ok: true };
    },
    // deno-lint-ignore no-explicit-any
    async add_todo(a: any) {
      if (!a.title) return fail("needs a title");
      const assigned = a.assign_to ? adultId(a.assign_to) : null;
      if (a.assign_to && !assigned) return fail(`no login named ${a.assign_to}`);
      const row = { household_id: hid, title: clip(a.title, 200), notes: a.notes ? clip(a.notes, 1000) : null,
        due_date: DATE.test(a.due_date || "") ? a.due_date : null, due_time: TIME.test(a.due_time || "") ? a.due_time : null,
        start_date: DATE.test(a.start_date || "") ? a.start_date : null, person_id: a.person ? personId(a.person) || null : null,
        visibility: a.family || assigned ? "family" : "personal", assigned_to: assigned, kind: "task" };
      const { error } = await db.from("items").insert(row);
      return error ? fail(error.message) : { ok: true };
    },
    // deno-lint-ignore no-explicit-any
    async change_todo(a: any) {
      const { data: it } = await db.from("items").select("*").eq("id", a.todo_id).eq("household_id", hid).maybeSingle();
      if (!it) return fail("no such to-do");
      const f: Record<string, unknown> = {};
      if (a.title) f.title = clip(a.title, 200);
      for (const [k, re] of [["due_date", DATE], ["due_time", TIME], ["start_date", DATE]] as const) {
        if (a[k] === "none") f[k] = null; else if (re.test(a[k] || "")) f[k] = a[k];
      }
      if (a.person !== undefined) f.person_id = nm(a.person) === "none" ? null : personId(a.person) ?? it.person_id;
      if (a.notes_add) f.notes = (it.notes ? it.notes + "\n" : "") + clip(a.notes_add, 500);
      if (a.done !== undefined) f.done = !!a.done;
      if (a.dismiss) { f.dismissed = true; f.inbox = false; }
      if (a.sort === "mine") f.inbox = false;
      if (a.sort === "family") { f.inbox = false; f.visibility = "family"; }
      if (a.assign_to) {
        const u = adultId(a.assign_to);
        if (!u) return fail(`no login named ${a.assign_to}`);
        Object.assign(f, { assigned_to: u, visibility: "family", inbox: false });
      }
      if (f.done) f.inbox = false;
      if (!Object.keys(f).length) return fail("nothing to change");
      const { error } = await db.from("items").update(f).eq("id", it.id);
      return error ? fail(error.message) : { ok: true };
    },
  };

  // deno-lint-ignore no-explicit-any
  async function noteOf(e: any) {
    const { data } = await db.from("event_notes").select("*").eq("connection_id", e.connection_id).eq("uid", e.uid).maybeSingle();
    return data;
  }
  // deno-lint-ignore no-explicit-any
  async function upsertNote(e: any, f: Record<string, unknown>) {
    const old = await noteOf(e);
    const row = { household_id: hid, connection_id: e.connection_id, uid: e.uid, title: null, note: null, drop_off: null, pick_up: null,
      hidden: false, arrive_at: null, uniform: null, color: null, ...(old || {}), ...f, updated_at: new Date().toISOString() };
    delete (row as Record<string, unknown>).updated_by;
    return await db.from("event_notes").upsert(row, { onConflict: "connection_id,uid" });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  const auth = req.headers.get("Authorization") || "";
  if (!auth) return json({ error: "sign in first" }, 401);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: u } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!u?.user) return json({ error: "sign in first" }, 401);
  const me = u.user.id;

  let body: { messages?: { role: string; content: string }[] } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  // Keep the last dozen turns, each a sensible length.
  const messages = (body.messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12).map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 4000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "nothing to answer" }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Homebase needs its Anthropic API key in Supabase first." }, 503);

  const { data: member } = await db.from("members").select("household_id,display_name").eq("user_id", me).maybeSingle();
  if (!member) return json({ error: "not in a household" }, 403);
  const hid = member.household_id;
  const today = todayInHome(), end = addDays(today, 21);

  const [{ data: people }, { data: members }, { data: items }, { data: events }, { data: schedule }, { data: notes }, { data: rules }] = await Promise.all([
    db.from("people").select("id,name,kind,about,user_id").eq("household_id", hid),
    db.from("members").select("user_id,display_name").eq("household_id", hid),
    db.from("items").select("id,title,notes,due_date,due_time,start_date,done,inbox,visibility,assigned_to,created_by,person_id,kind,response,from_name,source")
      .eq("household_id", hid).eq("dismissed", false).eq("done", false).limit(300),
    db.from("events").select("id,connection_id,uid,title,location,all_day,starts_at,start_date,end_date,person_id,arrive_at,uniform,drive_min")
      .eq("household_id", hid).lte("start_date", end).gte("end_date", today).order("start_date").limit(400),
    db.from("schedule").select("user_id,kind,start_date,end_date,place,note")
      .eq("household_id", hid).gte("end_date", today).lte("start_date", end).order("start_date"),
    db.from("event_notes").select("connection_id,uid,title,note,drop_off,pick_up,hidden,arrive_at,uniform").eq("household_id", hid),
    db.from("event_rules").select("connection_id,title,dow,start_time,drop_off,pick_up").eq("household_id", hid),
  ]);
  // Weekly driver rules: same calendar, title, weekday and start time (home time zone).
  const ruleOf = new Map((rules || []).map((r) => [`${r.connection_id}|${r.title}|${r.dow}|${r.start_time}`, r]));
  const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, weekday: "short" });
  const hmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: HOME_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const seriesKey = (e: { connection_id: string; title: string; starts_at: string }) =>
    `${e.connection_id}|${(e.title || "").trim()}|${DOW.indexOf(dowFmt.format(new Date(e.starts_at)))}|${hmFmt.format(new Date(e.starts_at))}`;
  const noteOf = new Map((notes || []).map((n) => [n.connection_id + "|" + n.uid, n]));

  const personName = new Map((people || []).map((p) => [p.id, p.name]));
  const userName = (id: string | null) => !id ? "" : id === me ? `${member.display_name} (you)` : (members || []).find((m) => m.user_id === id)?.display_name || "someone";
  const when = (d: string | null, t: string | null) => d ? `${weekday(d)}${t ? " " + t.slice(0, 5) : ""}` : "no date";

  const fam = (people || []).map((p) => `- ${p.name} (${p.kind === "kid" ? "child" : p.kind === "helper" ? "grandparent/helper" : "adult"})${p.about ? ": " + clip(p.about, 300) : ""}`).join("\n");
  const itemLine = (i: NonNullable<typeof items>[number]) => {
    const bits = [`[todo ${i.id}]`, when(i.due_date, i.due_time), clip(i.title, 140)];
    if (i.start_date && i.start_date > today) bits.push(`waiting in Later until ${weekday(i.start_date)}`);
    if (i.person_id && personName.get(i.person_id)) bits.push(`for ${personName.get(i.person_id)}`);
    if (i.visibility === "family") bits.push(i.assigned_to ? `family, ${userName(i.assigned_to)} doing it` : "family, anyone");
    else bits.push("personal");
    if (i.kind === "request" && i.response) bits.push(i.response === "accepted" ? "accepted" : "declined");
    if (i.from_name) bits.push(`from ${clip(i.from_name, 40)}`);
    if (i.notes) bits.push(clip(i.notes, 200));
    return "- " + bits.join(" | ");
  };
  // Unsorted requests are listed on their own (they aren't to-dos yet).
  const todos = (items || []).filter((i) => !i.inbox);
  const waiting = (items || []).filter((i) => i.inbox && i.created_by === me);
  const evLines = (events || []).flatMap((e) => {
    const n = noteOf.get(e.connection_id + "|" + e.uid);
    if (n?.hidden) return [];
    const bits = [`[event ${e.id}${String(e.uid || "").startsWith("hb-") ? ", made in Homebase" : ""}]`, `${weekday(e.start_date)}${e.all_day ? "" : " " + hhmm(e.starts_at)}`, clip(n?.title || e.title, 120)];
    if (e.person_id && personName.get(e.person_id)) bits.push(personName.get(e.person_id)!);
    if (e.location) bits.push(clip(e.location, 60));
    const arrive = n?.arrive_at || e.arrive_at;
    if (arrive) bits.push(`arrive ${hhmm(arrive)}`);
    if (n?.uniform || e.uniform) bits.push(`uniform ${clip(n?.uniform || e.uniform, 40)}`);
    if (!e.all_day && typeof e.drive_min === "number") {
      // leave by: arrival (or start) minus the drive, rounded down to 5 minutes
      const t = new Date(new Date(arrive || e.starts_at).getTime() - e.drive_min * 60000);
      t.setUTCMinutes(t.getUTCMinutes() - (t.getUTCMinutes() % 5), 0, 0);
      bits.push(`~${e.drive_min} min drive from home, leave by ${hhmm(t.toISOString())}`);
    }
    const rule = !e.all_day && e.starts_at ? ruleOf.get(seriesKey(e)) : undefined;
    const drop = n?.drop_off || rule?.drop_off, pick = n?.pick_up || rule?.pick_up;
    if (drop) bits.push(`${personName.get(drop) || "someone"} driving`);
    if (pick) bits.push(`${personName.get(pick) || "someone"} picking up`);
    if (n?.note) bits.push(clip(n.note, 160));
    return ["- " + bits.join(" | ")];
  });
  const schedLines = (schedule || []).map((s) => `- ${userName(s.user_id)}: ${s.kind}${s.place ? " in " + s.place : ""} ${weekday(s.start_date)}${s.end_date !== s.start_date ? " to " + weekday(s.end_date) : ""}${s.note ? " (" + clip(s.note, 80) + ")" : ""}`);

  const system =
    `You are Homebase, a calm, practical chief of staff for ${member.display_name}'s family. Today is ${weekday(today)} (${today}, ${HOME_TZ}). ` +
    `Help them prioritize, plan the week, spot conflicts (two places at once, a parent traveling on a pickup day), and draft short notes or messages. ` +
    `Be brief and concrete: lead with the answer, use short lists, name days and times. Don't invent facts that aren't below; ` +
    `say so when something isn't in Homebase. Calendar titles may start with a kid's initial (O = Owen, P = Piper). ` +
    `When an event shows who's driving or picking up, use it; when a kid's event has no driver, you can point that out. ` +
    `For the week ahead, list each kid event with its start time, arrival time if given, uniform if given, and the ` +
    `approximate drive and leave-by time (these are rough, from home without traffic).\n\n` +
    `You CAN change Homebase with your tools: add events to the Homebase calendar (one-off or weekly), move or delete events made in Homebase, ` +
    `set drivers, notes, colors, arrival and uniform on any event, hide synced events, add to-dos, and change, finish, sort or dismiss to-dos and requests. ` +
    `When they ask for a change, make it with the tools (don't tell them how to do it themselves), then say in a line or two what you did. ` +
    `Only say something is done if the tool returned ok. Don't make changes they didn't ask for; if it's unclear which event or to-do they mean, ask. ` +
    `"Calendar" means the Homebase calendar. Use the ids in square brackets with the tools. ` +
    `Events from synced calendars (TeamSnap, iCloud…) can't be moved or retimed, only given details or hidden.\n\n` +
    `Drivers (adults and helpers): ${(people || []).filter((p) => p.kind !== "kid").map((p) => p.name).join(", ") || "(none)"}\n` +
    `Adults with a login you can hand to-dos to: ${(members || []).filter((m) => m.user_id !== me).map((m) => m.display_name).join(", ") || "(none)"}\n\n` +
    `The family:\n${fam || "(none listed)"}\n\n` +
    `Open to-dos (${todos.length}):\n${todos.map(itemLine).join("\n") || "(none)"}\n\n` +
    `Waiting in Requests, not sorted yet (${waiting.length}):\n${waiting.map(itemLine).join("\n") || "(none)"}\n\n` +
    `Calendar, next three weeks:\n${evLines.join("\n") || "(nothing)"}\n\n` +
    `Who's where (trips, office days):\n${schedLines.join("\n") || "(nothing entered)"}`;

  const tools = makeTools({ db, me, hid, today, people: people || [], members: members || [] });
  try {
    const client = new Anthropic({ apiKey });
    // deno-lint-ignore no-explicit-any
    const convo: any[] = messages.slice();
    let changed = false;
    // deno-lint-ignore no-explicit-any
    let res: any = null;
    for (let round = 0; round < 8; round++) {
      res = await client.messages.create({
        model: MODEL,
        // Haiku thinks before answering; leave room for both, and keep the thinking light.
        max_tokens: 8000,
        output_config: { effort: "low" },
        system,
        tools: TOOL_DEFS,
        messages: convo,
      // deno-lint-ignore no-explicit-any
      } as any);
      if (res.stop_reason !== "tool_use") break;
      convo.push({ role: "assistant", content: res.content });
      const results = [];
      // deno-lint-ignore no-explicit-any
      for (const b of res.content.filter((x: any) => x.type === "tool_use")) {
        let out: { ok: boolean; [k: string]: unknown };
        try { out = await tools[b.name as keyof typeof tools](b.input); } catch (e) { out = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
        if (out.ok) changed = true;
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out), is_error: !out.ok });
      }
      convo.push({ role: "user", content: results });
    }
    if (res.stop_reason === "refusal") return json({ reply: "I can't help with that one.", changed });
    // deno-lint-ignore no-explicit-any
    const reply = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    if (!reply) console.error("assistant: empty reply", res.stop_reason, JSON.stringify(res.usage));
    return json({ reply: reply || (changed ? "Done." : "Sorry, I didn't get an answer that time. Try asking again."), changed });
  } catch (e) {
    console.error("assistant", e instanceof Error ? e.message : e);
    return json({ error: "Couldn't reach Claude just now. Try again in a minute." }, 502);
  }
});
