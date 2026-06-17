import { Segmented } from 'antd';
import { useTranslation } from 'react-i18next';

/** Toggles the UI language between Italian and English (persisted). */
export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const value = i18n.language.startsWith('en') ? 'en' : 'it';

  return (
    <Segmented
      value={value}
      onChange={(next) => void i18n.changeLanguage(String(next))}
      options={[
        { label: 'IT', value: 'it' },
        { label: 'EN', value: 'en' },
      ]}
    />
  );
}
