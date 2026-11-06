export const WINDOW_MS = 91 * 60 * 1000;

const SKIPPED_TYPES = new Set([
  "workingLocation",
  "outOfOffice",
  "focusTime",
  "birthday",
]);

const CALENDAR_HOME = "https://calendar.google.com/calendar/r";

export function isMeeting(event) {
  if (!event?.start?.dateTime || !event?.end?.dateTime) return false;
  if (event.status === "cancelled") return false;
  if (SKIPPED_TYPES.has(event.eventType)) return false;
  const self = event.attendees?.find((attendee) => attendee.self);
  if (self?.responseStatus === "declined") return false;
  return true;
}

export function normalize(event) {
  return {
    id: event.id,
    summary: event.summary?.trim() || "(No title)",
    start: event.start.dateTime,
    end: event.end.dateTime,
    htmlLink: event.htmlLink || CALENDAR_HOME,
  };
}

export function pickMeetings(items, now) {
  const meetings = (items ?? []).filter(isMeeting).map(normalize);
  const current =
    meetings.find((meeting) => {
      const start = Date.parse(meeting.start);
      const end = Date.parse(meeting.end);
      return start <= now && end > now;
    }) ?? null;
  const next = meetings.find((meeting) => Date.parse(meeting.start) > now) ?? null;
  return { current, next };
}

export function badgeText(startIso, now) {
  const ms = Date.parse(startIso) - now;
  if (!(ms > 0 && ms < WINDOW_MS)) return "";
  if (ms < 60_000) return "now";
  return `${Math.min(90, Math.ceil(ms / 60_000))}m`;
}

export function formatWhen(iso, nowMs) {
  const date = new Date(iso);
  const now = new Date(nowMs);
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (date.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${day} ${time}`;
}

export function tooltip(state, now) {
  if (!state || state.status === "loading") return "Next meeting";
  if (state.status === "setup") return "Add a Google Calendar client id";
  if (state.status === "signed_out") return "Sign in to Chrome to see your next meeting";
  if (state.status === "error") return "Next meeting unavailable";
  if (state.next) {
    const badge = badgeText(state.next.start, now);
    if (badge === "now") return `${state.next.summary} starting now`;
    if (badge) return `${state.next.summary} in ${badge.slice(0, -1)} min`;
    return `${state.next.summary} at ${formatWhen(state.next.start, now)}`;
  }
  if (state.current) return `In progress: ${state.current.summary}`;
  return "No upcoming meetings";
}
