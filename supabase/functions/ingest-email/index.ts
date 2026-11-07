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
const STR = { type: "string" };
// A travel itinerary (airline, hotel, rental car, travel agency or a forwarded one): every detail worth having on the trip.
const TRIP = {
  type: "object",
  additionalProperties: false,
  required: ["is_trip", "travelers", "destination", "booking_ref", "flights", "hotels", "cars", "other"],
  description: "Only for a travel itinerary or booking confirmation (flights, hotel, rental car), including forwarded ones. Otherwise is_trip=false and everything empty.",
  properties: {
    is_trip: { type: "boolean" },
    travelers: { type: "array", items: STR, description: "Family names of who is traveling (passenger names like MOELLER/IDA → Ida). Empty if unclear." },
    destination: { type: "string", description: "Where they're going: the city (\"Indianapolis\"), not the home airport." },
    booking_ref: { type: "string", description: "The main record locator / trip or booking number that identifies this trip, else empty." },
    flights: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["airline", "flight_number", "depart_date", "depart_time", "depart_airport", "depart_city", "depart_tz", "arrive_date", "arrive_time", "arrive_airport", "arrive_city", "arrive_tz", "seat", "confirmation"],
      properties: {
        airline: STR, flight_number: { type: "string", description: "e.g. DL 5627" },
        depart_date: { type: "string", description: "YYYY-MM-DD, local to the departure airport" }, depart_time: { type: "string", description: "HH:MM 24-hour, local" },
        depart_airport: { type: "string", description: "Code, e.g. BOS" }, depart_city: STR, depart_tz: { type: "string", description: "IANA time zone of the departure airport, e.g. America/New_York" },
        arrive_date: STR, arrive_time: STR, arrive_airport: STR, arrive_city: STR, arrive_tz: STR,
        seat: STR, confirmation: { type: "string", description: "Airline confirmation if different from booking_ref, else empty" },
      } } },
    hotels: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["name", "address", "phone", "check_in_date", "check_in_time", "check_out_date", "check_out_time", "tz", "confirmation"],
      properties: { name: STR, address: STR, phone: STR, check_in_date: STR, check_in_time: { type: "string", description: "HH:MM 24-hour local, or empty" },
        check_out_date: STR, check_out_time: STR, tz: { type: "string", description: "IANA time zone of the hotel" }, confirmation: STR } } },
    cars: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["company", "pickup_date", "pickup_time", "pickup_location", "return_date", "return_time", "return_location", "tz", "car", "confirmation"],
      properties: { company: STR, pickup_date: STR, pickup_time: STR, pickup_location: STR, return_date: STR, return_time: STR, return_location: STR,
        tz: STR, car: { type: "string", description: "Car class or model, if given" }, confirmation: STR } } },
    other: { type: "string", description: "Anything else worth keeping: trains, shuttles, meetings or conference named in it, ticket numbers, loyalty numbers, notes. Else empty." },
  },
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["relevant", "items", "news_source", "news_category", "news", "trip"],
  properties: {
    trip: TRIP,
    relevant: { type: "boolean", description: "Does this email contain anything a parent needs to act on or attend?" },
    news_source: { type: "string", description: "For a school or activity newsletter/announcement: a short name for who it's from (e.g. \"Furnace Brook MS\", \"Eames Way\", \"RSM Milton\", \"Carrie Lindsay Piano\"). Otherwise empty." },
    news_category: { type: "string", enum: ["school", "activity"], description: "school = the kids' schools: classes, teachers, the principal, the district, the PTO. activity = everything outside school: music lessons and teachers, camps, sports teams and clubs, RSM, community programs. If it isn't a newsletter or announcement, use school." },
    news: {
      type: "array",
      description: "For a school or activity newsletter/announcement only: up to 5 short FYI highlights a parent would want to know but needn't act on (things happening this week, announcements, spirit days, new staff; for music, camps, sports and other activities: sessions or registration opening, schedule changes, studio or program closures, recitals and showcases). Not the action items, not lunch menus or boilerplate. Empty for other emails.",
      items: { type: "string" },
    },
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
          title: { type: "string", description: "Short, specific. Don't start with a person's name (that goes in person)." },
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
type Flight = { airline: string; flight_number: string; depart_date: string; depart_time: string; depart_airport: string; depart_city: string; depart_tz: string;
  arrive_date: string; arrive_time: string; arrive_airport: string; arrive_city: string; arrive_tz: string; seat: string; confirmation: string };
type Hotel = { name: string; address: string; phone: string; check_in_date: string; check_in_time: string; check_out_date: string; check_out_time: string; tz: string; confirmation: string };
type Car = { company: string; pickup_date: string; pickup_time: string; pickup_location: string; return_date: string; return_time: string; return_location: string; tz: string; car: string; confirmation: string };
type Trip = { is_trip: boolean; travelers: string[]; destination: string; booking_ref: string; flights: Flight[]; hotels: Hotel[]; cars: Car[]; other: string };
type Extracted = { relevant: boolean; items: Item[]; news_source?: string; news_category?: string; news?: string[]; trip?: Trip };

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
    `Use the family details to say which family member an item is about (person = that name); don't put the name in ` +
    `the title. Use the email's date to resolve words like "this Friday".\n\n` +
    `Already known to Homebase (to-dos and calendar events), one per line as "id | when | title | notes":\n` +
    (known.length ? known.map((k) => k.line).join("\n") : "(nothing yet)") + `\n\n` +
    `For each item, compare it with the known list. If it is the same thing and the email adds nothing new, status = duplicate. ` +
    `If it is the same thing but the email changes or adds a time, date, place, link, cost or what to bring, status = update, ` +
    `existing_id = that known id, change_note = what changed. Otherwise status = new. Items marked (done) or (dismissed) ` +
    `have already been handled: treat a reminder about them as duplicate. ` +
    `Make one item per event or deadline: put what to bring, wear or pack and any sign-up for that same event into its ` +
    `details rather than separate items. ` +
    `If nothing qualifies, return relevant=false and no items.\n` +
    `If the email is a travel itinerary or booking (flights, hotel, rental car; often forwarded from Ida's work email), fill trip ` +
    `with every detail exactly as written (flight numbers, times, airports, seats, confirmation and record locators, hotel name, ` +
    `address, phone, check-in/out, rental car company, pick-up/return, confirmation), and don't also list those flights, hotel ` +
    `or car as items. Otherwise trip.is_trip=false.\n` +
    `Separately, if the email is a school or activity newsletter or announcement, fill news_source and up to 5 short news ` +
    `highlights (FYI only, no action needed, one line each, naming the child when it's clearly about one); otherwise leave them empty. ` +
    `Set news_category: school for the kids' schools, activity for music, camps, sports, RSM and anything else outside school. A one-off note from a music ` +
    `teacher, coach or program counts as an announcement. A camp or program announcing its sessions or registration dates counts even when it's promotional; other ad mail doesn't.`;

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

// Plain-text backstop for duplicates the model misses: same (or no) date and mostly the same words.
const STOP = new Set(["the", "a", "an", "and", "or", "for", "to", "of", "at", "in", "on", "by", "with", "your", "you", "is", "be", "due", "deadline", "changed", "reminder"]);
function words(t: string): Set<string> {
  return new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
}
function sameThing(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= 0.6 && both >= 2;
}
type Row = { id: string; title: string; due_date: string | null; due_time: string | null; notes: string | null; inbox: boolean; done: boolean; dismissed: boolean };
function findSame(rows: Iterable<Row>, title: string, date: string | null): Row | undefined {
  for (const r of rows) {
    if (date && r.due_date && r.due_date !== date) continue;
    if (sameThing(r.title.replace(/^Changed: /, ""), title)) return r;
  }
}

// ── travel ───────────────────────────────────────────────────────────────────
const DAY = /^\d{4}-\d{2}-\d{2}$/, HM = /^\d{2}:\d{2}$/;
const okTz = (tz: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return HOME_TZ; } };
// A wall-clock date and time in a time zone → the instant (ISO).
function zoned(d: string, t: string, tz: string): string {
  const guess = new Date(`${d}T${t}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: okTz(tz), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(guess).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess.getTime() - (local - guess.getTime())).toISOString();
}
const homeDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const ampm = (t: string) => { if (!HM.test(t)) return ""; const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const md = (d: string) => DAY.test(d) ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
const join = (...x: (string | false | null | undefined)[]) => x.filter(Boolean).join(" · ");

function flightLine(f: Flight) {
  return join(`${f.flight_number || f.airline}`.trim(), md(f.depart_date),
    `${f.depart_city || f.depart_airport}${f.depart_airport ? " " + f.depart_airport : ""} ${ampm(f.depart_time)} → ${f.arrive_city || f.arrive_airport}${f.arrive_airport ? " " + f.arrive_airport : ""} ${ampm(f.arrive_time)}${f.arrive_date && f.arrive_date !== f.depart_date ? " (" + md(f.arrive_date) + ")" : ""}`,
    f.seat && `seat ${f.seat}`, f.confirmation && `conf ${f.confirmation}`);
}
function hotelLine(h: Hotel) {
  return join(h.name, h.address, h.phone, h.check_in_date && `check in ${md(h.check_in_date)}${h.check_in_time ? " " + ampm(h.check_in_time) : ""}`,
    h.check_out_date && `check out ${md(h.check_out_date)}${h.check_out_time ? " " + ampm(h.check_out_time) : ""}`, h.confirmation && `conf ${h.confirmation}`);
}
function carLine(c: Car) {
  return join(c.company, c.car, c.pickup_date && `pick up ${md(c.pickup_date)} ${ampm(c.pickup_time)}${c.pickup_location ? " at " + c.pickup_location : ""}`,
    c.return_date && `return ${md(c.return_date)} ${ampm(c.return_time)}${c.return_location ? " at " + c.return_location : ""}`, c.confirmation && `conf ${c.confirmation}`);
}

// Files an itinerary: one Who's where trip with everything in its note, plus calendar events for each flight,
// hotel check-in and car pick-up (or a note on a flight that's already on a synced calendar). Re-sent or changed
// itineraries for the same booking update that trip and replace its events.
// deno-lint-ignore no-explicit-any
async function fileTrip(conn: any, people: { id: string; name: string; user_id?: string | null }[], trip: Trip, m: Msg, link: string) {
  const hid = conn.household_id;
  const flights = (trip.flights || []).filter((f) => DAY.test(f.depart_date));
  const hotels = (trip.hotels || []).filter((h) => DAY.test(h.check_in_date));
  const cars = (trip.cars || []).filter((c) => DAY.test(c.pickup_date));
  const days = [
    ...flights.flatMap((f) => [f.depart_date, DAY.test(f.arrive_date) ? f.arrive_date : f.depart_date]),
    ...hotels.flatMap((h) => [h.check_in_date, DAY.test(h.check_out_date) ? h.check_out_date : h.check_in_date]),
    ...cars.flatMap((c) => [c.pickup_date, DAY.test(c.return_date) ? c.return_date : c.pickup_date]),
  ].sort();
  if (!days.length) return false;
  const start = days[0], end = days[days.length - 1];
  if (end < todayInHome()) return false; // a trip that's already over

  const self = people.find((p) => p.user_id === conn.created_by);
  const byName = (n: string) => people.find((p) => p.name.toLowerCase() === String(n).trim().toLowerCase())?.id;
  const who = [...new Set((trip.travelers || []).map(byName).filter(Boolean))] as string[];
  if (!who.length && self) who.push(self.id);

  const ref = (trip.booking_ref || flights[0]?.confirmation || hotels[0]?.confirmation || cars[0]?.confirmation || m.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 40).toUpperCase();
  const note = [
    trip.booking_ref && `Booking ${trip.booking_ref}`,
    ...flights.map((f) => "✈ " + flightLine(f)),
    ...hotels.map((h) => "Hotel: " + hotelLine(h)),
    ...cars.map((c) => "Car: " + carLine(c)),
    trip.other && trip.other.trim(),
    `Email: “${m.subject}”`, link,
  ].filter(Boolean).join("\n").slice(0, 4000);
  const place = (trip.destination || flights[0]?.arrive_city || "").slice(0, 100) || null;

  // The same booking, or a trip already entered by hand for the same person over the same days.
  const { data: same } = await admin.from("schedule").select("id,person_ids,source_ref,place")
    .eq("household_id", hid).eq("kind", "travel").lte("start_date", end).gte("end_date", start);
  const prev = (same || []).find((s) => s.source_ref === "trip:" + ref)
    || (same || []).find((s) => !s.source_ref && (s.person_ids || []).some((p: string) => who.includes(p)));
  const row = { kind: "travel", start_date: start, end_date: end, place: place || prev?.place || null, note, person_ids: who, source_ref: "trip:" + ref };
  const sv = prev
    ? await admin.from("schedule").update(row).eq("id", prev.id)
    : await admin.from("schedule").insert({ household_id: hid, user_id: conn.created_by, ...row });
  if (sv.error) throw sv.error;

  // Calendar events on the household's Homebase calendar.
  const { data: cal } = await admin.from("connections").select("id").eq("household_id", hid).eq("kind", "homebase").limit(1).maybeSingle();
  let calId = cal?.id;
  if (!calId) {
    const made = await admin.from("connections").insert({ household_id: hid, created_by: conn.created_by, kind: "homebase", name: "Homebase", visibility: "family", enabled: true }).select("id").single();
    if (made.error) throw made.error;
    calId = made.data.id;
  }
  const prefix = `hb-trip-${ref}-`;
  await admin.from("events").delete().eq("connection_id", calId).like("uid", prefix + "%");
  await admin.from("event_notes").delete().eq("connection_id", calId).like("uid", prefix + "%");
  const { data: around } = await admin.from("events").select("id,connection_id,uid,title,description,start_date")
    .eq("household_id", hid).neq("connection_id", calId).gte("start_date", start).lte("start_date", end);
  const base = { household_id: hid, connection_id: calId, created_by: conn.created_by, person_id: who[0] || null, visibility: "family" };
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  const timed = (uid: string, title: string, d: string, t: string, tz: string, ed: string, et: string, etz: string, location: string, desc: string) => {
    if (HM.test(t)) {
      const s = zoned(d, t, tz);
      let e = HM.test(et) ? zoned(DAY.test(ed) ? ed : d, et, etz || tz) : "";
      if (!e || e <= s) e = new Date(new Date(s).getTime() + 3600000).toISOString();
      rows.push({ ...base, uid, title, location: location || null, description: desc, all_day: false, starts_at: s, ends_at: e, start_date: homeDay(s), end_date: homeDay(s) });
    } else {
      rows.push({ ...base, uid, title, location: location || null, description: desc, all_day: true, starts_at: null, ends_at: null, start_date: d, end_date: d });
    }
  };
  for (const [i, f] of flights.entries()) {
    const num = (f.flight_number || "").replace(/\s+/g, "");
    const digits = num.replace(/^\D+/, "");
    const desc = [flightLine(f), trip.booking_ref && `Booking ${trip.booking_ref}`].filter(Boolean).join("\n");
    // Already on a synced calendar (e.g. the airline added it to iCloud)? Put the details on that one instead.
    const dup = digits && (around || []).find((e) => e.start_date <= (f.arrive_date || f.depart_date) && e.start_date >= f.depart_date &&
      new RegExp(`\\b(${num}|${digits})\\b`, "i").test(`${e.title} ${e.description || ""}`.replace(/\s+(?=\d)/g, "")));
    if (dup) {
      const { data: old } = await admin.from("event_notes").select("note").eq("connection_id", dup.connection_id).eq("uid", dup.uid).maybeSingle();
      if (!old?.note?.includes(flightLine(f))) {
        const up = await admin.from("event_notes").upsert({ household_id: hid, connection_id: dup.connection_id, uid: dup.uid,
          note: [old?.note, desc].filter(Boolean).join("\n"), updated_at: new Date().toISOString() }, { onConflict: "connection_id,uid" });
        if (up.error) console.error("trip note", up.error.message);
      }
      continue;
    }
    timed(prefix + "f" + i, `Flight ${f.flight_number || f.airline} ${f.depart_airport || f.depart_city} → ${f.arrive_airport || f.arrive_city}`.replace(/\s+/g, " ").trim(),
      f.depart_date, f.depart_time, f.depart_tz, f.arrive_date, f.arrive_time, f.arrive_tz, [f.depart_city, f.depart_airport].filter(Boolean).join(" ") + " airport", desc);
  }
  for (const [i, h] of hotels.entries()) {
    timed(prefix + "h" + i, `Hotel check-in: ${h.name || "hotel"}`, h.check_in_date, h.check_in_time, h.tz, "", "", "", h.address,
      hotelLine(h));
  }
  for (const [i, c] of cars.entries()) {
    timed(prefix + "c" + i, `Rental car pick-up: ${c.company || "car"}`, c.pickup_date, c.pickup_time, c.tz, "", "", "", c.pickup_location,
      carLine(c));
  }
  if (rows.length) {
    const ins = await admin.from("events").insert(rows);
    if (ins.error) throw ins.error;
    // The event sheet shows Homebase's own notes, so the details go there too (editable like any note).
    const notes = await admin.from("event_notes").upsert(rows.map((r) => ({ household_id: hid, connection_id: calId, uid: r.uid, note: r.description,
      updated_at: new Date().toISOString() })), { onConflict: "connection_id,uid" });
    if (notes.error) console.error("trip notes", notes.error.message);
  }
  return true;
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
  const { data: people } = await admin.from("people").select("id,name,kind,about,user_id").eq("household_id", conn.household_id);
  const personIds = new Map((people || []).map((p) => [p.name.toLowerCase(), p.id]));
  const family = (people || []).map((p) =>
    `- ${p.name} (${p.kind === "kid" ? "child" : p.kind === "helper" ? "grandparent/helper" : p.name.toLowerCase() === "ida" ? "Ida herself" : "parent"})` +
    (p.about ? `: ${p.about}` : "")).join("\n");

  // What Homebase already knows for the next four months: open to-dos and calendar events.
  const horizon = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
  const [{ data: openItems }, { data: events }] = await Promise.all([
    // Done and dismissed ones too, so a reminder about something already handled isn't added again.
    admin.from("items").select("id,title,due_date,due_time,notes,inbox,done,dismissed")
      .eq("household_id", conn.household_id).gte("created_at", new Date(Date.now() - 120 * 86400000).toISOString())
      .or(`due_date.is.null,and(due_date.gte.${today},due_date.lte.${horizon})`).order("due_date").limit(300),
    admin.from("events").select("id,title,location,all_day,starts_at,start_date")
      .eq("household_id", conn.household_id).gte("start_date", today).lte("start_date", horizon).order("start_date").limit(250),
  ]);
  const itemsById = new Map<string, Row>((openItems || []).map((i) => [i.id, i as Row]));
  const state = (i: Row) => (i.dismissed ? " (dismissed)" : i.done ? " (done)" : "");
  const eventIds = new Set((events || []).map((e) => "event:" + e.id));
  const clip = (t: string | null, n: number) => (t || "").replace(/\s+/g, " ").slice(0, n);
  const hhmm = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const known: Known[] = [
    ...(openItems || []).map((i) => ({ id: i.id, line: `${i.id} | ${i.due_date || "no date"}${i.due_time ? " " + i.due_time.slice(0, 5) : ""} | ${clip(i.title, 120)}${state(i as Row)} | ${clip(i.notes, 160)}` })),
    ...(events || []).map((e) => ({ id: "event:" + e.id, line: `event:${e.id} | ${e.start_date}${e.all_day ? "" : " " + hhmm(e.starts_at)} | ${clip(e.title, 120)} | ${clip(e.location, 80)}` })),
  ];
  const account = String(body.account || "");

  let added = 0, updated = 0, skipped = 0, errors = 0, trips = 0;
  const done: string[] = [...seen]; // ids the script can stop resending
  for (const m of fresh) {
    try {
      const out = await extract(client, family, known, watchedDomains, m);
      const link = `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : "u/0/"}#all/${m.id}`;
      let found = 0;
      if (out?.trip?.is_trip && await fileTrip(conn, people || [], out.trip, m, link)) { found++; trips++; }
      for (const it of (out && out.relevant ? out.items : [])) {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : null;
        const time = /^\d{2}:\d{2}$/.test(it.time) ? it.time : null;
        if (date && date < today) { skipped++; continue; } // already over
        if (it.status === "duplicate" && (itemsById.has(it.existing_id) || eventIds.has(it.existing_id))) { skipped++; continue; }
        const personId = it.person ? personIds.get(it.person.toLowerCase()) ?? null : null;
        const title = it.title.slice(0, 200);
        let prev = it.status === "update" ? itemsById.get(it.existing_id) : undefined;
        if (!prev) {
          // Another check may have just added it; look again right before adding.
          const { data: recent } = await admin.from("items").select("id,title,due_date,due_time,notes,inbox,done,dismissed")
            .eq("household_id", conn.household_id).gte("created_at", new Date(Date.now() - 15 * 60000).toISOString());
          for (const r of (recent || []) as Row[]) itemsById.set(r.id, r);
          const same = findSame(itemsById.values(), title, date);
          if (same) {
            if (it.status !== "update") { skipped++; continue; }
            prev = same;
          }
        }
        if (prev && prev.dismissed) { skipped++; continue; } // you already said no to this
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
          from_name: senderName(m.from), person_id: personId,
        };
        const ins = await admin.from("items").insert(row).select("id,title,due_date,due_time,notes,inbox,done,dismissed").single();
        if (ins.error) throw ins.error;
        // Later emails in this batch should see it as already known.
        itemsById.set(ins.data.id, ins.data as Row);
        known.push({ id: ins.data.id, line: `${ins.data.id} | ${date || "no date"}${time ? " " + time : ""} | ${clip(row.title, 120)} | ${clip(row.notes, 160)}` });
        added++; found++;
      }
      // FYI highlights for the Today cards: "School news this week" or "Extracurricular announcements".
      const news = (out?.news || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 5);
      if (news.length && out?.news_source) {
        const emailDate = isNaN(Date.parse(m.date)) ? new Date().toISOString() : new Date(m.date).toISOString();
        await admin.from("school_news").upsert({
          household_id: conn.household_id, connection_id: conn.id, message_id: m.id,
          source: out.news_source.slice(0, 60), subject: m.subject.slice(0, 200), bullets: news, link, email_date: emailDate,
          category: out.news_category === "activity" ? "activity" : "school",
        }, { onConflict: "household_id,message_id", ignoreDuplicates: true });
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

  return json({ processed: fresh.length, already_seen: msgs.length - fresh.length, added, updated, skipped, trips, errors, done });
});
