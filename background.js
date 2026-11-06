import { badgeText, pickMeetings, tooltip, WINDOW_MS } from "./shared.js";

const STATE_KEY = "state";
const REFRESH_MINUTES = 15;
const BADGE_COLOR = "#6419FF";

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
    const { current, next } = pickMeetings(items, Date.now());
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
  const wakes = [];
  if (state.next) {
    const untilStart = Date.parse(state.next.start) - now;
    if (untilStart > 0 && untilStart < WINDOW_MS) {
      await chrome.alarms.create("tick", { periodInMinutes: 1 });
    }
    if (untilStart > 0) {
      wakes.push(untilStart < WINDOW_MS ? untilStart : untilStart - WINDOW_MS);
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
  const text =
    state.status === "ok" && state.next ? badgeText(state.next.start, now) : "";
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title: tooltip(state, now) });
}

async function authToken(interactive) {
  const result = await chrome.identity.getAuthToken({ interactive });
  if (typeof result === "string") return result;
  if (typeof result?.token === "string") return result.token;
  return "";
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

async function getState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return (
    stored[STATE_KEY] ?? {
      status: "loading",
      error: null,
      fetchedAt: null,
      current: null,
      next: null,
    }
  );
}

async function setState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
  return state;
}
