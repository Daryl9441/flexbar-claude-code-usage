/**
 * What a Session Status key shows, as plain data: label, colors and text
 * lines for a SessionStatus, or the page of the running-sessions list shown
 * after a press. Pure (no canvas), so it is testable and doubles as the
 * redraw signature — a key is only redrawn when its view changes.
 */
import type {
  AutomationBoard,
  AutomationItem,
  Localized,
} from './providers/types';
import {
  RunningGroup,
  RunningSession,
  SessionState,
  SessionStatus,
} from './session';

export type Lang = 'en' | 'zh';

export type ViewTone = 'working' | 'attention' | 'done' | 'error' | 'idle';

/** Status colours: blue, amber, green, red and grey. */
export const TONE_COLORS: Record<ViewTone, string> = {
  working: '#5b9bf0',
  attention: '#f0a830',
  done: '#61aa5c',
  error: '#d9534f',
  idle: '#8a8580',
};

export type SessionView = {
  tone: ViewTone;
  /** Status label, e.g. "Working", "Question" */
  label: string;
  /** Main text line: question, current task, title… */
  text: string;
  /** Compact time, e.g. "3m", "刚刚" */
  time: string;
  project: string | null;
  progress: { completed: number; total: number } | null;
  /** Other sessions working or needing the user */
  others: number;
  /**
   * A notice or "No sessions" face: text too long for one line wraps onto
   * the second (there is no progress bar to make room for)
   */
  wrap?: boolean;
};

const STRINGS = {
  en: {
    working: 'Working',
    question: 'Question',
    plan: 'Plan ready',
    permission: 'Approval',
    permissionGuess: 'Approval?',
    done: 'Done',
    asked: 'Asked you',
    interrupted: 'Stopped',
    error: 'Error',
    idle: 'Idle',
    none: 'No sessions',
    noneText: (product: string) => `Start ${product}`,
    background: 'Background tasks running',
    planText: 'Review the plan',
    permissionText: 'Waiting for permission',
    permissionGuessText: 'Probably waiting for permission',
    now: 'now',
    minutes: (n: number) => `${n}m`,
    hours: (n: number) => `${n}h`,
    days: (n: number) => `${n}d`,
    noRunning: 'No running sessions',
    untitled: 'Untitled session',
    automationRunning: 'Running',
    automationDue: 'Due',
    automationScheduled: 'Scheduled',
    automationManual: 'Manual',
    automationOff: 'Off',
    automationFailed: 'failed',
    automationInMinutes: 'in {n}m',
    automationTomorrow: 'Tmrw',
    automationWeekdays: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat',
    noAutomations: 'No scheduled tasks',
    automationsUnavailable: 'Scheduled tasks unavailable',
  },
  zh: {
    working: '进行中',
    question: '待回答',
    plan: '计划待审',
    permission: '待授权',
    permissionGuess: '待授权?',
    done: '已完成',
    asked: '有疑问',
    interrupted: '已中断',
    error: '出错',
    idle: '空闲',
    none: '无会话',
    noneText: (product: string) => `启动 ${product}`,
    background: '后台任务运行中',
    planText: '请审阅计划',
    permissionText: '等待授权',
    permissionGuessText: '可能在等待授权',
    now: '刚刚',
    minutes: (n: number) => `${n}分钟`,
    hours: (n: number) => `${n}小时`,
    days: (n: number) => `${n}天`,
    noRunning: '没有运行中的会话',
    untitled: '未命名会话',
    automationRunning: '运行中',
    automationDue: '到点',
    automationScheduled: '已排期',
    automationManual: '手动',
    automationOff: '已停用',
    automationFailed: '失败',
    automationInMinutes: '{n}分钟后',
    automationTomorrow: '明天',
    automationWeekdays: '周日,周一,周二,周三,周四,周五,周六',
    noAutomations: '暂无定时任务',
    automationsUnavailable: '无法读取定时任务',
  },
};

export function langOf(value: unknown): Lang {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh')
    ? 'zh'
    : 'en';
}

/** Compact elapsed time: "now", "5m", "3h", "2d". */
export function formatElapsed(ms: number, lang: Lang): string {
  const s = STRINGS[lang];
  if (!Number.isFinite(ms) || ms < 60_000) return s.now;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return s.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return s.hours(hours);
  return s.days(Math.floor(hours / 24));
}

const TONES: Record<SessionState, ViewTone> = {
  working: 'working',
  question: 'attention',
  plan: 'attention',
  permission: 'attention',
  done: 'done',
  interrupted: 'error',
  error: 'error',
  idle: 'idle',
};

function first(...values: (string | null | undefined)[]): string {
  return values.find(v => typeof v === 'string' && v.trim())?.trim() ?? '';
}

