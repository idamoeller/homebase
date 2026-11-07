// Homebase — open a web link someone gave us and return what's readable: a page's text, a PDF or a picture.
// The same file lives in assistant/ and direct/ (each Edge Function deploys its own copy); change both.
// Only public http(s) sites on the normal ports: never this machine, a private network or a cloud metadata address.

const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const MAX_FILE_BYTES = 8_000_000;
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_LINKS = 200;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export type Opened = {
  ok: boolean;
  url: string;
  error?: string;
  title?: string;
  note?: string;
  text?: string;
  links?: string[]; // links found on the page
  media?: { type: string; data: string }; // base64 PDF or picture
};

// The link as one exact spelling, so "www.x.org/camp." and "https://www.x.org/camp" compare equal.
export function normalizeUrl(raw: unknown): string | null {
  let s = String(raw ?? "").trim().replace(/[.,;:!?]+$/, "");
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

// Every link in a message, including ones typed without https:// (www.x.org, x.org/camp).
export function findUrls(text: string): string[] {
  const re = /(?<![@\w.-])(?:https?:\/\/[^\s<>"'`)\]]+|(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|us|io|co|info)(?:\/[^\s<>"'`)\]]*)?)/gi;
  const out = new Set<string>();
  for (const m of String(text || "").match(re) || []) {
    const u = normalizeUrl(m);
    if (u) out.add(u);
  }
  return [...out];
}

function privateIPv4(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Why this address can't be opened, or null if it's fine.
export function blockedUrl(u: URL): string | null {
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.protocol !== "http:" && u.protocol !== "https:") return "it isn't a web link";
  if (u.port && u.port !== "80" && u.port !== "443") return "it isn't on a normal web port";
  if (u.username || u.password) return "it has a password in it";
  if (!host.includes(".") || /\.(local|internal|localhost|lan|home|corp)$/.test(host)) return "it isn't a public site";
  if (host.startsWith("[") || privateIPv4(host) || host === "metadata.google.internal") return "it isn't a public site";
  return null;
}

// A name can still point somewhere private; check where it goes when the runtime lets us look it up.
async function resolvesPrivate(host: string): Promise<boolean> {
  // deno-lint-ignore no-explicit-any
  const resolve = (globalThis as any).Deno?.resolveDns;
  if (!resolve || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  try {
    const ips: string[] = await resolve(host, "A");
    return ips.some(privateIPv4);
  } catch {
    return false; // can't look it up here; the fetch will say if the site is really gone
  }
}

// Share links to Google files → the plain version that can be read without a browser.
function readableVersion(url: string): string {
  const u = new URL(url);
  const doc = url.match(/^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
  if (doc) {
    const base = `https://docs.google.com/${doc[1]}/d/${doc[2]}`;
    if (doc[1] === "document") return `${base}/export?format=txt`;
    if (doc[1] === "presentation") return `${base}/export/txt`;
    const gid = u.searchParams.get("gid");
    return `${base}/export?format=csv${gid ? "&gid=" + encodeURIComponent(gid) : ""}`;
  }
  const file = url.match(/^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (file) return `https://drive.google.com/uc?export=download&id=${file[1]}`;
  return url;
}

const LOGIN_HOST = /^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|www\.facebook\.com\/login)/i;

// Follow redirects by hand so every hop gets the same safety check.
async function fetchChecked(start: string, signal: AbortSignal): Promise<{ res?: Response; url: string; error?: string }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    const why = blockedUrl(u);
    if (why) return { url, error: `it can't be opened because ${why}` };
    if (await resolvesPrivate(u.hostname)) return { url, error: "it can't be opened because it isn't a public site" };
    if (LOGIN_HOST.test(u.hostname)) return { url, error: "it needs a login" };
    const res = await fetch(url, {
      signal, redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Homebase family organizer)", "Accept": "text/html,application/pdf,text/plain,image/*;q=0.8,*/*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = new URL(res.headers.get("location")!, url).href;
      continue;
    }
    return { res, url };
  }
  return { url, error: "it redirects too many times" };
}

async function readBytes(res: Response, cap: number): Promise<{ bytes: Uint8Array; full: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), full: true };
  const parts: Uint8Array[] = [];
  let size = 0, full = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size > cap) { full = false; await reader.cancel(); break; }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { bytes, full };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decode(bytes: Uint8Array, type: string): string {
  const cs = type.match(/charset=["']?([\w-]+)/i)?.[1];
  try { return new TextDecoder(cs || "utf-8").decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

function entities(s: string): string {
  const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', mdash: "-", ndash: "-", hellip: "...", middot: "·", bull: "·" };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== "#") return named[e.toLowerCase()] ?? all;
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}
const stripTags = (s: string) => entities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// Structured events many sites publish for search engines (often the only dates on pages built by scripts).
function structuredEvents(html: string): string[] {
  const out: string[] = [];
  // deno-lint-ignore no-explicit-any
  const walk = (n: any) => {
    if (!n || typeof n !== "object" || out.length >= 60) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const type = [].concat(n["@type"] || []).join(" ");
    if (/Event\b/.test(type) && n.name && n.startDate) {
      const loc = n.location?.name || n.location?.address?.streetAddress || (typeof n.location?.address === "string" ? n.location.address : "") || "";
      out.push(`- ${stripTags(String(n.name))} | ${n.startDate}${n.endDate ? " to " + n.endDate : ""}${loc ? " | " + stripTags(String(loc)) : ""}${typeof n.url === "string" ? " | " + n.url : ""}`);
    }
    if (n["@graph"]) walk(n["@graph"]);
    if (n.itemListElement) walk(n.itemListElement);
    if (n.item) walk(n.item);
  };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1])); } catch { /* a broken block; the page text still counts */ }
  }
  return out;
}

