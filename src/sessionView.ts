/**
 * What a Session Status key shows, as plain data: label, colors and text
 * lines for a SessionStatus. Pure (no canvas), so it is testable and doubles
 * as the redraw signature — a key is only redrawn when its view changes.
 */
import { SessionState, SessionStatus } from './session';

export type Lang = 'en' | 'zh';

export type ViewTone = 'working' | 'attention' | 'done' | 'error' | 'idle';

export type SessionView = {
  tone: ViewTone;
  /** Status label, e.g. "Working", "Question" */
  label: string;
  /** Main text line: question, current task, title… */
  text: string;
  /** Longer text for the detail view (key press) */
  detail: string;
  /** Compact time, e.g. "3m", "刚刚" */
  time: string;
  project: string | null;
  progress: { completed: number; total: number } | null;
  /** Other sessions working or needing the user */
  others: number;
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
    noneText: 'Start Claude Code',
    background: 'Background tasks running',
    planText: 'Review the plan',
    permissionText: 'Waiting for permission',
    permissionGuessText: 'Probably waiting for permission',
    now: 'now',
    minutes: (n: number) => `${n}m`,
    hours: (n: number) => `${n}h`,
    days: (n: number) => `${n}d`,
    options: (list: string) => `Options: ${list}`,
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
    noneText: '启动 Claude Code',
    background: '后台任务运行中',
    planText: '请审阅计划',
    permissionText: '等待授权',
    permissionGuessText: '可能在等待授权',
    now: '刚刚',
    minutes: (n: number) => `${n}分钟`,
    hours: (n: number) => `${n}小时`,
    days: (n: number) => `${n}天`,
    options: (list: string) => `选项：${list}`,
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
};

export function buildSessionView(
  status: SessionStatus | null,
  options: ViewOptions
): SessionView {
  const s = STRINGS[options.lang];
  if (!status) {
    return {
      tone: 'idle',
      label: s.none,
      text: s.noneText,
      detail: s.noneText,
      time: '',
      project: null,
      progress: null,
      others: 0,
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
  let detail: string;

  switch (status.state) {
    case 'working':
      label = s.working;
      text = status.background
        ? first(active, s.background)
        : first(active, status.detail, title, status.tool);
      detail = [first(active, status.tool, status.detail), title]
        .filter(Boolean)
        .join(' · ');
      break;
    case 'question': {
      label = s.question;
      text = first(status.question, status.detail, title);
      const opts = status.options.length
        ? s.options(status.options.join(' / '))
        : '';
      detail = [text, opts].filter(Boolean).join(' — ');
      break;
    }
    case 'plan':
      label = s.plan;
      text = first(status.detail, s.planText);
      detail = first(status.detail, title, s.planText);
      break;
    case 'permission':
      label = status.confident ? s.permission : s.permissionGuess;
      text = first(
        status.tool,
        status.detail,
        status.confident ? s.permissionText : s.permissionGuessText
      );
      detail = [
        status.confident ? s.permissionText : s.permissionGuessText,
        first(status.tool, status.detail),
      ]
        .filter(Boolean)
        .join(': ');
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
      detail = first(status.question, title);
      break;
    case 'interrupted':
      label = s.interrupted;
      text = first(title);
      detail = text;
      break;
    case 'error':
      label = s.error;
      text = first(status.detail, title);
      detail = [status.detail, title].filter(Boolean).join(' · ');
      break;
    default:
      label = s.idle;
      text = first(title);
      detail = text;
  }

  const since = status.since ?? status.lastActivity;
  return {
    tone,
    label,
    text,
    detail: detail || text,
    time:
      since === null ? '' : formatElapsed(options.now - since, options.lang),
    project: options.showProject ? status.project : null,
    progress,
    others: options.others ?? 0,
  };
}
