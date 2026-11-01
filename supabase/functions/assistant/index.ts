// Homebase — "Ask Homebase": a chat that knows your to-dos, requests, calendar and schedule.
//   POST {messages:[{role:'user'|'assistant', content}]} → {reply}
// It reads with the signed-in person's own login, so it only sees what they can see in the app.
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

  const [{ data: people }, { data: members }, { data: items }, { data: events }, { data: schedule }] = await Promise.all([
    db.from("people").select("id,name,kind,about,user_id").eq("household_id", hid),
    db.from("members").select("user_id,display_name").eq("household_id", hid),
    db.from("items").select("title,notes,due_date,due_time,done,inbox,visibility,assigned_to,created_by,person_id,kind,response,from_name,source")
      .eq("household_id", hid).eq("dismissed", false).eq("done", false).limit(300),
    db.from("events").select("title,location,all_day,starts_at,start_date,end_date,person_id")
      .eq("household_id", hid).lte("start_date", end).gte("end_date", today).order("start_date").limit(400),
    db.from("schedule").select("user_id,kind,start_date,end_date,place,note")
      .eq("household_id", hid).gte("end_date", today).lte("start_date", end).order("start_date"),
  ]);

  const personName = new Map((people || []).map((p) => [p.id, p.name]));
  const userName = (id: string | null) => !id ? "" : id === me ? `${member.display_name} (you)` : (members || []).find((m) => m.user_id === id)?.display_name || "someone";
  const when = (d: string | null, t: string | null) => d ? `${weekday(d)}${t ? " " + t.slice(0, 5) : ""}` : "no date";

  const fam = (people || []).map((p) => `- ${p.name} (${p.kind === "kid" ? "child" : p.kind === "helper" ? "grandparent/helper" : "adult"})${p.about ? ": " + clip(p.about, 300) : ""}`).join("\n");
  const itemLine = (i: NonNullable<typeof items>[number]) => {
    const bits = [when(i.due_date, i.due_time), clip(i.title, 140)];
    if (i.person_id && personName.get(i.person_id)) bits.push(`for ${personName.get(i.person_id)}`);
    if (i.visibility === "family") bits.push(i.assigned_to ? `family, ${userName(i.assigned_to)} doing it` : "family, anyone");
    else bits.push("personal");
    if (i.kind === "request" && i.response) bits.push(i.response === "accepted" ? "accepted" : "declined");
    if (i.from_name) bits.push(`from ${clip(i.from_name, 40)}`);
    if (i.notes) bits.push(clip(i.notes, 200));
    return "- " + bits.join(" | ");
  };
  const todos = (items || []).filter((i) => !i.inbox);
  const inbox = (items || []).filter((i) => i.inbox && i.created_by === me);
  const evLines = (events || []).map((e) => `- ${weekday(e.start_date)}${e.all_day ? "" : " " + hhmm(e.starts_at)} | ${clip(e.title, 120)}${e.person_id && personName.get(e.person_id) ? " | " + personName.get(e.person_id) : ""}${e.location ? " | " + clip(e.location, 60) : ""}`);
  const schedLines = (schedule || []).map((s) => `- ${userName(s.user_id)}: ${s.kind}${s.place ? " in " + s.place : ""} ${weekday(s.start_date)}${s.end_date !== s.start_date ? " to " + weekday(s.end_date) : ""}${s.note ? " (" + clip(s.note, 80) + ")" : ""}`);

  const system =
    `You are Homebase, a calm, practical chief of staff for ${member.display_name}'s family. Today is ${weekday(today)} (${today}, ${HOME_TZ}). ` +
    `Help them prioritize, plan the week, spot conflicts (two places at once, a parent traveling on a pickup day), and draft short notes or messages. ` +
    `Be brief and concrete: lead with the answer, use short lists, name days and times. Don't invent facts that aren't below; ` +
    `say so when something isn't in Homebase. You can't change anything in Homebase yourself, so when they should add, move or mark ` +
    `something, tell them what to do in one line.\n\n` +
    `The family:\n${fam || "(none listed)"}\n\n` +
    `Open to-dos (${todos.length}):\n${todos.map(itemLine).join("\n") || "(none)"}\n\n` +
    `Waiting in Requests, not yet sorted (${inbox.length}):\n${inbox.map(itemLine).join("\n") || "(none)"}\n\n` +
    `Calendar, next three weeks:\n${evLines.join("\n") || "(nothing)"}\n\n` +
    `Who's where (trips, office days):\n${schedLines.join("\n") || "(nothing entered)"}`;

  try {
    const client = new Anthropic({ apiKey });
    // deno-lint-ignore no-explicit-any
    const res: any = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages,
    });
    // deno-lint-ignore no-explicit-any
    const reply = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    return json({ reply: reply || "Sorry, I didn't get an answer that time. Try asking again." });
  } catch (e) {
    console.error("assistant", e instanceof Error ? e.message : e);
    return json({ error: "Couldn't reach Claude just now. Try again in a minute." }, 502);
  }
});
