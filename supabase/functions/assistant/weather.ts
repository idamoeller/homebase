// Weather for Ask Homebase, from Open-Meteo (free, no key): home or any city, up to 16 days ahead.
const HOME = { name: "Marshfield, Massachusetts", lat: 42.0918, lon: -70.7056 };
const CODES: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "cloudy", 45: "fog", 48: "fog",
  51: "drizzle", 53: "drizzle", 55: "drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow", 80: "showers", 81: "showers", 82: "heavy showers",
  85: "snow showers", 86: "snow showers", 95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sky = (c: number) => CODES[c] ?? "unknown";
const shift = (d: string, n: number) => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

async function getJSON(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`the weather service answered ${res.status}`);
  return await res.json();
}

// "Portland, Maine": look up the city, then prefer the result in the named state or country.
async function findPlace(place: string) {
  const [city, ...rest] = place.split(",").map((s) => s.trim());
  const hint = rest.join(" ").toLowerCase();
  const j = await getJSON("https://geocoding-api.open-meteo.com/v1/search?count=10&name=" + encodeURIComponent(city));
  const found = j.results || [];
  // deno-lint-ignore no-explicit-any
  const hit = (hint && found.find((r: any) => hint.includes(String(r.admin1 || "?").toLowerCase()) || hint.includes(String(r.country || "?").toLowerCase()))) || found[0];
  if (!hit) return null;
  return { name: [hit.name, hit.admin1, hit.country_code === "US" ? "" : hit.country].filter(Boolean).join(", "), lat: hit.latitude, lon: hit.longitude };
}

// deno-lint-ignore no-explicit-any
export async function getWeather(a: any, today: string) {
  const from = DATE.test(a.from || "") ? a.from : today;
  const last = shift(today, 15);
  if (from > last) return { ok: false, error: `the forecast only reaches ${last}` };
  const asked = DATE.test(a.to || "") && a.to >= from ? a.to : from;
  const to = asked > last ? last : asked;

  const at = a.place && String(a.place).trim() ? await findPlace(String(a.place)) : HOME;
  if (!at) return { ok: false, error: `couldn't find a place called ${a.place}; try the nearest city` };

  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const wantHours = days <= 2;
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${at.lat}&longitude=${at.lon}&timezone=auto` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&start_date=${from}&end_date=${to}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max` +
    (wantHours ? `&hourly=weather_code,temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m` : "") +
    (from <= today && to >= today ? `&current=weather_code,temperature_2m,apparent_temperature,wind_speed_10m` : ""));

  const d = j.daily || {};
  // deno-lint-ignore no-explicit-any
  const out: any = {
    ok: true, read_only: true, place: at.name, units: "°F, mph, inches",
    // deno-lint-ignore no-explicit-any
    days: (d.time || []).map((t: string, i: number) => ({
      date: t, sky: sky(d.weather_code[i]), high: Math.round(d.temperature_2m_max[i]), low: Math.round(d.temperature_2m_min[i]),
      chance_of_rain_or_snow: d.precipitation_probability_max[i], precip: d.precipitation_sum[i],
      wind: Math.round(d.wind_speed_10m_max[i]), gusts: Math.round(d.wind_gusts_10m_max[i]),
    })),
  };
  if (asked !== to) out.note = `the forecast stops at ${last}`;
  if (j.current) {
    out.now = { sky: sky(j.current.weather_code), temp: Math.round(j.current.temperature_2m), feels_like: Math.round(j.current.apparent_temperature), wind: Math.round(j.current.wind_speed_10m) };
  }
  if (j.hourly) {
    const h = j.hourly;
    // deno-lint-ignore no-explicit-any
    out.hours = (h.time as string[]).flatMap((t, i) => {
      const hr = +t.slice(11, 13);
      if (hr < 6 || hr > 22) return [];
      return [{ at: t.replace("T", " "), sky: sky(h.weather_code[i]), temp: Math.round(h.temperature_2m[i]), feels_like: Math.round(h.apparent_temperature[i]),
        chance_of_rain_or_snow: h.precipitation_probability[i], wind: Math.round(h.wind_speed_10m[i]) }];
    });
  }
  return out;
}
