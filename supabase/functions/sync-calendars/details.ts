// Homebase — pull arrival time and uniform out of a team calendar event, and tidy its location
// for a map lookup. Team apps write these in different ways:
//   TeamSnap:     "(Arrival Time:  5:30 PM (Eastern Time (US & Canada)))", "Uniform: neon socks"
//   PlayerFirst:  "… at 1:00PM Eastern Daylight Time .Uniform: Black. Arrival: 12."
//                 "Arrival: 15 Mins Early", "Arrival: WARMUPS AT 12:30", "Arrival: 7:30 am"

// ICS text escapes (\n, \,) → plain text.
export function unescapeIcs(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

export function uniformOf(text: string): string | null {
  const m = text.match(/uniform\s*:\s*([^.\n]+?)\s*(?=\.|\(\s*arriv|arriv|\n|$)/i);
  if (!m) return null;
  const u = m[1].replace(/\s+/g, " ").replace(/^(the|a)\s+/i, "").trim();
  if (!u || u.length > 60) return null;
  return u.charAt(0).toUpperCase() + u.slice(1);
}

// Minutes after local midnight, or null.
function hhmmOf(h: number, m: number) { return h * 60 + m; }

// The arrival time as minutes after local midnight, given the start (also minutes after midnight).
export function arrivalMinutes(text: string, startMin: number): number | null {
  const m = text.match(/arriv(?:al|e)?(?:\s*time)?\s*:\s*([^.(\n]{1,50})/i);
  if (!m) return null;
  const raw = m[1].trim();
  const early = raw.match(/(\d{1,3})\s*min(?:ute)?s?\s*(?:early|before|prior)/i);
  if (early) return startMin - Number(early[1]);
  const t = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  if (!t) return null;
  let h = Number(t[1]);
  const mi = t[2] ? Number(t[2]) : 0;
  if (h > 23 || mi > 59) return null;
  const ap = (t[3] || "").toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  else if (ap === "am" && h === 12) h = 0;
  else if (!ap && h <= 12) {
    // No am/pm: pick whichever reading falls at or shortly before the start.
    const options = [h % 12, (h % 12) + 12].map((x) => hhmmOf(x, mi)).filter((x) => x <= startMin && startMin - x <= 4 * 60);
    if (!options.length) return null;
    return Math.max(...options);
  }
  const at = hhmmOf(h, mi);
  // Arriving after the start or hours early is a misread; ignore it.
  if (at > startMin || startMin - at > 4 * 60) return null;
  return at;
}

// A location tidied up; used as the cache key for its drive time.
export function placeKey(loc: string): string {
  return unescapeIcs(loc).replace(/\n+/g, ", ").replace(/,?\s*United States\s*$/i, "").replace(/\s+/g, " ").trim()
    // PlayerFirst: "field Grass: Sacred Heart Elementary School , 329 Bishops Hwy Kingston, MA"
    .replace(/^field\s+[^:]{0,40}:\s*/i, "").replace(/\s+,/g, ",");
}

// Things worth trying on a map for a location, best first.
export function placeQueries(loc: string): string[] {
  const s = placeKey(loc);
  if (!s) return [];
  // No town or state given ("167 Forest Street", "Grace Ryder Fields"): it's almost always local.
  const out = /,\s*[A-Z]{2}\b|\b\d{5}\b|massachusetts/i.test(s) ? [s] : [s + ", Marshfield, MA", s];
  // "Name, 329 Street Town, MA" → also try just the street address
  const street = s.match(/\d{1,6}\s+[A-Za-z].*$/);
  if (street && street[0] !== s) out.push(street[0]);
  return [...new Set(out)];
}