export function readHtml(html: string, base: string): { title: string; description: string; events: string[]; text: string; links: string[] } {
  const meta = (name: string) => {
    const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)`, "i"));
    const b = a || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i"));
    return b ? stripTags(b[1]) : "";
  };
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") || meta("og:title");
  const description = meta("og:description") || meta("description");
  const events = structuredEvents(html);
  const links = new Set<string>();
  const body = html
    .replace(/<(script|style|noscript|svg|head|nav|footer|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Keep where a link goes, so "Register here" stays useful.
    .replace(/<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_all, href, inner) => {
      const label = stripTags(inner);
      let abs = "";
      try { abs = new URL(entities(href), base).href; } catch { /* not a usable link */ }
      if (!/^https?:/i.test(abs)) return label;
      if (links.size < MAX_LINKS) { const n = normalizeUrl(abs); if (n) links.add(n); }
      return label ? `${label} (${abs}) ` : "";
    })
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section|article|ul|ol|table)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  const text = entities(body).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { title, description, events, text, links: [...links] };
}

// Opens one link. Never throws; ok:false carries a plain reason to pass along.
export async function openLink(raw: string, maxChars = 30000): Promise<Opened> {
  const url = normalizeUrl(raw);
  if (!url) return { ok: false, url: String(raw), error: "that isn't a web link" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const got = await fetchChecked(readableVersion(url), ctl.signal);
    if (got.error || !got.res) return { ok: false, url, error: got.error || "it couldn't be opened" };
    const res = got.res;
    if (res.status === 401 || res.status === 403) { await res.body?.cancel(); return { ok: false, url, error: "the site needs a login or doesn't allow automatic readers" }; }
    if (res.status === 404 || res.status === 410) { await res.body?.cancel(); return { ok: false, url, error: "the page isn't there (404)" }; }
    if (!res.ok) { await res.body?.cancel(); return { ok: false, url, error: `the site answered with an error (${res.status})` }; }

    const type = (res.headers.get("content-type") || "").toLowerCase();
    const image = IMAGE_TYPES.find((t) => type.includes(t));
    const textual = /text\/|json|xml|calendar/.test(type);
    const { bytes, full } = await readBytes(res, image ? MAX_IMAGE_BYTES : textual ? MAX_HTML_BYTES : MAX_FILE_BYTES);
    const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF

    if (isPdf || image) {
      if (!full) return { ok: false, url, error: isPdf ? "the PDF is too big to read (over 8 MB)" : "the picture is too big to read" };
      return { ok: true, url: got.url, title: decodeURIComponent(new URL(got.url).pathname.split("/").pop() || "") || "File", media: { type: isPdf ? "application/pdf" : image!, data: toBase64(bytes) } };
    }
    if (!textual) return { ok: false, url, error: `it's a file Homebase can't read (${type.split(";")[0] || "unknown type"})` };

    const raw = decode(bytes, type);
    if (!/html|xml/.test(type) && !/^\s*<(!doctype|html)/i.test(raw)) {
      const text = raw.trim();
      if (!text) return { ok: false, url, error: "there's nothing readable there" };
      return { ok: true, url: got.url, title: url, text: text.slice(0, maxChars), note: text.length > maxChars ? "This is only the first part of a long file." : undefined };
    }
    const page = readHtml(raw, got.url);
    if (/\b(sign in|log in|login)\b/i.test(page.text.slice(0, 800) + " " + page.title) && page.text.length < 3000 && !page.events.length) {
      return { ok: false, url, error: "it needs a login" };
    }
    // A bot check instead of the page ("Client Challenge", "Just a moment…"): say so, don't pass it off as the page.
    if (page.text.length < 3000 && /client challenge|just a moment|attention required|access denied|are you (a )?human|verify(ing)? you are|checking your browser|enable javascript and cookies|captcha/i.test(page.title + " " + page.text.slice(0, 1000))) {
      return { ok: false, url, error: "the site blocks automatic readers" };
    }
    if (page.text.length < 80 && !page.events.length && page.description.length < 40) {
      return { ok: false, url, error: "the page builds itself in a browser, so there's nothing readable without one" };
    }
    const parts = [
      page.description && `Summary: ${page.description}`,
      page.events.length ? `Events listed on the page:\n${page.events.join("\n")}` : "",
      page.text,
    ].filter(Boolean).join("\n\n");
    return {
      ok: true, url: got.url, title: page.title, text: parts.slice(0, maxChars), links: page.links,
      note: page.text.length < 80 ? "Only a summary was readable; the rest of the page builds itself in a browser."
        : parts.length > maxChars ? "This is only the first part of a long page." : undefined,
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, url, error: aborted ? "the site took too long to answer" : "the site couldn't be reached" };
  } finally {
    clearTimeout(timer);
  }
}
