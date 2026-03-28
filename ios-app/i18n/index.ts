import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';

import en from './en.json';
import zhTW from './zh-TW.json';
import zhCN from './zh-CN.json';
import ja from './ja.json';
import ko from './ko.json';
import th from './th.json';
import vi from './vi.json';
import id from './id.json';
import fr from './fr.json';
import de from './de.json';
import es from './es.json';
import it from './it.json';
import pt from './pt.json';
import nl from './nl.json';
import pl from './pl.json';
import ru from './ru.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'zh-TW', label: '繁體中文', nativeLabel: '繁體中文' },
  { code: 'zh-CN', label: '简体中文', nativeLabel: '简体中文' },
  { code: 'ja', label: '日本語', nativeLabel: '日本語' },
  { code: 'ko', label: '한국어', nativeLabel: '한국어' },
  { code: 'th', label: 'ภาษาไทย', nativeLabel: 'ภาษาไทย' },
  { code: 'vi', label: 'Tiếng Việt', nativeLabel: 'Tiếng Việt' },
  { code: 'id', label: 'Bahasa Indonesia', nativeLabel: 'Bahasa Indonesia' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'it', label: 'Italian', nativeLabel: 'Italiano' },
  { code: 'pt', label: 'Portuguese', nativeLabel: 'Português' },
  { code: 'nl', label: 'Dutch', nativeLabel: 'Nederlands' },
  { code: 'pl', label: 'Polish', nativeLabel: 'Polski' },
  { code: 'ru', label: 'Russian', nativeLabel: 'Русский' },
] as const;

export type LanguageCode = typeof SUPPORTED_LANGUAGES[number]['code'];

/** Detect best matching language from device locale */
function detectLanguage(): string {
  const deviceLocale = Localization.getLocales()[0]?.languageTag ?? 'en';
  const lang = deviceLocale.toLowerCase();

  if (lang.startsWith('zh-hant') || lang === 'zh-tw') return 'zh-TW';
  if (lang.startsWith('zh')) return 'zh-CN';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  if (lang.startsWith('th')) return 'th';
  if (lang.startsWith('vi')) return 'vi';
  if (lang.startsWith('id')) return 'id';
  if (lang.startsWith('fr')) return 'fr';
  if (lang.startsWith('de')) return 'de';
  if (lang.startsWith('es')) return 'es';
  if (lang.startsWith('it')) return 'it';
  if (lang.startsWith('pt')) return 'pt';
  if (lang.startsWith('nl')) return 'nl';
  if (lang.startsWith('pl')) return 'pl';
  if (lang.startsWith('ru')) return 'ru';
  return 'en';
}

i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-TW': { translation: zhTW },
    'zh-CN': { translation: zhCN },
    ja: { translation: ja },
    ko: { translation: ko },
    th: { translation: th },
    vi: { translation: vi },
    id: { translation: id },
    fr: { translation: fr },
    de: { translation: de },
    es: { translation: es },
    it: { translation: it },
    pt: { translation: pt },
    nl: { translation: nl },
    pl: { translation: pl },
    ru: { translation: ru },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export default i18next;
