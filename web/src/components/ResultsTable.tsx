import { Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import type { HostResult, NsAnswer } from '../api/types';
import { StatusTag } from './StatusTag';

/** Renders the per-nameserver detail shown when a result row is expanded. */
function NsDetail({ answers }: { answers: NsAnswer[] }) {
  const { t } = useTranslation();
  const columns: ColumnsType<NsAnswer> = [
    { title: t('table.nsName'), dataIndex: 'nsName', key: 'nsName' },
    {
      title: t('table.nsIp'),
      dataIndex: 'nsIp',
      key: 'nsIp',
      render: (ip: string | null) => ip ?? t('common.none'),
    },
    {
      title: t('table.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => <StatusTag value={status} ns />,
    },
    {
      title: t('table.returned'),
      dataIndex: 'returnedValues',
      key: 'returnedValues',
      render: (values: string[], row) => (
        <span className="ns-detail-values">
          {values.length > 0 ? values.join(' , ') : t('common.none')}
          {row.error ? ` (${row.error})` : ''}
        </span>
      ),
    },
  ];
  return (
    <Table<NsAnswer>
      size="small"
      rowKey={(r) => `${r.nsName}-${r.nsIp ?? 'na'}`}
      columns={columns}
      dataSource={answers}
      pagination={false}
    />
  );
}

/** Table of host results with expandable per-nameserver detail. */
export function ResultsTable({ results }: { results: HostResult[] }) {
  const { t } = useTranslation();

  const columns: ColumnsType<HostResult> = [
    {
      title: t('table.hostname'),
      dataIndex: 'hostname',
      key: 'hostname',
      render: (host: string, row) => (
        <div>
          <Typography.Text strong>{host}</Typography.Text>
          {row.queryName && row.queryName !== host && (
            <div className="ns-detail-values ns-query-name">
              {t('table.queryName')}: {row.queryName}
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('table.type'),
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (type: string) => <Tag>{type}</Tag>,
    },
    {
      title: t('table.expected'),
      dataIndex: 'expectedValue',
      key: 'expectedValue',
      render: (value: string, row) => (
        <Space direction="vertical" size={2}>
          <span className="ns-detail-values">{value}</span>
          {row.matchMode && row.matchMode !== 'single' && (
            <Tag color="blue">{t(`matchMode.${row.matchMode}`)}</Tag>
          )}
        </Space>
      ),
    },
    {
      title: t('table.status'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string) => <StatusTag value={status} />,
    },
    {
      title: t('table.nameservers'),
      dataIndex: 'authoritativeNameservers',
      key: 'authoritativeNameservers',
      render: (ns: string[]) =>
        ns.length > 0 ? (
          <span className="ns-detail-values">{ns.join(', ')}</span>
        ) : (
          t('common.none')
        ),
    },
    {
      title: t('table.warnings'),
      key: 'warnings',
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          {row.message && (
            <Tag color="error">{t(`message.${row.message}`, row.message)}</Tag>
          )}
          {row.warnings.map((w) => (
            <Tag color="warning" key={w}>
              {t(`warning.${w}`, w)}
            </Tag>
          ))}
        </Space>
      ),
    },
  ];

  return (
    <Table<HostResult>
      size="small"
      rowKey={(r) => `${r.hostname}-${r.type}-${r.expectedValue}`}
      columns={columns}
      dataSource={results}
      pagination={results.length > 25 ? { pageSize: 25 } : false}
      expandable={{
        expandedRowRender: (row) => <NsDetail answers={row.nsAnswers} />,
        rowExpandable: (row) => row.nsAnswers.length > 0,
      }}
    />
  );
}
