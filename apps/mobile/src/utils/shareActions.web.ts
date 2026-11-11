// Share and calendar on the website: the browser's share dialog where there is one (phones,
// Safari, Edge), otherwise the text is copied; the calendar event downloads as an .ics file,
// which Apple Calendar, Outlook and Google Calendar (import) open.

import type { Journey } from '../api/journeys';
import { connectionIcs, connectionText, connectionTitle, icsFileName } from './shareConnection';

export type ShareResult = 'shared' | 'copied' | 'downloaded' | 'cancelled';

export async function shareConnection(journey: Journey): Promise<ShareResult> {
  const data = { title: connectionTitle(journey), text: connectionText(journey) };
  if (typeof navigator.share === 'function' && (navigator.canShare?.(data) ?? true)) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return 'cancelled';
      // Not allowed here (e.g. desktop Chrome without a share target): copy instead.
    }
  }
  await navigator.clipboard.writeText(data.text);
  return 'copied';
}

export async function addConnectionToCalendar(journey: Journey): Promise<ShareResult> {
  const blob = new Blob([connectionIcs(journey)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = icsFileName(journey);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
