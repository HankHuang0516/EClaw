'use strict';

// All campaign instants are stored as UTC ISO strings and shown as Asia/Taipei wall time.
// Taiwan has no daylight saving time, so a fixed +08:00 offset is exact.
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid_time:${value}`);
  return ms;
}

function iso(value) {
  return new Date(toMs(value)).toISOString();
}

// ("2026-12-25", "10:00") in Asia/Taipei -> "2026-12-25T02:00:00.000Z"
function taipeiLocalToIso(date, time = '00:00') {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  const t = /^(\d{2}):(\d{2})$/.exec(String(time));
  if (!d || !t || Number(t[1]) > 23 || Number(t[2]) > 59) throw new Error(`invalid_local_time:${date} ${time}`);
  const localMs = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const check = new Date(localMs);
  if (check.getUTCFullYear() !== Number(d[1]) || check.getUTCMonth() !== Number(d[2]) - 1 ||
      check.getUTCDate() !== Number(d[3])) throw new Error(`invalid_local_time:${date} ${time}`);
  return new Date(localMs - TAIPEI_OFFSET_MS).toISOString();
}

// One Asia/Taipei calendar month after `start`, keeping the local time of day and clamping to
// the last day of a shorter month (Jan 31 -> Feb 28/29). This is the same rule the REBOUND
// server applies to `limited_campaign` mail (server/src/campaign-deadline.mjs); the two must
// agree or the published deadline would differ from the one the game enforces.
function taipeiCalendarMonthLater(start) {
  const local = new Date(toMs(start) + TAIPEI_OFFSET_MS);
  const lastDayOfNextMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 2, 0)).getUTCDate();
  const endLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1,
    Math.min(local.getUTCDate(), lastDayOfNextMonth), local.getUTCHours(), local.getUTCMinutes(),
    local.getUTCSeconds(), local.getUTCMilliseconds());
  return new Date(endLocal - TAIPEI_OFFSET_MS).toISOString();
}

function addDays(value, days) {
  return new Date(toMs(value) + days * DAY_MS).toISOString();
}

function pad(number) {
  return String(number).padStart(2, '0');
}

// "2026/12/25 10:00" in Asia/Taipei
function formatTaipei(value) {
  const local = new Date(toMs(value) + TAIPEI_OFFSET_MS);
  return `${local.getUTCFullYear()}/${pad(local.getUTCMonth() + 1)}/${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

// "2026/12/25" in Asia/Taipei
function formatTaipeiDate(value) {
  return formatTaipei(value).slice(0, 10);
}

// "2026-12-25" in Asia/Taipei
function taipeiDateKey(value) {
  return formatTaipeiDate(value).replace(/\//g, '-');
}

module.exports = {
  DAY_MS, TAIPEI_OFFSET_MS, toMs, iso, taipeiLocalToIso, taipeiCalendarMonthLater, addDays,
  formatTaipei, formatTaipeiDate, taipeiDateKey
};
