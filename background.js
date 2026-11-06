import {
  ACCEPTED_ONLY_KEY,
  IGNORED_TITLES_KEY,
  ignoredTitles,
  LEAD_STORAGE_KEY,
  meetingBadge,
  normalizeLeadMinutes,
  pickMeetings,
  tooltip,
} from "./shared.js";

const STATE_KEY = "state";
const REFRESH_MINUTES = 15;
const BADGE_RED = "#ff1919";
const BADGE_AMBER = "#FFBF00";
const BADGE_GREEN = "#32CD32";

let refreshTask = null;

chrome.runtime.onInstalled.addListener(() => {
  refresh();
});

chrome.runtime.onStartup.addListener(() => {
  refresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tick") onTick();
  else refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[IGNORED_TITLES_KEY] || changes[ACCEPTED_ONLY_KEY]) refresh();
  else if (changes[LEAD_STORAGE_KEY]) reapply();
});

if (chrome.identity.onSignInChanged) {
  chrome.identity.onSignInChanged.addListener(() => {
    refresh();
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "getState" && message?.type !== "refresh") return false;
  const task = message.type === "refresh" ? refresh() : getState();
  task
    .then(sendResponse)
    .catch((error) => {
      sendResponse(errorState(error));
    });
  return true;
});

function refresh() {
  refreshTask ??= doRefresh().finally(() => {
    refreshTask = null;
  });
  return refreshTask;
}

async function doRefresh() {
  if (needsClientId()) {
    const state = await setState({
      status: "setup",
      error: null,
      fetchedAt: Date.now(),
      current: null,
      next: null,
    });
    await applyPresentation(state);
    await arm(state);
    return state;
  }

  let token;
  try {
    token = await authToken(false);
  } catch (error) {
    const state = await setState(authFailureState(error));
    await applyPresentation(state);
    await arm(state);
    return state;
  }

  if (!token) {
    const state = await setState(
      authFailureState(new Error("The user is not signed in.")),
    );
    await applyPresentation(state);
    await arm(state);
    return state;
  }

  try {
    const items = await loadEvents(token);
    const { current, next } = pickMeetings(items, Date.now(), await getIgnoredTitles());
    const state = await setState({
      status: "ok",
      error: null,
      fetchedAt: Date.now(),
      current,
      next,
    });
    await applyPresentation(state);
    await arm(state);
    return state;
  } catch (error) {
    const previous = await getState();
    const transient = error.status == null || error.status >= 500;
    if (transient && previous.status === "ok" && (previous.next || previous.current)) {
      await applyPresentation(previous);
      await arm(previous);
      return previous;
    }
    const failure = error.status === 401 ? authFailureState(error) : errorState(error);
    if (error.status === 401) failure.status = "signed_out";
    const state = await setState(failure);
    await applyPresentation(state);
    await arm(state);
    return state;
  }
}

async function reapply() {
  const state = await getState();
  await applyPresentation(state);
  await arm(state);
}

async function onTick() {
  const state = await getState();
  if (state.status !== "ok" || !state.next) return;
  if (Date.parse(state.next.start) <= Date.now()) {
    await refresh();
    return;
  }
  await applyPresentation(state);
}

async function loadEvents(token) {
  try {
    return await fetchEvents(token);
  } catch (error) {
    if (error.status !== 401) throw error;
    await chrome.identity.removeCachedAuthToken({ token });
    const fresh = await authToken(false);
    if (!fresh) {
      const missing = new Error("The user is not signed in.");
      missing.status = 401;
      throw missing;
    }
    return await fetchEvents(fresh);
  }
}

