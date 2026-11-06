import { formatWhen, meetingBadge } from "./shared.js";

const app = document.querySelector("#app");
const CALENDAR_HOME = "https://calendar.google.com/calendar/r";
let generation = 0;

boot();

async function boot() {
  const gen = ++generation;
  const cached = await chrome.runtime.sendMessage({ type: "getState" });
  if (gen !== generation) return;
  render(cached);
  if (cached?.status === "setup") return;
  const fresh = await chrome.runtime.sendMessage({ type: "refresh" });
  if (gen !== generation) return;
  render(fresh);
}

function render(state) {
  app.replaceChildren();
  app.append(header(), body(state ?? { status: "loading" }));
}

function header() {
  const row = document.createElement("header");
  const icon = document.createElement("img");
  icon.src = "icons/32.png";
  icon.alt = "";
  const settings = document.createElement("button");
  settings.type = "button";
  settings.className = "settings";
  settings.textContent = "Settings";
  settings.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  row.append(icon, "Nolatilus", settings);
  return row;
}

function body(state) {
  const wrap = document.createElement("div");
  wrap.id = "body";
  if (state.status === "setup") wrap.append(setupView());
  else if (state.status === "signed_out") wrap.append(signedOutView());
  else if (state.status === "error") wrap.append(errorView(state));
  else if (state.status === "loading") wrap.append(paragraph("Checking your calendar…"));
  else wrap.append(calendarView(state));
  return wrap;
}

function setupView() {
  const fragment = document.createDocumentFragment();
  fragment.append(
    paragraph(
      "Create a Chrome-extension OAuth client for this extension id. Paste that client id into oauth2.client_id in manifest.json, then reload.",
    ),
  );
  const id = document.createElement("p");
  id.className = "id";
  id.textContent = chrome.runtime.id;
  fragment.append(id);
  return fragment;
}

function signedOutView() {
  const fragment = document.createDocumentFragment();
  fragment.append(
    paragraph("Nolatilus reads the calendar of the Google account signed in to Chrome."),
    button("Allow calendar access", connect),
  );
  return fragment;
}

function errorView(state) {
  const fragment = document.createDocumentFragment();
  const message = document.createElement("p");
  message.className = "error";
  message.textContent = state.error || "Could not load your calendar.";
  fragment.append(message, button("Try again", boot));
  return fragment;
}

function calendarView(state) {
  const now = Date.now();
  const fragment = document.createDocumentFragment();
  if (!state.current && !state.next) {
    fragment.append(paragraph("No upcoming meetings."));
    fragment.append(openLink(CALENDAR_HOME, "Open Calendar"));
    return fragment;
  }
  if (state.current) fragment.append(currentCard(state.current, now));
  if (state.next) fragment.append(nextCard(state.next, now, state.leadMinutes, state.acceptedOnly));
  const link = state.next?.htmlLink || state.current?.htmlLink || CALENDAR_HOME;
  fragment.append(openLink(link, "Open in Calendar"));
  return fragment;
}

function currentCard(meeting, now) {
  return card("Now", meeting.summary, `Until ${formatWhen(meeting.end, now)}`);
}

function nextCard(meeting, now, leadMinutes, acceptedOnly) {
  const badge = meetingBadge(meeting, now, leadMinutes, acceptedOnly);
  const cardNode = document.createElement("section");
  cardNode.className = "card";
  if (badge) {
    const hero = document.createElement("div");
    hero.className = "hero";
    const count = document.createElement("p");
    count.className = "count";
    count.textContent = badge === "now" ? "now" : badge.slice(0, -1);
    hero.append(count);
    if (badge !== "now") {
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = "min";
      hero.append(unit);
    }
    cardNode.append(hero);
  }
  cardNode.append(textLine("p", "kicker", badge ? "Next" : "Later"));
  cardNode.append(textLine("p", "title", meeting.summary));
  cardNode.append(textLine("p", "when", formatWhen(meeting.start, now)));
  return cardNode;
}

function card(kicker, title, when) {
  const node = document.createElement("section");
  node.className = "card";
  node.append(
    textLine("p", "kicker", kicker),
    textLine("p", "title", title),
    textLine("p", "when", when),
  );
  return node;
}

function button(label, onClick) {
  const node = document.createElement("button");
  node.className = "button";
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await onClick();
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

async function connect() {
  const gen = ++generation;
  render({ status: "loading" });
  try {
    await chrome.identity.getAuthToken({ interactive: true });
    const state = await chrome.runtime.sendMessage({ type: "refresh" });
    if (gen !== generation) return;
    render(state);
  } catch (error) {
    if (gen !== generation) return;
    const message = error?.message || "Calendar access was not granted.";
    const signedOut = /did not approve|cancelled|canceled|closed/i.test(message);
    render({
      status: signedOut ? "signed_out" : "error",
      error: message,
    });
  }
}

function openLink(url, label) {
  const link = document.createElement("a");
  link.className = "open";
  link.href = url;
  link.textContent = label;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({ url });
  });
  return link;
}

function paragraph(text) {
  return textLine("p", "muted", text);
}

function textLine(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