export type ViewOptions = {
  lang: Lang;
  showProject: boolean;
  now: number;
  others?: number;
  /** Named in "Start …" when there is no session (default Claude Code) */
  productName?: string;
};

/** The product named on Claude's key faces */
export const DEFAULT_PRODUCT = 'Claude Code';

export function buildSessionView(
  status: SessionStatus | null,
  options: ViewOptions
): SessionView {
  const s = STRINGS[options.lang];
  if (!status) {
    return {
      tone: 'idle',
      label: s.none,
      text: s.noneText(options.productName ?? DEFAULT_PRODUCT),
      time: '',
      project: null,
      progress: null,
      others: 0,
      wrap: true,
    };
  }

  const progress = status.progress
    ? { completed: status.progress.completed, total: status.progress.total }
    : null;
  const active = status.progress?.active;
  const title = status.title;
  let tone = TONES[status.state];
  let label: string;
  let text: string;

  switch (status.state) {
    case 'working':
      label = s.working;
      text = status.background
        ? first(active, s.background)
        : first(active, status.detail, title, status.tool);
      break;
    case 'question':
      label = s.question;
      text = first(status.question, status.detail, title);
      break;
    case 'plan':
      label = s.plan;
      text = first(status.detail, s.planText);
      break;
    case 'permission':
      label = status.confident ? s.permission : s.permissionGuess;
      text = first(
        status.tool,
        status.detail,
        status.confident ? s.permissionText : s.permissionGuessText
      );
      break;
    case 'done':
      if (status.hasQuestion) {
        tone = 'attention';
        label = s.asked;
        text = first(status.question, title);
      } else {
        label = s.done;
        text = first(title);
      }
      break;
    case 'interrupted':
      label = s.interrupted;
      text = first(title);
      break;
    case 'error':
      label = s.error;
      text = first(status.detail, title);
      break;
    default:
      label = s.idle;
      text = first(title);
  }

  const since = status.since ?? status.lastActivity;
  return {
    tone,
    label,
    text,
    time:
      since === null ? '' : formatElapsed(options.now - since, options.lang),
    project: options.showProject ? status.project : null,
    progress,
    others: options.others ?? 0,
  };
}

/** A provider notice ("Not installed", …) in the session view's shape. */
export function buildNoticeView(
  notice: { label: Localized; text: Localized; tone?: 'idle' | 'error' },
  lang: Lang
): SessionView {
  return {
    tone: notice.tone === 'error' ? 'error' : 'idle',
    label: notice.label[lang],
    text: notice.text[lang],
    time: '',
    project: null,
    progress: null,
    others: 0,
    wrap: true,
  };
}

// --- running-sessions list (key press) ---------------------------------------

/** Rows per column on the 60px-tall key */
export const LIST_ROWS = 3;
/** Narrowest column; wider keys show more columns side by side */
export const LIST_MIN_COLUMN = 150;
/** The list closes this long after the last press */
export const LIST_TIMEOUT_MS = 15_000;

/** Dot colour of each list group: amber, blue, red, green. */
const GROUP_TONES: Record<RunningGroup, ViewTone> = {
  attention: 'attention',
  working: 'working',
  stopped: 'error',
  done: 'done',
};

export function listTone(group: RunningGroup): ViewTone {
  return GROUP_TONES[group];
}

export type ListRow = { tone: ViewTone; title: string };

export type ListView = {
  /** The rows of the page shown, filled column by column */
  rows: ListRow[];
  /** Zero-based page shown */
  page: number;
  pages: number;
  /** Columns the rows are laid out in */
  columns: number;
  /** Text shown instead of rows when no session is running */
  empty: string;
};

/** Columns and rows per page of the list on a key this wide. */
export function listLayout(width: number): {
  columns: number;
  perPage: number;
} {
  const w = Number.isFinite(width) ? width : 0;
  const columns = Math.max(1, Math.floor(w / LIST_MIN_COLUMN));
  return { columns, perPage: columns * LIST_ROWS };
}

/** Pages the list of `count` sessions takes on a key this wide (at least 1). */
export function listPages(count: number, width: number): number {
  return Math.max(1, Math.ceil(count / listLayout(width).perPage));
}

export function buildListView(
  sessions: Pick<RunningSession, 'status' | 'group'>[],
  options: { lang: Lang; width: number; page: number }
): ListView {
  const s = STRINGS[options.lang];
  const layout = listLayout(options.width);
  const { perPage } = layout;
  const pages = Math.max(1, Math.ceil(sessions.length / perPage));
  // a list that fits on one page takes only the columns it needs, so its
  // titles get the room of the unused ones
  const columns =
    pages > 1
      ? layout.columns
      : Math.min(
          layout.columns,
          Math.max(1, Math.ceil(sessions.length / LIST_ROWS))
        );
  const page = Math.min(Math.max(0, Math.floor(options.page) || 0), pages - 1);
  const rows = sessions
    .slice(page * perPage, (page + 1) * perPage)
    .map(({ status, group }) => ({
      tone: listTone(group),
      title: first(status.title, status.project, s.untitled),
    }));
  return {
    rows,
    page,
    pages,
    columns,
    empty: sessions.length ? '' : s.noRunning,
  };
}

