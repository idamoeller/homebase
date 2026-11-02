// Homebase — hands a calendar file back to the browser so it opens in the phone's or computer's Calendar.
//   POST form field ics=<BEGIN:VCALENDAR…> → text/calendar
// The app builds the file itself; this only serves it with the right type, which iPhone Safari
// needs to show "Add to Calendar" (a file made in the page just downloads to Files there).
// Nothing is stored, and the event details travel in the POST body, not the URL.

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("use POST", { status: 405 });
  let text = "";
  try { text = String((await req.formData()).get("ics") || ""); } catch { /* fall through */ }
  if (!/^BEGIN:VCALENDAR\r?\n/.test(text) || !/END:VCALENDAR\s*$/.test(text) || text.length > 20000) {
    return new Response("not a calendar file", { status: 400 });
  }
  return new Response(text, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="homebase-event.ics"',
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
