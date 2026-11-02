// Homebase — "tell Haiku what to do".
//   POST {item_id, instruction} → {reply, changes:{…}, action, assign_to, calendar}   (one request in Requests)
//   POST {day, instruction}     → {reply, create:{kind:'todo'|'event', …}}             (right-click on the board)
//   POST {event:{…}, instruction} → {reply, event:{…changes}, todo}                    (an event's details sheet)
//   POST {schedule:true, instruction} → {reply, add:[…], update:[…], remove:[ids]}     (Who's where: trips, office days)
// Everything stays inside Homebase: "calendar" means the Homebase calendar unless they name another one.
// Claude only proposes; the app applies the changes with the person's own login (so Undo works
// and nothing reaches past what they can see).
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
const weekday = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
const clip = (t: string | null | undefined, n: number) => (t || "").replace(/\s+/g, " ").trim().slice(0, n);

const IN_APP =
  `Everything happens inside Homebase unless they explicitly say otherwise: "calendar" or "put it on the calendar" means the Homebase calendar, ` +
  `"to-do" means a Homebase to-do. Set device to true only if they explicitly name their phone, iPhone, Apple, iCloud, Google or Outlook calendar, or ask for a file. ` +
  `Be flexible: if part of what they ask isn't one of the fields, do everything you can, put anything worth keeping in a note, ` +
  `and only then say in reply (briefly) what Homebase can't do yet. Never refuse the whole request because one part doesn't fit. `;

const CAL = {
  type: "object",
  additionalProperties: false,
  required: ["add", "title", "date", "start", "end", "location", "visibility", "device"],
  description: "Only when they ask to put it on the calendar.",
  properties: {
    add: { type: "boolean" },
    title: { type: "string", description: "Event title. Empty if add is false." },
    date: { type: "string", description: "YYYY-MM-DD" },
    start: { type: "string", description: "HH:MM 24-hour, empty for all day" },
    end: { type: "string", description: "HH:MM 24-hour, empty if unknown" },
    location: { type: "string" },
    visibility: { type: "string", enum: ["family", "personal"], description: "personal only if they say just me / private, or it's clearly only theirs (their own doctor, work)" },
    device: { type: "boolean", description: "true ONLY if they explicitly asked for their phone/Apple/iCloud/Google calendar or a file" },
  },
};

const NEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "kind", "title", "date", "time", "start_date", "end", "location", "person", "visibility", "assign_to", "notes", "device"],
  properties: {
    reply: { type: "string", description: "One short sentence: what you added." },
    kind: { type: "string", enum: ["todo", "event"], description: "event = something happening at a time/place that goes on the calendar; todo = a task to get done (it can have a due date/time). Follow their words: \"calendar\" → event, \"to-do\"/\"remind me\" → todo." },
    title: { type: "string", description: "Short and specific." },
    date: { type: "string", description: "Event day, or a to-do's due date: YYYY-MM-DD; the day they clicked unless they said another. A to-do they only want to start later may have no due date (empty)." },
    time: { type: "string", description: "HH:MM 24-hour, empty if none (all-day event / no time)." },
    start_date: { type: "string", description: "To-dos only: the day to START showing it on their to-do list, YYYY-MM-DD, when they say to do it later (\"next week\" = the coming Monday, \"on Thursday\", \"after the 15th\", \"not now\"). Until then it waits in Later. Else empty." },
    end: { type: "string", description: "Event end HH:MM 24-hour, empty if unknown." },
    location: { type: "string" },
    person: { type: "string", description: "Who it's for: exactly one family name given, else empty." },
    visibility: { type: "string", enum: ["family", "personal"], description: "Events: family unless it's clearly only theirs or they say just me. To-dos: personal unless they say family/shared or hand it to someone." },
    assign_to: { type: "string", description: "To-dos only: an adult login name if they hand it to them, else empty." },
    notes: { type: "string", description: "Extra details they gave, else empty." },
    device: { type: "boolean", description: "true ONLY if they explicitly asked for their phone/Apple/iCloud/Google calendar or a file" },
  },
};

const EVENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "title", "note_add", "drop_off", "pick_up", "weekly", "arrive", "uniform", "color", "hide", "date", "start", "end", "location", "person", "todo"],
  properties: {
    reply: { type: "string", description: "One short sentence: what you changed, or the answer to their question." },
    title: { type: "string", description: "New title only if they asked, else empty." },
    note_add: { type: "string", description: "A note to add to the event (what to bring, carpool, reminders about it), else empty." },
    drop_off: { type: "string", description: "Who's driving there: exactly one driver name given, \"none\" to clear, else empty." },
    pick_up: { type: "string", description: "Who's picking up: exactly one driver name given, \"none\" to clear, else empty. \"X both ways\" sets drop_off and pick_up." },
    weekly: { type: "string", enum: ["", "yes", "no"], description: "yes = the drivers are the same every week for this practice/series (\"every week\", \"always\"); no = just this date; empty if not said." },
    arrive: { type: "string", description: "Arrival time HH:MM 24-hour if they gave one, else empty." },
    uniform: { type: "string", description: "Uniform/what to wear if they gave it, else empty." },
    color: { type: "string", description: "Event color as #RRGGBB if they asked for one: use the matching color from the list given (red, orange, green…); for another color pick a muted hex. \"none\" = back to automatic. Else empty." },
    hide: { type: "boolean", description: "true if they want it removed/hidden/deleted (e.g. cancelled, not going)." },
    date: { type: "string", description: "Homebase-calendar events only: new date YYYY-MM-DD if they moved it, else empty." },
    start: { type: "string", description: "Homebase-calendar events only: new start HH:MM 24-hour, \"none\" for all day, else empty." },
    end: { type: "string", description: "Homebase-calendar events only: new end HH:MM, else empty." },
    location: { type: "string", description: "Homebase-calendar events only: new place, else empty." },
    person: { type: "string", description: "Homebase-calendar events only: who it's for, exactly one family name, \"none\" to clear, else empty." },
    todo: {
      type: "object",
      additionalProperties: false,
      required: ["add", "title", "date", "time", "start_date"],
      description: "Only if they ask for a to-do or reminder (\"remind me to buy shin guards\").",
      properties: {
        add: { type: "boolean" },
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD due date, usually on or before the event; empty if none" },
        time: { type: "string", description: "HH:MM 24-hour or empty" },
        start_date: { type: "string", description: "To-dos only: the day to START showing it on their to-do list, YYYY-MM-DD, when they say to do it later (\"next week\" = the coming Monday, \"on Thursday\", \"after the 15th\", \"not now\"). Until then it waits in Later. Else empty." },
      },
    },
  },
};

