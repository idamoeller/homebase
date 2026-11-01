// Homebase — read school/activity emails sent by the Gmail script and turn them into
// suggested to-dos and events in the owner's Requests inbox.
//   GET  ?config=1        → the Gmail search built from the household's watch list
//   POST {account, messages:[{id, from, subject, date, body, attachments?}]} → extract and file suggestions
// Every call carries the Gmail account's key in the x-homebase-key header.
// Claude also reads PDF/image attachments and up to three public newsletter or sign-up links per email.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";

const MODEL = Deno.env.get("HOMEBASE_MODEL") ?? "claude-haiku-5-5";
const HOME_TZ = Deno.env.get("HOME_TZ") ?? "America/New_York";
const MAX_LINKS = 3;
const LINK_CHARS = 15000;

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

// ── links ─────────────────────────────────────────────────────────────────────
// Links worth opening: newsletters, sign-up sheets, school and PTO pages. Never unsubscribe,
// social media, maps, or anything that isn't a plain public web page.
const SKIP = /unsubscribe|optout|opt-out|preferences|manage.?subscription|facebook\.com|instagram\.com|twitter\.com|x\.com\/|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest|donate|paypal|venmo|privacy|terms|google\.com\/maps|maps\.app|apple\.com\/app|play\.google|mailto:|tel:|\.(png|jpe?g|gif|svg|webp|ico|css|js)(\?|$)/i;
const GOOD = /smore\.com|mailchi\.mp|campaign-archive|list-manage\.com|constantcontact|myemail\.|signupgenius|docs\.google\.com|sites\.google\.com|forms\.gle|canva\.site|ptoconnect|membershiptoolkit|schoolmessenger|peachjar|konstella|bloomz|newsletter|calendar|event|register|registration|signup|sign-up/i;

