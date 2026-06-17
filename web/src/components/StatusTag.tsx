import { Tag } from 'antd';
import { useTranslation } from 'react-i18next';

const STATUS_COLORS: Record<string, string> = {
  ok: 'success',
  warning: 'warning',
  error: 'error',
  cancelled: 'default',
  pending: 'default',
  running: 'processing',
  completed: 'success',
  stopped: 'orange',
  interrupted: 'orange',
};

const NS_COLORS: Record<string, string> = {
  ok: 'success',
  mismatch: 'error',
  error: 'error',
  timeout: 'warning',
};

/** Renders a coloured, localized tag for a batch/host or per-nameserver status. */
export function StatusTag({ value, ns = false }: { value: string; ns?: boolean }) {
  const { t } = useTranslation();
  const color = (ns ? NS_COLORS : STATUS_COLORS)[value] ?? 'default';
  const label = t(`${ns ? 'nsStatus' : 'status'}.${value}`, value);
  return <Tag color={color}>{label}</Tag>;
}