const SCHED_KINDS = ["travel", "office_drive", "office_boat", "wfh", "off"];
const SCHED_ENTRY = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "start_date", "end_date", "place", "note"],
  properties: {
    id: { type: "string", description: "For update: the [id] of their existing entry. Empty for add." },
    kind: { type: "string", enum: SCHED_KINDS, description: "travel = a trip away; office_drive = office day driving in; office_boat = office day on the commuter boat; wfh = working from home; off = a day off / vacation at home." },
    start_date: { type: "string", description: "YYYY-MM-DD" },
    end_date: { type: "string", description: "YYYY-MM-DD, same as start_date for one day" },
    place: { type: "string", description: "City or place for a trip, else empty." },
    note: { type: "string", description: "Extra detail worth keeping (flight times, back late Thursday), else empty." },
  },
};
const SCHED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "add", "update", "remove"],
  properties: {
    reply: { type: "string", description: "One short sentence: what you added, changed or removed, or the answer to their question." },
    add: { type: "array", items: SCHED_ENTRY, description: "New entries. Separate days that aren't in a row (\"office Tue and Thu\") are separate entries; a trip over several days is ONE entry." },
    update: { type: "array", items: SCHED_ENTRY, description: "Changes to their existing entries: the full entry with its id." },
    remove: { type: "array", items: { type: "string" }, description: "[id]s of existing entries to delete (cancelled trip, not going in)." },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "title", "date", "time", "start_date", "person", "notes_add", "action", "assign_to", "calendar"],
  properties: {
    reply: { type: "string", description: "One short sentence back to the parent: what you did, or the answer to their question." },
    title: { type: "string", description: "New title if they asked to change or fix it, else empty." },
    date: { type: "string", description: "New due date YYYY-MM-DD if they gave or changed one, \"none\" to clear it, else empty." },
    time: { type: "string", description: "New due time HH:MM 24-hour, \"none\" to clear it, else empty." },
    start_date: { type: "string", description: "To-dos only: the day to START showing it on their to-do list, YYYY-MM-DD, when they say to do it later (\"next week\" = the coming Monday, \"on Thursday\", \"after the 15th\", \"not now\"). Until then it waits in Later. Else empty." },
    person: { type: "string", description: "Who it's for: exactly one family name given, \"none\" to clear, else empty." },
    notes_add: { type: "string", description: "A short note to add (something they told you to remember), else empty." },
    action: {
      type: "string",
      enum: ["keep", "mine", "family", "assign", "done", "dismiss"],
      description: "keep = leave it in Requests; mine = move to my personal to-dos; family = family to-do anyone can do; assign = hand to another adult with a login; done = already handled; dismiss = not needed / ignore it. Adding it to the calendar alone is \"done\" unless they also need to do something.",
    },
    assign_to: { type: "string", description: "For assign: exactly one of the adult login names given. Else empty." },
    calendar: CAL,
  },
};

