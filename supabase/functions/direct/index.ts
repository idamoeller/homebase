// Homebase — "tell Haiku what to do" with one request in the Requests list.
//   POST {item_id, instruction} → {reply, changes:{…}, action, assign_to, calendar}
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

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "title", "date", "time", "person", "notes_add", "action", "assign_to", "calendar"],
  properties: {
    reply: { type: "string", description: "One short sentence back to the parent: what you did, or the answer to their question." },
    title: { type: "string", description: "New title if they asked to change or fix it, else empty." },
    date: { type: "string", description: "New due date YYYY-MM-DD if they gave or changed one, \"none\" to clear it, else empty." },
    time: { type: "string", description: "New due time HH:MM 24-hour, \"none\" to clear it, else empty." },
    person: { type: "string", description: "Who it's for: exactly one family name given, \"none\" to clear, else empty." },
    notes_add: { type: "string", description: "A short note to add (something they told you to remember), else empty." },
    action: {
      type: "string",
      enum: ["keep", "mine", "family", "assign", "done", "dismiss"],
      description: "keep = leave it in Requests; mine = move to my personal to-dos; family = family to-do anyone can do; assign = hand to another adult with a login; done = already handled; dismiss = not needed / ignore it. Adding it to the calendar alone is \"done\" unless they also need to do something.",
    },
    assign_to: { type: "string", description: "For assign: exactly one of the adult login names given. Else empty." },
    calendar: {
      type: "object",
      additionalProperties: false,
      required: ["add", "title", "date", "start", "end", "location"],
      description: "Only when they ask to put it on the calendar.",
      properties: {
        add: { type: "boolean" },
        title: { type: "string", description: "Event title; may start with the kid's name. Empty if add is false." },
        date: { type: "string", description: "YYYY-MM-DD" },
        start: { type: "string", description: "HH:MM 24-hour, empty for all day" },
        end: { type: "string", description: "HH:MM 24-hour, empty if unknown" },
        location: { type: "string" },
      },
    },
  },
};

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

  let body: { item_id?: string; instruction?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const instruction = clip(body.instruction, 2000);
  if (!body.item_id || !instruction) return json({ error: "nothing to do" }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "Homebase needs its Anthropic API key in Supabase first." }, 503);

  const { data: item } = await db.from("items")
    .select("id,household_id,title,notes,due_date,due_time,person_id,from_name,source,created_at")
    .eq("id", body.item_id).maybeSingle();
  if (!item) return json({ error: "That request isn't there any more." }, 404);
  const hid = item.household_id;
  const [{ data: people }, { data: members }] = await Promise.all([
    db.from("people").select("id,name,kind,about,user_id").eq("household_id", hid),
    db.from("members").select("user_id,display_name").eq("household_id", hid),
  ]);
  const today = todayInHome();
  const personName = new Map((people || []).map((p) => [p.id, p.name]));
  const fam = (people || []).map((p) => `- ${p.name} (${p.user_id === me ? "the parent you're talking to" : p.kind === "kid" ? "child" : p.kind === "helper" ? "grandparent/helper" : "adult"})${p.about ? ": " + clip(p.about, 300) : ""}`).join("\n");
  const adults = (members || []).filter((m) => m.user_id !== me).map((m) => m.display_name);

  const system =
    `You help a busy parent sort one request in Homebase, their family organizer. Today is ${weekday(today)} (${today}, ${HOME_TZ}). ` +
    `They'll tell you in a few words what to do with it. Turn that into changes; only change what they asked for, and leave every other field empty. ` +
    `Work out dates from today ("Thursday" = the coming Thursday). If they ask a question about the request, answer it in reply and use action "keep". ` +
    `If they want it on the calendar, fill in calendar using the request's date, time and place unless they said otherwise.\n\n` +
    `The family:\n${fam || "(none listed)"}\n\n` +
    `Adults you can hand things to: ${adults.join(", ") || "(none yet)"}`;

  const req_ =
    `The request:\n` +
    `Title: ${item.title}\n` +
    `Due: ${item.due_date ? weekday(item.due_date) + " (" + item.due_date + ")" : "no date"}${item.due_time ? " at " + String(item.due_time).slice(0, 5) : ""}\n` +
    `For: ${personName.get(item.person_id) || "not set"}\n` +
    `From: ${item.from_name || "someone"}${item.source === "email" ? " (read from an email)" : ""}\n` +
    `Notes: ${clip(item.notes, 1500) || "(none)"}\n\n` +
    `What they said: ${instruction}`;

  try {
    const client = new Anthropic({ apiKey });
    // deno-lint-ignore no-explicit-any
    const res: any = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: req_ }],
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    // deno-lint-ignore no-explicit-any
    } as any);
    if (res.stop_reason === "refusal") return json({ error: "I can't help with that one." }, 422);
    // deno-lint-ignore no-explicit-any
    const out = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    let plan;
    try { plan = JSON.parse(out); } catch {
      console.error("direct: bad output", res.stop_reason, JSON.stringify(res.usage));
      return json({ error: "Sorry, I didn't get that. Try saying it another way." }, 502);
    }
    // Names → ids, checked against this household.
    const nm = (s: string) => String(s || "").trim().toLowerCase();
    const p = nm(plan.person);
    const person = p === "none" ? null : (people || []).find((x) => nm(x.name) === p);
    const who = (members || []).find((m) => m.user_id !== me && nm(m.display_name) === nm(plan.assign_to));
    const ok = (re: RegExp, s: string) => re.test(String(s || "")) ? s : "";
    return json({
      reply: plan.reply,
      changes: {
        title: clip(plan.title, 200) || undefined,
        due_date: plan.date === "none" ? null : ok(/^\d{4}-\d{2}-\d{2}$/, plan.date) || undefined,
        due_time: plan.time === "none" ? null : ok(/^\d{2}:\d{2}$/, plan.time) || undefined,
        person_id: p === "none" ? null : person ? person.id : undefined,
        notes_add: clip(plan.notes_add, 500) || undefined,
      },
      action: plan.action === "assign" && !who ? "keep" : plan.action,
      assign_to: who ? who.user_id : null,
      calendar: plan.calendar?.add && /^\d{4}-\d{2}-\d{2}$/.test(plan.calendar.date) ? {
        title: clip(plan.calendar.title, 200) || item.title,
        date: plan.calendar.date,
        start: ok(/^\d{2}:\d{2}$/, plan.calendar.start),
        end: ok(/^\d{2}:\d{2}$/, plan.calendar.end),
        location: clip(plan.calendar.location, 200),
      } : null,
    });
  } catch (e) {
    console.error("direct", e instanceof Error ? e.message : e);
    return json({ error: "Couldn't reach Claude just now. Try again in a minute." }, 502);
  }
});
