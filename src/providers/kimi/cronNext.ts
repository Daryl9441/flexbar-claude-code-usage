/**
 * Next run of a five-field cron expression ("min hour day-of-month month
 * day-of-week") in an IANA timezone, computed with Intl only (no deps, no
 * tz database files). Supports `*`, step (`/n`), `a`, `a-b`, `a-b/n` and
 * comma lists; names and the `L`/`W`/`#`/`?` extensions are not understood
 * and yield null, as does an unknown timezone or a schedule that never
 * matches (e.g. Feb 30). Pure: the clock and the Intl API are the only
 * inputs.
 */

export type CronField = {
  /** Every value the field matches, ascending; empty when it never matches */
  values: number[];
  /** True for `*` (or a step of 1): the field places no restriction */
  any: boolean;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How far ahead a schedule is looked for (a yearly cron always fits) */
const SEARCH_DAYS = 370 * 2;
/** Intl formatters are expensive to create; one per timezone is enough */
const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** One field's matching values; null when the text is not supported. */
export function parseCronField(
  text: string,
  min: number,
  max: number,
  sundayToZero = false
): CronField | null {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      if (m[2] !== undefined) return null;
      lo = min;
      hi = max;
      if (step === 1) any = true;
    } else {
      lo = Number(m[1]);
      hi = m[2] !== undefined ? Number(m[2]) : m[3] ? max : lo;
      // 7 is Sunday in the day-of-week field, same as 0
      if (sundayToZero) {
        if (lo === 7) lo = 0;
        if (hi === 7) hi = 0;
      }
    }
    if (lo > hi || lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values: [...values].sort((a, b) => a - b), any };
}

export type CronSchedule = {
  minutes: CronField;
  hours: CronField;
  /** Day of month; combined with weekdays by OR when both are restricted */
  days: CronField;
  months: CronField;
  /** 0 = Sunday */
  weekdays: CronField;
};

/** Parses all five fields; null when any of them is not supported. */
export function parseCron(cron: string): CronSchedule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const days = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const weekdays = parseCronField(parts[4], 0, 7, true);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (
    !minutes.values.length ||
    !hours.values.length ||
    !days.values.length ||
    !months.values.length ||
    !weekdays.values.length
  ) {
    return null;
  }
  return { minutes, hours, days, months, weekdays };
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timezone);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
  } catch {
    formatter = null; // unknown timezone, or Intl without timezone data
  }
  formatterCache.set(timezone, formatter);
  return formatter;
}

/** The wall clock of `ms` in the timezone, or null when it has no data. */
function wallClock(ms: number, timezone: string): WallClock | null {
  const formatter = formatterFor(timezone);
  if (!formatter) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const byType: Record<string, string> = {};
  for (const part of parts) byType[part.type] = part.value;
  const hour = Number(byType.hour) % 24; // a h23/h24 quirk shows midnight as 24
  const weekday = WEEKDAYS[byType.weekday];
  if (weekday === undefined) return null;
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour,
    minute: Number(byType.minute),
    weekday,
  };
}

/**
 * The absolute time of a wall clock in the timezone. Converges by feeding
 * the offset error back (a fixed-offset zone needs one round); returns null
 * when the wall time does not exist (a DST gap) after a few rounds.
 */
function absoluteOf(wall: WallClock, timezone: string): number | null {
  const wanted = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute
  );
  let guess = wanted;
  for (let round = 0; round < 4; round++) {
    const there = wallClock(guess, timezone);
    if (!there) return null;
    const actual = Date.UTC(
      there.year,
      there.month - 1,
      there.day,
      there.hour,
      there.minute
    );
    const delta = wanted - actual;
    if (delta === 0) return guess;
    guess += delta;
  }
  return null;
}

/**
 * The first time the schedule fires strictly after `fromMs` (a fire exactly
 * at `fromMs` counts), in epoch ms; null when none is found within the
 * search window or the timezone cannot be read.
 */
export function nextCronRun(
  schedule: CronSchedule,
  timezone: string,
  fromMs: number
): number | null {
  if (!Number.isFinite(fromMs) || !formatterFor(timezone)) return null;
  const start = Math.floor(fromMs / MINUTE) * MINUTE;
  const startWall = wallClock(start, timezone);
  if (!startWall) return null;

  const dayMatch = (w: WallClock): boolean => {
    if (!schedule.months.values.includes(w.month)) return false;
    const dayOk = schedule.days.values.includes(w.day);
    const weekdayOk = schedule.weekdays.values.includes(w.weekday);
    // cron OR: with both fields restricted, either one matching is enough
    if (!schedule.days.any && !schedule.weekdays.any) return dayOk || weekdayOk;
    return dayOk && weekdayOk;
  };

  // Day zero of the search is the calendar day of `fromMs` in the timezone.
  const dayZero = Date.UTC(startWall.year, startWall.month - 1, startWall.day);
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const dayMs = dayZero + offset * DAY;
    const noon = wallClock(dayMs + 12 * 60 * MINUTE, timezone); // DST-safe
    if (!noon) return null;
    if (!dayMatch(noon)) continue;
    const sameDay = offset === 0;
    const hourFloor = sameDay ? startWall.hour : 0;
    for (const hour of schedule.hours.values) {
      if (hour < hourFloor) continue;
      const minuteFloor =
        sameDay && hour === startWall.hour ? startWall.minute : 0;
      for (const minute of schedule.minutes.values) {
        if (minute < minuteFloor) continue;
        const at = absoluteOf({ ...noon, hour, minute }, timezone);
        if (at === null) continue; // the wall time never happens (DST gap)
        if (at < fromMs) continue; // a fire earlier in the same minute is past
        return at;
      }
    }
  }
  return null;
}

/** Convenience: cron text + timezone to the next run, or null. */
export function nextRunOf(
  cron: string | null,
  timezone: string | null,
  fromMs: number
): number | null {
  if (!cron || !timezone) return null;
  const schedule = parseCron(cron);
  return schedule ? nextCronRun(schedule, timezone, fromMs) : null;
}
