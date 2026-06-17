import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import it from './it.json';
import en from './en.json';

// Italian is the default; the chosen language is persisted in localStorage so
// the app stays in the user's preferred locale across visits.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      it: { translation: it },
      en: { translation: en },
    },
    fallbackLng: 'it',
    supportedLngs: ['it', 'en'],
    detection: {
      order: ['localStorage'],
      caches: ['localStorage'],
      lookupLocalStorage: 'coni-dns-lang',
    },
    interpolation: { escapeValue: false },
  });

export default i18n;
