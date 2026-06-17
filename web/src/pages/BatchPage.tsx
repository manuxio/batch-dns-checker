import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Popconfirm,
  Progress,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  FileExcelOutlined,
  FileTextOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  ApiRequestError,
  exportUrl,
  getBatch,
  getBatchGroups,
  stopBatch,
} from '../api/client';
import type { Batch, DomainGroup, InvalidRow } from '../api/types';
import { StatusTag } from '../components/StatusTag';
import { CountsSummary } from '../components/CountsSummary';
import { ResultsTable } from '../components/ResultsTable';

const RUNNING_STATES = ['pending', 'running'];

export function BatchPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const { message } = AntApp.useApp();

  const [batch, setBatch] = useState<Batch | null>(null);
  const [groups, setGroups] = useState<DomainGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextBatch, nextGroups] = await Promise.all([
        getBatch(id),
        getBatchGroups(id),
      ]);
      setBatch(nextBatch);
      setGroups(nextGroups);
      return nextBatch.status;
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'generic';
      message.error(t(`errors.${code}`, t('errors.generic')));
      return 'error';
    } finally {
      setLoading(false);
    }
  }, [id, message, t]);

  // Initial load + polling while the batch is still running.
  useEffect(() => {
    let active = true;
    const tick = async () => {
      const status = await load();
      if (!active) return;
      if (RUNNING_STATES.includes(status)) {
        timerRef.current = window.setTimeout(tick, 1500);
      }
    };
    void tick();
    return () => {
      active = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [load]);

  const handleStop = async () => {
    setStopping(true);
    try {
      await stopBatch(id);
      message.info(t('batch.stopRequested'));
      await load();
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'generic';
      message.error(t(`errors.${code}`, t('errors.generic')));
    } finally {
      setStopping(false);
    }
  };

  if (loading && !batch) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!batch) {
    return <Alert type="error" showIcon message={t('errors.batchNotFound')} />;
  }

  const isRunning = RUNNING_STATES.includes(batch.status);
  const percent =
    batch.total > 0 ? Math.round((batch.completed / batch.total) * 100) : 0;

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleString(i18n.language) : t('common.none');

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card>
        <Space
          style={{ width: '100%', justifyContent: 'space-between' }}
          align="start"
          wrap
        >
          <Space direction="vertical" size={4}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {batch.name || batch.fileName || batch.id}
            </Typography.Title>
            <Space wrap>
              <StatusTag value={batch.status} />
              <CountsSummary
                counts={batch.counts}
                invalidCount={batch.invalidCount}
                total={batch.total}
              />
            </Space>
          </Space>

          <Space wrap>
            {isRunning && (
              <Popconfirm
                title={t('batch.stopConfirm')}
                okText={t('common.yes')}
                cancelText={t('common.no')}
                onConfirm={handleStop}
              >
                <Button danger icon={<StopOutlined />} loading={stopping}>
                  {t('batch.stop')}
                </Button>
              </Popconfirm>
            )}
            <Button
              icon={<FileExcelOutlined />}
              href={exportUrl(id, 'xlsx')}
              disabled={isRunning}
            >
              {t('batch.downloadXlsx')}
            </Button>
            <Button
              icon={<FileTextOutlined />}
              href={exportUrl(id, 'csv')}
              disabled={isRunning}
            >
              {t('batch.downloadCsv')}
            </Button>
          </Space>
        </Space>

        <Progress
          style={{ marginTop: 16 }}
          percent={percent}
          status={
            isRunning
              ? 'active'
              : batch.status === 'completed'
                ? 'success'
                : 'normal'
          }
        />

        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, md: 3 }}
          style={{ marginTop: 12 }}
        >
          {batch.fileName && (
            <Descriptions.Item label={t('batch.file')}>
              {batch.fileName}
            </Descriptions.Item>
          )}
          <Descriptions.Item label={t('batch.createdAt')}>
            {formatDate(batch.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label={t('batch.finishedAt')}>
            {formatDate(batch.finishedAt)}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {batch.invalidRows.length > 0 && (
        <Card title={t('batch.invalidRows', { count: batch.invalidRows.length })}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('batch.invalidRowsDesc')}
          />
          <InvalidRowsTable rows={batch.invalidRows} />
        </Card>
      )}

      <Card title={t('batch.groupedByDomain')}>
        {isRunning && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('batch.checkingTitle')}
          />
        )}
        {groups.length === 0 ? (
          <Typography.Text type="secondary">
            {t('batch.noResults')}
          </Typography.Text>
        ) : (
          <Collapse
            defaultActiveKey={groups.map((g) => g.domain)}
            items={groups.map((group) => ({
              key: group.domain,
              label: (
                <Space wrap>
                  <Typography.Text strong>{group.domain}</Typography.Text>
                  <CountsSummary counts={group.counts} total={group.total} />
                </Space>
              ),
              children: <ResultsTable results={group.results} />,
            }))}
          />
        )}
      </Card>
    </Space>
  );
}

function InvalidRowsTable({ rows }: { rows: InvalidRow[] }) {
  const { t } = useTranslation();
  const columns: ColumnsType<InvalidRow> = [
    {
      title: t('table.row'),
      dataIndex: 'rowNumber',
      key: 'rowNumber',
      width: 80,
    },
    {
      title: t('table.error'),
      dataIndex: 'error',
      key: 'error',
      render: (error: string) =>
        error
          .split(',')
          .map((code) => t(`invalid.${code.trim()}`, code.trim()))
          .join(', '),
    },
  ];
  return (
    <Table<InvalidRow>
      size="small"
      rowKey="rowNumber"
      columns={columns}
      dataSource={rows}
      pagination={false}
    />
  );
}
