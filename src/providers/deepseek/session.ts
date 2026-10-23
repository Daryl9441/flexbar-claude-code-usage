/**
 * DeepSeek has no local coding-session files. The session key says so
 * instead of watching a folder.
 */
import { staticSessionSource } from '../kit';
import {
  SessionDescription,
  SessionNotice,
  SessionProvider,
  SessionSourceOptions,
} from '../types';

const NOTICE: SessionNotice = {
  label: { en: 'Balance only', zh: '仅余额' },
  text: { en: 'No local sessions', zh: '没有本地会话' },
  tone: 'idle',
};

export const sessionProvider: SessionProvider = {
  location(): string {
    return 'deepseek-api';
  },
  create(options: SessionSourceOptions) {
    return staticSessionSource(options, NOTICE);
  },
  async describe(): Promise<SessionDescription> {
    return {
      success: true,
      projectsDir: null,
      state: null,
      project: null,
      title: null,
      others: 0,
      notice: NOTICE,
    };
  },
};