async function fetchEvents(token) {
  const now = Date.now();
  const params = new URLSearchParams({
    timeMin: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
    fields:
      "items(id,summary,status,eventType,htmlLink,start,end,attendees(self,responseStatus))",
  });
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body.error?.message || "";
    } catch {
      detail = "";
    }
    const error = new Error(detail || `Calendar request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return data.items ?? [];
}

async function arm(state) {
  await chrome.alarms.clearAll();
  await chrome.alarms.create("refresh", { periodInMinutes: REFRESH_MINUTES });

  const now = Date.now();
  const leadMs = normalizeLeadMinutes(state.leadMinutes) * 60_000;
  const wakes = [];
  if (state.next) {
    const untilStart = Date.parse(state.next.start) - now;
    const countdown = meetingBadge(state.next, now, state.leadMinutes, state.acceptedOnly);
    if (countdown && untilStart > 0 && untilStart <= leadMs) {
      await chrome.alarms.create("tick", { periodInMinutes: 1 });
    }
    if (untilStart > 0) {
      wakes.push(countdown && untilStart > leadMs ? untilStart - leadMs : untilStart);
    }
  }
  if (state.current) {
    const untilEnd = Date.parse(state.current.end) - now;
    if (untilEnd > 0) wakes.push(untilEnd);
  }
  if (wakes.length === 0) return;
  const delayMin = Math.min(...wakes) / 60_000;
  if (delayMin > 0 && delayMin < REFRESH_MINUTES) {
    await chrome.alarms.create("boundary", {
      delayInMinutes: Math.max(delayMin, 1),
    });
  }
}

async function applyPresentation(state) {
  const now = Date.now();
  const leadMinutes = normalizeLeadMinutes(state.leadMinutes);
  const text =
    state.status === "ok" ? meetingBadge(state.next, now, leadMinutes, state.acceptedOnly) : "";
  await chrome.action.setBadgeBackgroundColor({ color: badgeColor(state, now) });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title: tooltip(state, now, leadMinutes) });
}

async function authToken(interactive) {
  const result = await chrome.identity.getAuthToken({ interactive });
  if (typeof result === "string") return result;
  if (typeof result?.token === "string") return result.token;
  return "";
}

function badgeColor(state, now) {
  if (state.status === "ok" && state.next) {
    const ms = Date.parse(state.next.start) - now;
    if (ms > 0 && ms <= 5 * 60_000) return BADGE_RED;
    if (ms > 0 && ms <= 15 * 60_000) return BADGE_AMBER;
  }
  return BADGE_GREEN;
}

function needsClientId() {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id ?? "";
  return !clientId || clientId.startsWith("REPLACE_ME");
}

function authFailureState(error) {
  const message = error?.message || "Could not use the Chrome account";
  const signedOut = /not signed in|did not approve|user interaction|revoked/i.test(message);
  return {
    status: signedOut ? "signed_out" : "error",
    error: message,
    fetchedAt: Date.now(),
    current: null,
    next: null,
  };
}

function errorState(error) {
  return {
    status: "error",
    error: error?.message || "Could not load your calendar",
    fetchedAt: Date.now(),
    current: null,
    next: null,
  };
}

async function getLeadMinutes() {
  const stored = await chrome.storage.local.get(LEAD_STORAGE_KEY);
  return normalizeLeadMinutes(stored[LEAD_STORAGE_KEY]);
}

async function getIgnoredTitles() {
  const stored = await chrome.storage.local.get(IGNORED_TITLES_KEY);
  return ignoredTitles(stored[IGNORED_TITLES_KEY]);
}

async function getAcceptedOnly() {
  const stored = await chrome.storage.local.get(ACCEPTED_ONLY_KEY);
  return stored[ACCEPTED_ONLY_KEY] === true;
}

async function getState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  const state = stored[STATE_KEY] ?? {
    status: "loading",
    error: null,
    fetchedAt: null,
    current: null,
    next: null,
  };
  state.leadMinutes = await getLeadMinutes();
  state.acceptedOnly = await getAcceptedOnly();
  return state;
}

async function setState(state) {
  const { leadMinutes, acceptedOnly, ...stored } = state;
  await chrome.storage.session.set({ [STATE_KEY]: stored });
  return {
    ...stored,
    leadMinutes: leadMinutes ?? (await getLeadMinutes()),
    acceptedOnly: acceptedOnly ?? (await getAcceptedOnly()),
  };
}
