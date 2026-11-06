import {
  IGNORED_TITLES_KEY,
  LEAD_STORAGE_KEY,
  MAX_LEAD_MINUTES,
  normalizeLeadMinutes,
} from "./shared.js";

const form = document.querySelector("#settings");
const input = document.querySelector("#lead");
const ignored = document.querySelector("#ignored");
const status = document.querySelector("#status");

const stored = await chrome.storage.local.get([LEAD_STORAGE_KEY, IGNORED_TITLES_KEY]);
input.value = String(normalizeLeadMinutes(stored[LEAD_STORAGE_KEY]));
ignored.value = typeof stored[IGNORED_TITLES_KEY] === "string" ? stored[IGNORED_TITLES_KEY] : "";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const minutes = Number(input.value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LEAD_MINUTES) {
    status.textContent = `Enter a whole number from 1 to ${MAX_LEAD_MINUTES}.`;
    return;
  }
  await chrome.storage.local.set({
    [LEAD_STORAGE_KEY]: minutes,
    [IGNORED_TITLES_KEY]: ignored.value,
  });
  status.textContent = "Saved";
});