/**
 * Which keys show the running-sessions list, and which page. A press opens
 * the list, the next press shows the next page, and a press on the last page
 * goes back to the normal view; so does LIST_TIMEOUT_MS without a press.
 * Pure: the caller supplies the clock.
 */
export class ListPager {
  private open = new Map<string, { page: number; until: number }>();

  constructor(private readonly timeoutMs = LIST_TIMEOUT_MS) {}

  /** Key press; returns the page now shown, or null for the normal view. */
  press(id: string, now: number, pages: number): number | null {
    const page = this.pageOf(id, now);
    const count = Math.max(1, Math.floor(pages) || 1);
    const next = page === null ? 0 : Math.min(page, count - 1) + 1;
    if (page !== null && next >= count) {
      this.open.delete(id);
      return null;
    }
    this.open.set(id, { page: next, until: now + this.timeoutMs });
    return next;
  }

  /** The page a key shows at `now`, or null for the normal view. */
  pageOf(id: string, now: number): number | null {
    const entry = this.open.get(id);
    if (!entry) return null;
    if (now >= entry.until) {
      this.open.delete(id);
      return null;
    }
    return entry.page;
  }

  /** Back to the normal view for the keys whose id passes the test. */
  close(test: (id: string) => boolean = () => true) {
    for (const id of [...this.open.keys()]) if (test(id)) this.open.delete(id);
  }
}

// --- scheduled-tasks board (key press rotation) --------------------------------

/** A row of the scheduled-tasks page: a dot, the task title, a time label. */
export type AutomationRow = {
  tone: ViewTone;
  title: string;
  /** Right-aligned: the next run, or the state ("Running", "Manual") */
  timeLabel: string;
  /** True for inert tasks (manual, off): the title is dimmed */
  dimmed: boolean;
};

export type AutomationsView = {
  /** The rows of the page shown, filled column by column */
  rows: AutomationRow[];
  /** Zero-based page shown */
  page: number;
  pages: number;
  /** Columns the rows are laid out in */
  columns: number;
  /** Shown instead of rows when there are no tasks (or they unreadable) */
  empty: string;
  /** Tasks in all, for the "+N" math of future layouts */
  total: number;
};

/** Display state of one task, ranked: running, scheduled, manual, off. */
type AutomationState = 'running' | 'due' | 'scheduled' | 'manual' | 'off';

function automationState(item: AutomationItem, now: number): AutomationState {
  if (!item.enabled) return 'off';
  if (item.running) return 'running';
  if (item.cron && item.nextRunAt !== null) {
    return item.nextRunAt <= now ? 'due' : 'scheduled';
  }
  if (item.cron) return 'scheduled'; // its next run could not be computed
  return 'manual';
}

const STATE_RANK: Record<AutomationState, number> = {
  running: 0,
  due: 1,
  scheduled: 1,
  manual: 2,
  off: 3,
};

const STATE_TONE: Record<AutomationState, ViewTone> = {
  running: 'working',
  due: 'working',
  scheduled: 'done',
  manual: 'idle',
  off: 'idle',
};

/** Per-task view facts up to ordering; a failed latest run turns the dot red. */
function automationRow(
  item: AutomationItem,
  now: number,
  lang: Lang
): AutomationRow & { state: AutomationState } {
  const s = STRINGS[lang];
  const state = automationState(item, now);
  let timeLabel: string;
  switch (state) {
    case 'running': {
      const next =
        item.nextRunAt !== null && item.nextRunAt > now
          ? formatNextRun(item.nextRunAt, now, lang, item.timezone)
          : '';
      timeLabel = next
        ? `${s.automationRunning} · ${next}`
        : s.automationRunning;
      break;
    }
    case 'due':
      timeLabel = s.automationDue;
      break;
    case 'scheduled':
      timeLabel =
        item.nextRunAt !== null
          ? formatNextRun(item.nextRunAt, now, lang, item.timezone)
          : s.automationScheduled;
      break;
    case 'manual':
      timeLabel = s.automationManual;
      break;
    default:
      timeLabel = s.automationOff;
  }
  // the latest run failed (and nothing is running): red, marked label
  const failed = item.failed && state !== 'running' && state !== 'off';
  return {
    tone: failed ? 'error' : STATE_TONE[state],
    title: item.title || s.untitled,
    timeLabel: failed ? `✗ ${timeLabel || s.automationFailed}` : timeLabel,
    dimmed: state === 'manual' || state === 'off',
    state,
  };
}

