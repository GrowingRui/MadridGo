// Tests run in English with an in-memory AsyncStorage, whatever the machine's language.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// eslint-disable-next-line import/first
import { setLanguageForTests } from './src/i18n';

setLanguageForTests('en');
