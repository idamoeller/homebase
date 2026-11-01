// Homebase — read school/activity emails sent by the Gmail script and turn them into
// suggested to-dos and events in the owner's Requests inbox.
//   GET  ?config=1        → the Gmail search built from the household's watch list
//   POST {account, messages:[{id, from, subject, date, body}]} → extract and file suggestions
// Every call carries the Gmail account's key in the x-homebase-key header.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";

const MODEL = Deno.env.get("HOMEBASE_MODEL") ?? "claude-opus-5-5";
const HOME_TZ = Deno.env.get("HOME_TZ") ?? "America/New_York";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Gmail search: anything from a watched sender, mentioning a watched name, or labelled "Homebase".
function buildQuery(watch: { kind: string; value: string }[]): string {
  const q = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);
  const from = watch.filter((w) => w.kind === "from").map((w) => q(w.value));
  const words = watch.filter((w) => w.kind === "words").map((w) => q(w.value));
  const parts: string[] = [];
  if (from.length) parts.push(`from:(${from.join(" OR ")})`);
  parts.push(...words);
  parts.push("label:homebase");
  return parts.join(" OR ");
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["relevant", "items"],
  properties: {
    relevant: { type: "boolean", description: "Does this email contain anything a parent needs to act on or attend?" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "kind", "date", "time", "person", "details"],
        properties: {
          title: { type: "string", description: "Short, specific. Start with the child's name when it's about one child." },
          kind: { type: "string", enum: ["todo", "event", "deadline", "change"] },
          date: { type: "string", description: "YYYY-MM-DD, or empty if none" },
          time: { type: "string", description: "HH:MM 24-hour, or empty if none" },
          person: { type: "string", description: "Exactly one of the family names given, or empty" },
          details: { type: "string", description: "1–2 sentences: where, cost, what to bring, link, who to reply to" },
        },
      },
    },
  },
};

function todayInHome(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

type Msg = { id: string; from: string; subject: string; date: string; body: string };
type Extracted = { relevant: boolean; items: { title: string; kind: string; date: string; time: string; person: string; details: string }[] };

async function extract(client: Anthropic, names: string, msg: Msg): Promise<Extracted | null> {
  const system =
    `You help a busy working parent who misses things buried in school and activity emails. ` +
    `Family members: ${names}. Today is ${todayInHome()} (${HOME_TZ}).\n\n` +
    `From the email, list only what the parents need to act on or show up for: sign-up and registration deadlines, ` +
    `forms and permission slips, payments due, things to bring or wear, events to attend (concerts, recitals, games, ` +
    `conferences, meetings), and schedule changes (cancellations, early release, no school, new time or place). ` +
    `Skip general newsletter content with nothing to do, marketing, receipts, and anything already in the past. ` +
    `One item per distinct action or event; don't repeat the same thing twice. If nothing qualifies, return relevant=false and no items. ` +
    `Use the email's date to resolve words like "this Friday" or "next week".`;
  const user =
    `From: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n` +
    msg.body.slice(0, 20000);

  // deno-lint-ignore no-explicit-any
  const res: any = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  // deno-lint-ignore no-explicit-any
  } as any);
  if (res.stop_reason === "refusal") return null;
  // deno-lint-ignore no-explicit-any
  const text = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  try { return JSON.parse(text) as Extracted; } catch { return null; }
}

function senderName(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = (m ? m[1] : from.replace(/<.*>/, "")).trim();
  return (name || from).slice(0, 60);
}

Deno.serve(async (req) => {
  const key = req.headers.get("x-homebase-key") || "";
  if (!key) return json({ error: "missing key" }, 401);
  const { data: conn } = await admin.from("connections").select("*")
    .eq("kind", "gmail").eq("token_hash", await sha256Hex(key)).maybeSingle();
  if (!conn) return json({ error: "unknown key" }, 401);

  if (req.method === "GET") {
    const { data: watch } = await admin.from("email_watch").select("kind,value").eq("household_id", conn.household_id);
    return json({ query: buildQuery(watch || []) });
  }
  if (req.method !== "POST") return json({ error: "use GET or POST" }, 405);

  let body: { account?: string; messages?: Msg[] } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const msgs = (body.messages || []).slice(0, 10);
  if (!msgs.length) return json({ processed: 0 });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    await admin.from("connections").update({ last_error: "Add your Anthropic API key in Supabase (Edge Functions → Secrets) so Homebase can read emails." }).eq("id", conn.id);
    return json({ error: "no Anthropic key yet" }, 503);
  }
  const client = new Anthropic({ apiKey });

  const { data: seenRows } = await admin.from("email_seen").select("message_id")
    .eq("connection_id", conn.id).in("message_id", msgs.map((m) => m.id));
  const seen = new Set((seenRows || []).map((r) => r.message_id));
  const fresh = msgs.filter((m) => m.id && !seen.has(m.id));

  const { data: people } = await admin.from("people").select("name,kind").eq("household_id", conn.household_id);
  const names = (people || []).map((p) => `${p.name} (${p.kind === "kid" ? "kid" : p.kind === "helper" ? "grandparent/helper" : "parent"})`).join(", ");
  const account = String(body.account || "");

  let added = 0, errors = 0;
  const done: string[] = [...seen]; // ids the script can stop resending
  await Promise.all(fresh.map(async (m) => {
    try {
      const out = await extract(client, names, m);
      const items = out && out.relevant ? out.items : [];
      const link = `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : "u/0/"}#all/${m.id}`;
      const rows = items.map((it) => ({
        household_id: conn.household_id, created_by: conn.created_by, assigned_to: conn.created_by,
        visibility: "personal", kind: "task", inbox: true, source: "email", source_ref: m.id,
        title: (it.person && !it.title.toLowerCase().startsWith(it.person.toLowerCase()) ? `${it.person}: ` : "") + it.title.slice(0, 200),
        due_date: /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : null,
        due_time: /^\d{2}:\d{2}$/.test(it.time) ? it.time : null,
        notes: [it.details, `Email: “${m.subject}”`, link].filter(Boolean).join("\n"),
        from_name: senderName(m.from),
      }));
      if (rows.length) {
        const ins = await admin.from("items").insert(rows);
        if (ins.error) throw ins.error;
        added += rows.length;
      }
      await admin.from("email_seen").insert({ connection_id: conn.id, message_id: m.id, items_found: rows.length });
      done.push(m.id);
    } catch (e) {
      errors++;
      console.error("email", m.id, e instanceof Error ? e.message : e);
    }
  }));

  await admin.from("connections").update({
    emails_read: (conn.emails_read || 0) + fresh.length - errors,
    last_email_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    last_error: errors ? `${errors} email(s) couldn't be read; they'll be retried next time.` : null,
    event_count: (conn.event_count || 0) + added,
  }).eq("id", conn.id);

  return json({ processed: fresh.length, skipped: msgs.length - fresh.length, added, errors, done });
});