/**
 * The scheduled-tasks page of a key press: running tasks first, then
 * scheduled ones by their next run, then manual and paused ones, paged like
 * the running-sessions list (listLayout). Pure: the clock is an argument.
 */
export function buildAutomationsView(
  board: AutomationBoard,
  options: { lang: Lang; width: number; page: number; now: number }
): AutomationsView {
  const s = STRINGS[options.lang];
  const layout = listLayout(options.width);
  const { perPage } = layout;
  const items = (board.items ?? [])
    .map((item, index) => ({
      row: automationRow(item, options.now, options.lang),
      item,
      index,
    }))
    .sort((a, b) => {
      const rank = STATE_RANK[a.row.state] - STATE_RANK[b.row.state];
      if (rank !== 0) return rank;
      if (a.row.state === 'running') {
        const delta = (b.item.lastRunAt ?? 0) - (a.item.lastRunAt ?? 0);
        if (delta !== 0) return delta;
      } else if (a.row.state === 'due' || a.row.state === 'scheduled') {
        const delta =
          (a.item.nextRunAt ?? Infinity) - (b.item.nextRunAt ?? Infinity);
        if (delta !== 0) return delta;
      } else {
        const delta = (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0);
        if (delta !== 0) return delta;
      }
      return a.index - b.index; // stable: ties never swap between redraws
    });
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const columns =
    pages > 1
      ? layout.columns
      : Math.min(
          layout.columns,
          Math.max(1, Math.ceil(items.length / LIST_ROWS))
        );
  const page = Math.min(Math.max(0, Math.floor(options.page) || 0), pages - 1);
  const rows = items
    .slice(page * perPage, (page + 1) * perPage)
    .map(({ row }) => ({
      tone: row.tone,
      title: row.title,
      timeLabel: row.timeLabel,
      dimmed: row.dimmed,
    }));
  return {
    rows,
    page,
    pages,
    columns,
    empty: items.length
      ? ''
      : board.available
        ? s.noAutomations
        : s.automationsUnavailable,
    total: items.length,
  };
}

// --- next-run labels -------------------------------------------------------------

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const zonedFormatters = new Map<string, Intl.DateTimeFormat | null>();

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/** Wall-clock parts in the task's timezone (or the local one when unknown). */
function zonedParts(ms: number, timezone: string | null): ZonedParts | null {
  const key = timezone ?? '';
  let formatter = zonedFormatters.get(key);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        ...(timezone ? { timeZone: timezone } : {}),
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });
    } catch {
      formatter = null; // an unknown timezone: no parts, no next-run label
    }
    zonedFormatters.set(key, formatter);
  }
  if (!formatter) return null;
  try {
    const byType: Record<string, string> = {};
    for (const part of formatter.formatToParts(new Date(ms))) {
      byType[part.type] = part.value;
    }
    return {
      year: Number(byType.year),
      month: Number(byType.month),
      day: Number(byType.day),
      hour: Number(byType.hour) % 24,
      minute: Number(byType.minute),
    };
  } catch {
    return null;
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The next run as a short label: "in 25m" under an hour ahead, then "14:30"
 * (today), "Tmrw 09:00", "Tue 09:00" (within 6 days) or "10/12 09:00", all
 * in the task's timezone and by its calendar days. Empty when the timezone
 * cannot be read.
 */
export function formatNextRun(
  nextRunAt: number,
  now: number,
  lang: Lang,
  timezone: string | null
): string {
  const s = STRINGS[lang];
  if (nextRunAt - now < 60 * MINUTE_MS) {
    const minutes = Math.min(
      59,
      Math.max(1, Math.ceil((nextRunAt - now) / MINUTE_MS))
    );
    return s.automationInMinutes.replace('{n}', String(minutes));
  }
  const next = zonedParts(nextRunAt, timezone);
  const here = zonedParts(now, timezone);
  if (!next || !here) return '';
  const time = `${pad2(next.hour)}:${pad2(next.minute)}`;
  const dayStart = (p: ZonedParts) => Date.UTC(p.year, p.month - 1, p.day);
  const days = Math.round((dayStart(next) - dayStart(here)) / DAY_MS);
  if (days === 0) return time;
  if (days === 1) return `${s.automationTomorrow} ${time}`;
  if (days > 1 && days <= 6) {
    // the weekday of the wall date in the task's own timezone
    const weekdays = s.automationWeekdays.split(',');
    const dow = new Date(
      Date.UTC(next.year, next.month - 1, next.day)
    ).getUTCDay();
    return `${weekdays[dow]} ${time}`;
  }
  return `${pad2(next.month)}/${pad2(next.day)} ${time}`;
}
