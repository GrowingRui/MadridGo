// Share and calendar on the phone: the system share sheet for the text, and an .ics file handed
// to the share sheet, from which the user picks their calendar app. expo-calendar would add the
// event directly, but it does not run in Expo Go; revisit with a development build.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';

import type { Journey } from '../api/journeys';
import { t } from '../i18n';
import { connectionIcs, connectionText, connectionTitle, icsFileName } from './shareConnection';

/** 'shared' when a share sheet opened, 'copied' when the text went to the clipboard (web). */
export type ShareResult = 'shared' | 'copied' | 'downloaded' | 'cancelled';

export async function shareConnection(journey: Journey): Promise<ShareResult> {
  const result = await Share.share(
    { message: connectionText(journey), title: connectionTitle(journey) },
    { dialogTitle: t('share.share'), subject: connectionTitle(journey) },
  );
  return result.action === Share.dismissedAction ? 'cancelled' : 'shared';
}

export async function addConnectionToCalendar(journey: Journey): Promise<ShareResult> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('sharing unavailable');
  const file = new File(Paths.cache, icsFileName(journey));
  file.create({ overwrite: true });
  await file.write(connectionIcs(journey));
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/calendar',
    UTI: 'com.apple.ical.ics',
    dialogTitle: t('share.calendar'),
  });
  return 'shared';
}
