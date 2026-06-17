import { Space, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import type { BatchCounts } from '../api/types';

interface Props {
  counts: BatchCounts;
  invalidCount?: number;
  total?: number;
}

/** Compact coloured breakdown of result counts. */
export function CountsSummary({ counts, invalidCount, total }: Props) {
  const { t } = useTranslation();
  return (
    <Space size={[4, 4]} wrap>
      {total !== undefined && (
        <Tag>{`${t('counts.total')}: ${total}`}</Tag>
      )}
      <Tag color="success">{`${t('counts.ok')}: ${counts.ok}`}</Tag>
      <Tag color="warning">{`${t('counts.warning')}: ${counts.warning}`}</Tag>
      <Tag color="error">{`${t('counts.error')}: ${counts.error}`}</Tag>
      {counts.cancelled > 0 && (
        <Tag color="default">{`${t('counts.cancelled')}: ${counts.cancelled}`}</Tag>
      )}
      {invalidCount !== undefined && invalidCount > 0 && (
        <Tag color="default">{`${t('counts.invalid')}: ${invalidCount}`}</Tag>
      )}
    </Space>
  );
}
