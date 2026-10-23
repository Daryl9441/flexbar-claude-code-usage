/**
 * DeepSeek's third key opens the official chat site. It does not start an
 * API session and it does not send the API key.
 */
import { LaunchTarget, NewSessionLauncher } from '../types';

export const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com/';

export const newSessionLauncher: NewSessionLauncher = {
  appName: 'DeepSeek',
  strings: {
    ready: { en: 'Open DeepSeek', zh: '打开 DeepSeek' },
    opening: { en: 'Opening…', zh: '正在打开…' },
    error: { en: 'DeepSeek unavailable', zh: '无法打开 DeepSeek' },
  },
  subtitle: (_data, _folder, lang) =>
    lang === 'zh' ? '打开网页' : 'Opens the site',
  target(): LaunchTarget {
    return { kind: 'url', url: DEEPSEEK_CHAT_URL };
  },
};