async function askClaude(apiKey: string, system: string, user: string, schema: unknown) {
  const client = new Anthropic({ apiKey });
  // deno-lint-ignore no-explicit-any
  const res: any = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  // deno-lint-ignore no-explicit-any
  } as any);
  if (res.stop_reason === "refusal") return { refused: true };
  // deno-lint-ignore no-explicit-any
  const out = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  try { return { plan: JSON.parse(out) }; } catch {
    console.error("direct: bad output", res.stop_reason, JSON.stringify(res.usage));
    return {};
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

  // deno-lint-ignore no-explicit-any
  let body: { item_id?: string; day?: string; event?: any; schedule?: boolean; instruction?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const instruction = clip(body.instruction, 2000);
  if (!instruction || (!body.item_id && !body.day && !body.event && !body.schedule)) return json({ error: "nothing to do" }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Homebase needs its Anthropic API key in Supabase first." }, 503);

  const { data: member } = await db.from("members").select("household_id").eq("user_id", me).maybeSingle();
  if (!member) return json({ error: "not in a household" }, 403);
  const hid = member.household_id;
  // deno-lint-ignore no-explicit-any
  let item: any = null;
  if (body.item_id) {
    ({ data: item } = await db.from("items")
      .select("id,household_id,title,notes,due_date,due_time,person_id,from_name,source,created_at")
      .eq("id", body.item_id).eq("household_id", hid).maybeSingle());
    if (!item) return json({ error: "That request isn't there any more." }, 404);
  }
  const [{ data: people }, { data: members }] = await Promise.all([
    db.from("people").select("id,name,kind,about,user_id").eq("household_id", hid),
    db.from("members").select("user_id,display_name").eq("household_id", hid),
  ]);
  const today = todayInHome();
  const personName = new Map((people || []).map((p) => [p.id, p.name]));
  const fam = (people || []).map((p) => `- ${p.name} (${p.user_id === me ? "the parent you're talking to" : p.kind === "kid" ? "child" : p.kind === "helper" ? "grandparent/helper" : "adult"})${p.about ? ": " + clip(p.about, 300) : ""}`).join("\n");
  const adults = (members || []).filter((m) => m.user_id !== me).map((m) => m.display_name);
  const context =
    `The family:\n${fam || "(none listed)"}\n\n` +
    `Adults you can hand things to: ${adults.join(", ") || "(none yet)"}`;

  // Names → ids, checked against this household.
  const nm = (s: string) => String(s || "").trim().toLowerCase();
  const personId = (s: string) => (people || []).find((x) => nm(x.name) === nm(s))?.id;
  const adultId = (s: string) => (members || []).find((m) => m.user_id !== me && nm(m.display_name) === nm(s))?.user_id;
  const ok = (re: RegExp, s: string) => re.test(String(s || "")) ? s : "";
  const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;

  try {
    // ── Who's where: their own trips and office days ──
    if (body.schedule) {
      const { data: mine } = await db.from("schedule").select("id,kind,start_date,end_date,place,note")
        .eq("household_id", hid).eq("user_id", me).gte("end_date", today).order("start_date").limit(120);
      const list = (mine || []).map((x) => `- [${x.id}] ${x.kind} ${x.start_date}${x.end_date !== x.start_date ? " to " + x.end_date : ""}${x.place ? " · " + x.place : ""}${x.note ? " — " + clip(x.note, 120) : ""}`).join("\n");
      const system =
        `You help a busy parent keep their own schedule in Homebase, their family organizer: trips away, office days (driving or the commuter boat), ` +
        `work-from-home days and days off, so the family knows where they'll be. Today is ${weekday(today)} (${today}, ${HOME_TZ}). ` +
        `They'll say it in a few words ("Chicago Nov 10 to 12", "office Tuesday and Thursday by boat", "cancel the Denver trip", "WFH all next week"). ` +
        `Work out dates from today ("Tuesday" = the coming Tuesday, "next week" = the coming Monday to Friday). ` +
        `"Office" with no way of getting there = office_drive. Weekdays only for a run of work days unless they say otherwise. ` +
        `Change only what they asked; to change or remove an existing entry use its [id]. If they only ask a question, answer in reply and change nothing. ` +
        `Be flexible: do everything you can and never refuse the whole request because one part doesn't fit.`;
      const user = `Their upcoming entries:\n${list || "(none)"}\n\nWhat they said: ${instruction}`;
      const r = await askClaude(apiKey, system, user, SCHED_SCHEMA);
      if (r.refused) return json({ error: "I can't help with that one." }, 422);
      const plan = r.plan;
      if (!plan) return json({ error: "Sorry, I didn't get that. Try saying it another way." }, 502);
      const ids = new Set((mine || []).map((x) => x.id));
      // deno-lint-ignore no-explicit-any
      const entry = (e: any) => {
        const start = ok(DATE, e.start_date), end = ok(DATE, e.end_date) || start;
        if (!start || !SCHED_KINDS.includes(e.kind)) return null;
        return { kind: e.kind, start_date: start, end_date: end < start ? start : end, place: clip(e.place, 100) || null, note: clip(e.note, 300) || null };
      };
      return json({
        reply: plan.reply,
        // deno-lint-ignore no-explicit-any
        add: (plan.add || []).map(entry).filter(Boolean).slice(0, 60),
        // deno-lint-ignore no-explicit-any
        update: (plan.update || []).filter((e: any) => ids.has(e.id)).map((e: any) => { const x = entry(e); return x && { id: e.id, ...x }; }).filter(Boolean),
        remove: (plan.remove || []).filter((id: string) => ids.has(id)),
      });
    }

    // ── an event's details sheet: drivers, notes, title, hide; Homebase events can also move ──
    if (body.event) {
      const ev = body.event;
      const hb = !!ev.homebase;
      const drivers = (people || []).filter((x) => x.kind !== "kid").map((x) => x.name);
      const system =
        `You help a busy parent with one event on their Homebase family calendar. Today is ${weekday(today)} (${today}, ${HOME_TZ}). ` +
        `They'll say in a few words what to change, or ask a question about it (then answer in reply and change nothing). ` +
        `Only change what they asked for and leave every other field empty. ` +
        (hb ? `This event was made in Homebase, so it can also be moved (date, time, place, who it's for). `
            : `This event comes from a synced calendar: you can't move it; date, start, end, location and person stay empty. `) +
        IN_APP + `\n\nDrivers you can pick from: ${drivers.join(", ") || "(none)"}\n\n` + context;
      const user =
        `The event:\n` +
        `Title: ${clip(ev.title, 200)}\n` +
        `When: ${clip(ev.when, 120)}\n` +
        `Where: ${clip(ev.location, 200) || "not given"}\n` +
        `For: ${clip(ev.for, 60) || "not set"}\n` +
        `Driving: ${clip(ev.drop_off, 60) || "not set"}; picking up: ${clip(ev.pick_up, 60) || "not set"}\n` +
        `Repeats weekly: ${ev.series ? "yes" : "no"}\n` +
        `Notes: ${clip(ev.note, 800) || "(none)"}\n` +
        `Color: ${clip(ev.color, 10) || "automatic (who it's for)"}; colors to pick from: ${clip(ev.colors, 400)}\n\n` +
        `What they said: ${instruction}`;
      const r = await askClaude(apiKey, system, user, EVENT_SCHEMA);
      if (r.refused) return json({ error: "I can't help with that one." }, 422);
      const plan = r.plan;
      if (!plan) return json({ error: "Sorry, I didn't get that. Try saying it another way." }, 502);
      const driverId = (s: string) => nm(s) === "none" ? null : (people || []).find((x) => x.kind !== "kid" && nm(x.name) === nm(s))?.id;
      const pp = nm(plan.person);
      return json({
        reply: plan.reply,
        event: {
          title: clip(plan.title, 200) || undefined,
          note_add: clip(plan.note_add, 500) || undefined,
          drop_off: plan.drop_off ? driverId(plan.drop_off) : undefined,
          pick_up: plan.pick_up ? driverId(plan.pick_up) : undefined,
          weekly: plan.weekly || undefined,
          arrive: ok(TIME, plan.arrive) || undefined,
          uniform: clip(plan.uniform, 100) || undefined,
          color: nm(plan.color) === "none" ? null : ok(/^#[0-9A-Fa-f]{6}$/, plan.color) || undefined,
          hide: !!plan.hide,
          date: hb ? ok(DATE, plan.date) || undefined : undefined,
          start: hb ? (plan.start === "none" ? null : ok(TIME, plan.start) || undefined) : undefined,
          end: hb ? ok(TIME, plan.end) || undefined : undefined,
          location: hb ? clip(plan.location, 200) || undefined : undefined,
          person_id: hb ? (pp === "none" ? null : personId(plan.person) || undefined) : undefined,
        },
        todo: plan.todo?.add && clip(plan.todo.title, 200)
          ? { title: clip(plan.todo.title, 200), date: ok(DATE, plan.todo.date), time: ok(TIME, plan.todo.time), start_date: ok(DATE, plan.todo.start_date) }
          : null,
      });
    }

    // ── right-click on the board: make a new to-do or Homebase calendar event ──
    if (!item) {
      const day = ok(DATE, String(body.day)) || today;
      const system =
        `You help a busy parent add things to Homebase, their family organizer. Today is ${weekday(today)} (${today}, ${HOME_TZ}). ` +
        `They right-clicked ${weekday(day)} (${day}) on their week board and typed a few words. Turn that into ONE new to-do or calendar event. ` +
        `Use ${day} unless they name another day ("Thursday" = the coming Thursday). ` + IN_APP + `\n\n` + context;
      const r = await askClaude(apiKey, system, `What they typed: ${instruction}`, NEW_SCHEMA);
      if (r.refused) return json({ error: "I can't help with that one." }, 422);
      const plan = r.plan;
      if (!plan || !clip(plan.title, 200)) return json({ error: "Sorry, I didn't get that. Try saying it another way." }, 502);
      const kind = plan.kind === "todo" ? "todo" : "event";
      const assigned = kind === "todo" ? adultId(plan.assign_to) || null : null;
      return json({
        reply: plan.reply,
        create: {
          kind,
          title: clip(plan.title, 200),
          date: kind === "todo" && !plan.date ? "" : ok(DATE, plan.date) || day,
          time: ok(TIME, plan.time),
          start_date: kind === "todo" ? ok(DATE, plan.start_date) : "",
          end: ok(TIME, plan.end),
          location: clip(plan.location, 200),
          person_id: personId(plan.person) || null,
          visibility: assigned ? "family" : plan.visibility === "personal" ? "personal" : "family",
          assigned_to: assigned,
          notes: clip(plan.notes, 1000),
          device: !!plan.device,
        },
      });
    }

    // ── one request in Requests ──
    const system =
      `You help a busy parent sort one request in Homebase, their family organizer. Today is ${weekday(today)} (${today}, ${HOME_TZ}). ` +
      `They'll tell you in a few words what to do with it. Turn that into changes; only change what they asked for, and leave every other field empty. ` +
      `Work out dates from today ("Thursday" = the coming Thursday). If they ask a question about the request, answer it in reply and use action "keep". ` +
      `If they want it on the calendar, fill in calendar using the request's date, time and place unless they said otherwise. ` +
      `If they say to deal with it later ("next week", "remind me Monday"), set start_date and use action "mine" (it waits in Later until then). ` + IN_APP + `\n\n` + context;
    const user =
      `The request:\n` +
      `Title: ${item.title}\n` +
      `Due: ${item.due_date ? weekday(item.due_date) + " (" + item.due_date + ")" : "no date"}${item.due_time ? " at " + String(item.due_time).slice(0, 5) : ""}\n` +
      `For: ${personName.get(item.person_id) || "not set"}\n` +
      `From: ${item.from_name || "someone"}${item.source === "email" ? " (read from an email)" : ""}\n` +
      `Notes: ${clip(item.notes, 1500) || "(none)"}\n\n` +
      `What they said: ${instruction}`;
    const r = await askClaude(apiKey, system, user, SCHEMA);
    if (r.refused) return json({ error: "I can't help with that one." }, 422);
    const plan = r.plan;
    if (!plan) return json({ error: "Sorry, I didn't get that. Try saying it another way." }, 502);
    const p = nm(plan.person);
    const who = adultId(plan.assign_to);
    return json({
      reply: plan.reply,
      changes: {
        title: clip(plan.title, 200) || undefined,
        due_date: plan.date === "none" ? null : ok(DATE, plan.date) || undefined,
        due_time: plan.time === "none" ? null : ok(TIME, plan.time) || undefined,
        start_date: ok(DATE, plan.start_date) || undefined,
        person_id: p === "none" ? null : personId(plan.person) || undefined,
        notes_add: clip(plan.notes_add, 500) || undefined,
      },
      action: plan.action === "assign" && !who ? "keep" : plan.action,
      assign_to: who || null,
      calendar: plan.calendar?.add && DATE.test(plan.calendar.date) ? {
        title: clip(plan.calendar.title, 200) || item.title,
        date: plan.calendar.date,
        start: ok(TIME, plan.calendar.start),
        end: ok(TIME, plan.calendar.end),
        location: clip(plan.calendar.location, 200),
        visibility: plan.calendar.visibility === "personal" ? "personal" : "family",
        device: !!plan.calendar.device,
      } : null,
    });
  } catch (e) {
    console.error("direct", e instanceof Error ? e.message : e);
    return json({ error: "Couldn't reach Claude just now. Try again in a minute." }, 502);
  }
});
