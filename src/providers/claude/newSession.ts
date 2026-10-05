/**
 * Claude's New Session key: the Claude desktop app's claude://code/new deep
 * link (src/newSession.ts), opened with the system URL handler.
 */
import { buildNewSessionUrl } from '../../newSession';
import { NewSessionLauncher } from '../types';

export const claudeNewSessionLauncher: NewSessionLauncher = {
  appName: 'the Claude app',
  strings: {
    error: { en: 'Claude app not found', zh: '未找到 Claude App' },
  },
  target: request => ({
    kind: 'url',
    url: buildNewSessionUrl(request.rawFolder, request.home),
  }),
};
