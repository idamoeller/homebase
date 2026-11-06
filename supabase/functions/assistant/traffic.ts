// Drive times with traffic for Ask Homebase, from TomTom (key in the TOMTOM_API_KEY secret).
// Right now it uses live traffic; for a time later on, TomTom's prediction from usual traffic at that hour.
const HOME_TZ = Deno.env.get("HOME_TZ") ?? "America/New_York";
const API = "https://api.tomtom.com";
const NEAR = "lat=42.09&lon=-70.71"; // prefer matches near home
const TIME = /^\d{2}:\d{2}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const mins = (s: unknown) => typeof s === "number" ? Math.round(s / 60) : null;
const clock = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

// Never put the URL in an error: it holds the key.
async function getJSON(url: string, what: string) {
  let res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 429) { // too many at once: wait a moment and try once more
    await new Promise((r) => setTimeout(r, 1200));
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  }
  if (res.status === 403 || res.status === 401) throw new Error("TomTom didn't accept the key");
  if (res.status === 429) throw new Error("TomTom is limiting requests right now, either too many at once or the free daily limit; try again shortly");
  if (res.status === 400 && what.includes("route")) throw new Error("there's no driving route between those places");
  if (!res.ok) throw new Error(`TomTom couldn't ${what} (${res.status})`);
  return await res.json();
}

// Search near a point and everywhere, then keep the result that matches the most words of what was asked:
// nearby alone turns "Indianapolis International Airport" into Logan. Too few matching words means not found.
const words = (t: string) => t.toLowerCase().match(/[a-z0-9]+/g) || [];
// Calendar locations can be messy ("field 4: Union Point, 170 Memorial Grove Ave Weymouth, MA"): a street address is what counts.
function tidy(q: string) {
  const t = q.replace(/\s+/g, " ").replace(/^field\b[^:]*:\s*/i, "").replace(/\s*\([^)]*\).*$/, "").replace(/,?\s*(USA|United States)\s*$/i, "").trim();
  const street = t.match(/\b\d{1,6}\s+[A-Z].*$/);
  return (street ? street[0] : t).slice(0, 200);
}
async function findPlace(q: string, key: string, near: string) {
  const text = tidy(q);
  const url = (extra: string) => `${API}/search/2/search/${encodeURIComponent(text)}.json?limit=5&countrySet=US${extra}&key=${key}`;
  const [a, b] = await Promise.all([getJSON(url(`&${near}`), "look up that place"), getJSON(url(""), "look up that place")]);
  const asked = [...new Set(words(text))];
  let best = null, top = 0;
  // deno-lint-ignore no-explicit-any
  for (const r of [...(a.results || []), ...(b.results || [])] as any[]) {
    const have = new Set(words([r.poi?.name, r.address?.freeformAddress, r.address?.municipality, r.address?.countrySubdivisionName, r.address?.countrySubdivision].filter(Boolean).join(" ")));
    const score = asked.filter((w) => have.has(w)).length / (asked.length || 1);
    if (score > top) { top = score; best = r; } // ties keep the earlier, nearer one
  }
  if (!best || top < 0.6) return null;
  return { at: `${best.position.lat},${best.position.lon}`, name: [best.poi?.name, best.address?.freeformAddress].filter(Boolean).join(", ") };
}

export type DriveCtx = { home: string | null; today: string; homeISO: (d: string, t: string) => string };

// deno-lint-ignore no-explicit-any
export async function driveTime(a: any, ctx: DriveCtx) {
  const key = Deno.env.get("TOMTOM_API_KEY");
  if (!key) return { ok: false, error: "traffic isn't set up yet" };
  if (!a.to || !String(a.to).trim()) return { ok: false, error: "needs a place to drive to" };
  const fromText = a.from && String(a.from).trim() ? String(a.from) : ctx.home || "Marshfield, MA";

  const from = await findPlace(fromText, key, NEAR);
  if (!from) return { ok: false, error: `couldn't find ${fromText}` };
  const [lat, lon] = from.at.split(",");
  const to = await findPlace(String(a.to), key, `lat=${lat}&lon=${lon}`);
  if (!to) return { ok: false, error: `couldn't find ${a.to}; try a street address or town` };

  const day = DATE.test(a.date || "") ? a.date : ctx.today;
  const wanted = TIME.test(a.arrive_by || "") ? "arriveAt" : TIME.test(a.leave_at || "") ? "departAt" : "";
  const iso = wanted ? ctx.homeISO(day, wanted === "arriveAt" ? a.arrive_by : a.leave_at) : "";
  // A time already gone means now.
  const later = !!iso && Date.parse(iso) > Date.now() + 5 * 60000;
  const j = await getJSON(`${API}/routing/1/calculateRoute/${from.at}:${to.at}/json?traffic=true&travelMode=car&routeType=fastest` +
    `&computeTravelTimeFor=all${later ? `&${wanted}=${encodeURIComponent(iso)}` : ""}&key=${key}`, "work out that route");
  const s = j.routes && j.routes[0] && j.routes[0].summary;
  if (!s) return { ok: false, error: "no driving route between those places" };

  return {
    ok: true, read_only: true,
    from: from.name, to: to.name,
    traffic: later ? "predicted from usual traffic at that time, not live" : "live",
    minutes: mins(s.travelTimeInSeconds),
    minutes_without_traffic: mins(s.noTrafficTravelTimeInSeconds),
    traffic_adds_minutes: Math.max(0, (mins(s.travelTimeInSeconds) ?? 0) - (mins(s.noTrafficTravelTimeInSeconds) ?? 0)),
    miles: Math.round(s.lengthInMeters / 160.934) / 10,
    leave: clock(s.departureTime), arrive: clock(s.arrivalTime),
    ...(wanted && !later ? { note: "that time has passed, so this is for leaving now" } : {}),
  };
}
