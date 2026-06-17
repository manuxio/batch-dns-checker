import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Popconfirm,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  FileExcelOutlined,
  RedoOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  ApiRequestError,
  deleteBatch,
  exportUrl,
  getConfig,
  listBatches,
  rerunBatch,
} from '../api/client';
import type { BatchSummary } from '../api/types';
import { StatusTag } from '../components/StatusTag';
import { CountsSummary } from '../components/CountsSummary';

export function HistoryPage() {
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();

  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [maxBatches, setMaxBatches] = useState(10);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listBatches();
      setBatches(list);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'generic';
      message.error(t(`errors.${code}`, t('errors.generic')));
    } finally {
      setLoading(false);
    }
  }, [message, t]);

  useEffect(() => {
    void load();
    getConfig()
      .then((c) => setMaxBatches(c.maxBatches))
      .catch(() => undefined);
  }, [load]);

  const handleDelete = async (id: string) => {
    try {
      await deleteBatch(id);
      message.success(t('history.deleted'));
      await load();
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'generic';
      message.error(t(`errors.${code}`, t('errors.generic')));
    }
  };

  const handleRerun = async (id: string) => {
    try {
      const batch = await rerunBatch(id);
      message.success(t('batch.rerunStarted'));
      navigate(`/batches/${batch.id}`);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'generic';
      message.error(t(`errors.${code}`, t('errors.generic')));
    }
  };

  const columns: ColumnsType<BatchSummary> = [
    {
      title: t('batch.name'),
      key: 'name',
      render: (_, row) => (
        <Link to={`/batches/${row.id}`}>
          {row.name || row.fileName || row.id}
        </Link>
      ),
    },
    {
      title: t('batch.createdAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 200,
      render: (value: string) => new Date(value).toLocaleString(i18n.language),
    },
    {
      title: t('table.status'),
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (status: string) => <StatusTag value={status} />,
    },
    {
      title: t('counts.total'),
      key: 'counts',
      render: (_, row) => (
        <CountsSummary
          counts={row.counts}
          invalidCount={row.invalidCount}
          total={row.total}
        />
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 180,
      render: (_, row) => (
        <Space>
          <Tooltip title={t('batch.rerun')}>
            <Button
              size="small"
              icon={<RedoOutlined />}
              onClick={() => handleRerun(row.id)}
            />
          </Tooltip>
          <Tooltip title={t('batch.downloadXlsx')}>
            <Button
              size="small"
              icon={<FileExcelOutlined />}
              href={exportUrl(row.id, 'xlsx')}
              disabled={row.status === 'running' || row.status === 'pending'}
            />
          </Tooltip>
          <Popconfirm
            title={t('history.deleteConfirm')}
            okText={t('common.yes')}
            cancelText={t('common.no')}
            onConfirm={() => handleDelete(row.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('history.title')}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={t('history.max', { count: maxBatches })}
        />
        {batches.length === 0 && !loading ? (
          <Typography.Text type="secondary">
            {t('history.empty')}
          </Typography.Text>
        ) : (
          <Table<BatchSummary>
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={batches}
            pagination={false}
          />
        )}
      </Space>
    </Card>
  );
}
