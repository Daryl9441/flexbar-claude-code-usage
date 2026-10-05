import { logger, plugin } from '@eniac/flexdesigner';

// Global plugin settings: PluginConfig in src/providers/types.ts

export type UsageWindow = {
  utilization: number;
  resets_at: string | null;
};

export type UsageLimit = {
  kind: 'session' | 'weekly_all' | 'weekly_scoped' | string;
  group: 'session' | 'weekly' | string;
  percent: number;
  severity: 'normal' | 'warning' | 'critical' | string;
  resets_at: string | null;
  scope: {
    model: { id: string | null; display_name: string } | null;
    surface: string | null;
  } | null;
  is_active: boolean;
};

export type UsageData = {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  seven_day_sonnet: UsageWindow | null;
  limits?: UsageLimit[];
};

export type Metric = 'session' | 'weekly' | 'weekly_model';

/**
 * What a Usage Meter key shows: one limit as used % (a Metric), or 'dual',
 * the 5-hour and weekly limits side by side as remaining %.
 */
export type KeyMetric = Metric | 'dual';

export type Plugin = typeof plugin;
export type Logger = typeof logger;

export type Context = {
  logger: Logger;
  plugin: Plugin;
};