function pickLinks(body: string, watchedDomains: string[]): string[] {
  const urls = [...new Set((body.match(/https?:\/\/[^\s<>"')\]]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
  const scored = urls
    .filter((u) => !SKIP.test(u))
    .filter((u) => { try { const h = new URL(u).hostname; return !/^\d+\.\d+\.\d+\.\d+$/.test(h) && h !== "localhost"; } catch { return false; } })
    .map((u) => {
      const host = new URL(u).hostname;
      let score = 0;
      if (GOOD.test(u)) score += 2;
      if (watchedDomains.some((d) => host === d || host.endsWith("." + d))) score += 2;
      return { u, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_LINKS).map((x) => x.u);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;|&ndash;/g, "-")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// Returns readable text, or null with a reason when the page can't be read (login, not a web page, error).
async function readLink(url: string): Promise<{ url: string; text: string | null; note?: string }> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Homebase newsletter reader)" } });
    clearTimeout(timer);
    if (!res.ok) return { url, text: null, note: `the page answered ${res.status}` };
    const type = res.headers.get("content-type") || "";
    if (!/text\/html|text\/plain/i.test(type)) return { url, text: null, note: "not a web page" };
    const text = htmlToText((await res.text()).slice(0, 600000));
    if (/sign in|log in|login/i.test(text.slice(0, 600)) && text.length < 4000) return { url, text: null, note: "needs a login" };
    if (text.length < 80) return { url, text: null, note: "nothing readable on the page" };
    return { url: res.url || url, text: text.slice(0, LINK_CHARS) };
  } catch {
    return { url, text: null, note: "couldn't be opened" };
  }
}

// ── extraction ───────────────────────────────────────────────────────────────
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
        required: ["status", "existing_id", "change_note", "title", "kind", "date", "time", "person", "details"],
        properties: {
          status: { type: "string", enum: ["new", "update", "duplicate"], description: "new = not already known; update = already known but this email changes or adds something (time, date, place, link, cost, what to bring); duplicate = already known and nothing new" },
          existing_id: { type: "string", description: "For update/duplicate: the id of the matching known item or calendar event, exactly as listed. Otherwise empty." },
          change_note: { type: "string", description: "For update: what changed or was added, in one short sentence. Otherwise empty." },
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

type Attachment = { name: string; mimeType: string; data: string };
type Msg = { id: string; from: string; subject: string; date: string; body: string; attachments?: Attachment[] };
type Item = { status: string; existing_id: string; change_note: string; title: string; kind: string; date: string; time: string; person: string; details: string };
type Extracted = { relevant: boolean; items: Item[] };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type Known = { id: string; line: string };

async function extract(client: Anthropic, family: string, known: Known[], watchedDomains: string[], msg: Msg): Promise<Extracted | null> {
  const system =
    `You help a busy working parent (Ida) who misses things buried in school and activity emails. ` +
    `Today is ${todayInHome()} (${HOME_TZ}).\n\nThe family:\n${family}\n\n` +
    `From the email (and any attached documents, images or linked pages included with it), list only what the parents ` +
    `need to act on or show up for: sign-up and registration deadlines, forms and permission slips, payments due, ` +
    `things to bring or wear, events to attend (concerts, recitals, games, conferences, meetings), and schedule changes ` +
    `(cancellations, early release, no school, new time or place).\n` +
    `Skip: anything dated before today; general newsletter content with nothing to do; marketing and fundraising pitches ` +
    `with no deadline the family cares about; receipts; routine homework reminders (only include homework when it is late, ` +
    `missing, or there is a test or something a parent must do); and never suggest "read/review the newsletter".\n` +
    `Use the family details to say which child an item is about (person = that child's name), and start the title with ` +
    `the child's name when it's about one child. Use the email's date to resolve words like "this Friday".\n\n` +
    `Already known to Homebase (to-dos and calendar events), one per line as "id | when | title | notes":\n` +
    (known.length ? known.map((k) => k.line).join("\n") : "(nothing yet)") + `\n\n` +
    `For each item, compare it with the known list. If it is the same thing and the email adds nothing new, status = duplicate. ` +
    `If it is the same thing but the email changes or adds a time, date, place, link, cost or what to bring, status = update, ` +
    `existing_id = that known id, change_note = what changed. Otherwise status = new. ` +
    `If nothing qualifies, return relevant=false and no items.`;

  // deno-lint-ignore no-explicit-any
  const content: any[] = [];
  for (const a of msg.attachments || []) {
    if (a.mimeType === "application/pdf") {
      content.push({ type: "document", title: a.name, source: { type: "base64", media_type: "application/pdf", data: a.data } });
    } else if (IMAGE_TYPES.has(a.mimeType)) {
      content.push({ type: "image", source: { type: "base64", media_type: a.mimeType, data: a.data } });
    }
  }
  const links = await Promise.all(pickLinks(msg.body, watchedDomains).map(readLink));
  let text = `From: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n${msg.body.slice(0, 20000)}`;
  if ((msg.attachments || []).length) text += `\n\n[Attached: ${(msg.attachments || []).map((a) => a.name).join(", ")}]`;
  for (const l of links) {
    text += l.text
      ? `\n\n--- Linked page: ${l.url} ---\n${l.text}`
      : `\n\n--- Linked page ${l.url} couldn't be read (${l.note}) ---`;
  }
  content.push({ type: "text", text });

  // deno-lint-ignore no-explicit-any
  const res: any = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
  // deno-lint-ignore no-explicit-any
  } as any);
  if (res.stop_reason === "refusal") return null;
  // deno-lint-ignore no-explicit-any
  const out = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  try { return JSON.parse(out) as Extracted; } catch { return null; }
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

  const { data: watch } = await admin.from("email_watch").select("kind,value").eq("household_id", conn.household_id);
  if (req.method === "GET") {
    // The script asks for its search at the start of every check, so this doubles as "last checked".
    await admin.from("connections").update({ last_email_at: new Date().toISOString() }).eq("id", conn.id);
    return json({ query: buildQuery(watch || []) });
  }
  if (req.method !== "POST") return json({ error: "use GET or POST" }, 405);

  let body: { account?: string; messages?: Msg[] } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const msgs = (body.messages || []).slice(0, 10);
  if (!msgs.length) return json({ processed: 0, done: [] });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    await admin.from("connections").update({ last_error: "Add your Anthropic API key in Supabase (Edge Functions → Secrets) so Homebase can read emails." }).eq("id", conn.id);
    return json({ error: "no Anthropic key yet" }, 503);
  }
  const client = new Anthropic({ apiKey });
  const watchedDomains = (watch || []).filter((w) => w.kind === "from").map((w) => w.value.toLowerCase().replace(/^.*@/, ""));

  const { data: seenRows } = await admin.from("email_seen").select("message_id")
    .eq("connection_id", conn.id).in("message_id", msgs.map((m) => m.id));
  const seen = new Set((seenRows || []).map((r) => r.message_id));
  const fresh = msgs.filter((m) => m.id && !seen.has(m.id));

  const today = todayInHome();
  const { data: people } = await admin.from("people").select("name,kind,about").eq("household_id", conn.household_id);
  const kidNames = new Set((people || []).filter((p) => p.kind === "kid").map((p) => p.name.toLowerCase()));
  const family = (people || []).map((p) =>
    `- ${p.name} (${p.kind === "kid" ? "child" : p.kind === "helper" ? "grandparent/helper" : p.name.toLowerCase() === "ida" ? "Ida herself" : "parent"})` +
    (p.about ? `: ${p.about}` : "")).join("\n");

  // What Homebase already knows for the next four months: open to-dos and calendar events.
  const horizon = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
  const [{ data: openItems }, { data: events }] = await Promise.all([
    admin.from("items").select("id,title,due_date,due_time,notes,inbox")
      .eq("household_id", conn.household_id).eq("done", false)
      .or(`due_date.is.null,and(due_date.gte.${today},due_date.lte.${horizon})`).order("due_date").limit(200),
    admin.from("events").select("id,title,location,all_day,starts_at,start_date")
      .eq("household_id", conn.household_id).gte("start_date", today).lte("start_date", horizon).order("start_date").limit(250),
  ]);
  const itemsById = new Map((openItems || []).map((i) => [i.id, i]));
  const eventIds = new Set((events || []).map((e) => "event:" + e.id));
  const clip = (t: string | null, n: number) => (t || "").replace(/\s+/g, " ").slice(0, n);
  const hhmm = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const known: Known[] = [
    ...(openItems || []).map((i) => ({ id: i.id, line: `${i.id} | ${i.due_date || "no date"}${i.due_time ? " " + i.due_time.slice(0, 5) : ""} | ${clip(i.title, 120)} | ${clip(i.notes, 160)}` })),
    ...(events || []).map((e) => ({ id: "event:" + e.id, line: `event:${e.id} | ${e.start_date}${e.all_day ? "" : " " + hhmm(e.starts_at)} | ${clip(e.title, 120)} | ${clip(e.location, 80)}` })),
  ];
  const account = String(body.account || "");

  let added = 0, updated = 0, skipped = 0, errors = 0;
  const done: string[] = [...seen]; // ids the script can stop resending
  for (const m of fresh) {
    try {
      const out = await extract(client, family, known, watchedDomains, m);
      const link = `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : "u/0/"}#all/${m.id}`;
      let found = 0;
      for (const it of (out && out.relevant ? out.items : [])) {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : null;
        const time = /^\d{2}:\d{2}$/.test(it.time) ? it.time : null;
        if (date && date < today) { skipped++; continue; } // already over
        if (it.status === "duplicate" && (itemsById.has(it.existing_id) || eventIds.has(it.existing_id))) { skipped++; continue; }
        const kid = it.person && kidNames.has(it.person.toLowerCase()) ? it.person : "";
        const title = (kid && !it.title.toLowerCase().startsWith(kid.toLowerCase()) ? `${kid}: ` : "") + it.title.slice(0, 200);
        const prev = it.status === "update" ? itemsById.get(it.existing_id) : undefined;
        if (prev && prev.inbox) {
          // Still waiting in Requests: fold the change into it.
          const notes = [prev.notes, `Update ${today}: ${it.change_note || it.details}`, link].filter(Boolean).join("\n");
          const up = await admin.from("items").update({ notes, due_date: date ?? prev.due_date, due_time: time ?? prev.due_time }).eq("id", prev.id);
          if (up.error) throw up.error;
          updated++; found++;
          continue;
        }
        const isChange = it.status === "update" && (prev || eventIds.has(it.existing_id));
        const row = {
          household_id: conn.household_id, created_by: conn.created_by, assigned_to: conn.created_by,
          visibility: "personal", kind: "task", inbox: true, source: "email", source_ref: m.id,
          title: isChange ? `Changed: ${prev ? prev.title : title}` : title,
          due_date: date, due_time: time,
          notes: [isChange ? it.change_note : "", it.details, `Email: “${m.subject}”`, link].filter(Boolean).join("\n"),
          from_name: senderName(m.from),
        };
        const ins = await admin.from("items").insert(row).select("id,title,due_date,due_time,notes,inbox").single();
        if (ins.error) throw ins.error;
        // Later emails in this batch should see it as already known.
        itemsById.set(ins.data.id, ins.data);
        known.push({ id: ins.data.id, line: `${ins.data.id} | ${date || "no date"}${time ? " " + time : ""} | ${clip(row.title, 120)} | ${clip(row.notes, 160)}` });
        added++; found++;
      }
      await admin.from("email_seen").insert({ connection_id: conn.id, message_id: m.id, items_found: found });
      done.push(m.id);
    } catch (e) {
      errors++;
      console.error("email", m.id, e instanceof Error ? e.message : e);
    }
  }

  await admin.from("connections").update({
    emails_read: (conn.emails_read || 0) + fresh.length - errors,
    last_email_at: new Date().toISOString(),
    last_synced_at: new Date().toISOString(),
    last_error: errors ? `${errors} email(s) couldn't be read; they'll be retried next time.` : null,
    event_count: (conn.event_count || 0) + added,
  }).eq("id", conn.id);

  return json({ processed: fresh.length, already_seen: msgs.length - fresh.length, added, updated, skipped, errors, done });
});
