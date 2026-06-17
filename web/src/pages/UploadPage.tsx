import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Divider,
  Input,
  List,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  FileExcelOutlined,
  FileTextOutlined,
  InboxOutlined,
  PlayCircleOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  ApiRequestError,
  checkSingle,
  createBatch,
  getConfig,
  templateUrl,
} from '../api/client';
import type { AppConfig, HostResult, RecordType } from '../api/types';
import { ResultsTable } from '../components/ResultsTable';
import { StatusTag } from '../components/StatusTag';

const { Dragger } = Upload;
const { Title, Paragraph } = Typography;

// Friendly labels for record types that are stored without hyphens.
const TYPE_LABELS: Partial<Record<RecordType, string>> = {
  MTASTS: 'MTA-STS',
  TLSRPT: 'TLS-RPT',
};

function typeLabel(type: RecordType): string {
  return TYPE_LABELS[type] ?? type;
}

export function UploadPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const typeOptions = useMemo(
    () =>
      (config?.recordTypes ?? []).map((type) => ({
        value: type,
        label: typeLabel(type),
      })),
    [config],
  );

  return (
    <Space direction="vertical" size="large" className="full-width">
      <RulesCard />

      <SingleCheckCard typeOptions={typeOptions} />

      <Card>
        <Title level={3}>{t('upload.title')}</Title>
        <Paragraph type="secondary">{t('upload.description')}</Paragraph>
        <UploadForm config={config} onNavigate={navigate} message={message} />
      </Card>

      <TemplateCard config={config} />
    </Space>
  );
}

function RulesCard() {
  const { t } = useTranslation();
  const lines = [
    t('rules.authoritative'),
    t('rules.contains'),
    t('rules.and'),
    t('rules.or'),
    t('rules.operators'),
    t('rules.cname'),
    t('rules.policy'),
  ];
  return (
    <Card title={t('rules.title')}>
      <List
        size="small"
        dataSource={lines}
        renderItem={(line) => <List.Item>{line}</List.Item>}
      />
    </Card>
  );
}

function SingleCheckCard({
  typeOptions,
}: {
  typeOptions: { value: RecordType; label: string }[];
}) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const [hostname, setHostname] = useState('');
  const [type, setType] = useState<RecordType>('A');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HostResult | null>(null);

  const handleCheck = async () => {
    if (!hostname.trim() || !value.trim()) {
      message.warning(t('errors.invalidInput'));
      return;
    }
    setLoading(true);
    try {
      const res = await checkSingle({
        hostname: hostname.trim(),
        type,
        value: value.trim(),
      });
      setResult(res);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'generic';
      message.error(t(`errors.${code}`, t('errors.generic')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title={t('singleCheck.title')}>
      <Paragraph type="secondary">{t('singleCheck.description')}</Paragraph>
      <Space wrap align="end" size="middle">
        <div>
          <div>{t('singleCheck.hostname')}</div>
          <Input
            style={{ width: 260 }}
            value={hostname}
            placeholder={t('singleCheck.hostnamePlaceholder')}
            onChange={(e) => setHostname(e.target.value)}
            onPressEnter={handleCheck}
          />
        </div>
        <div>
          <div>{t('singleCheck.type')}</div>
          <Select
            style={{ width: 130 }}
            value={type}
            options={typeOptions}
            onChange={(v) => setType(v)}
          />
        </div>
        <div>
          <div>{t('singleCheck.value')}</div>
          <Input
            style={{ width: 320 }}
            value={value}
            placeholder={t('singleCheck.valuePlaceholder')}
            onChange={(e) => setValue(e.target.value)}
            onPressEnter={handleCheck}
          />
        </div>
        <Button
          type="primary"
          icon={<SearchOutlined />}
          loading={loading}
          onClick={handleCheck}
        >
          {t('singleCheck.submit')}
        </Button>
      </Space>

      {result && (
        <>
          <Divider />
          <Space style={{ marginBottom: 8 }}>
            <Typography.Text strong>
              {t('singleCheck.resultTitle')}:
            </Typography.Text>
            <StatusTag value={result.status} />
          </Space>
          <ResultsTable results={[result]} />
        </>
      )}
    </Card>
  );
}

function UploadForm({
  config,
  onNavigate,
  message,
}: {
  config: AppConfig | null;
  onNavigate: (path: string) => void;
  message: ReturnType<typeof AntApp.useApp>['message'];
}) {
  const { t } = useTranslation();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const file = fileList[0]?.originFileObj as File | undefined;
    if (!file) {
      message.warning(t('upload.noFile'));
      return;
    }
    setSubmitting(true);
    try {
      const batch = await createBatch(file, name.trim());
      if (batch.warning === 'softLimitExceeded') {
        message.warning(
          t('upload.softLimitExceeded', {
            count: batch.softMaxRecords ?? config?.softMaxRecords,
          }),
        );
      } else {
        message.success(t('upload.started'));
      }
      onNavigate(`/batches/${batch.id}`);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'generic';
      message.error(t(`errors.${code}`, t('errors.generic')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Dragger
        multiple={false}
        maxCount={1}
        accept=".csv,.xlsx,.xls"
        fileList={fileList}
        beforeUpload={() => false}
        onChange={(info) => setFileList(info.fileList.slice(-1))}
        onRemove={() => setFileList([])}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{t('upload.dropText')}</p>
        <p className="ant-upload-hint">{t('upload.dropHint')}</p>
      </Dragger>

      <Divider />

      <Space direction="vertical" className="full-width" size="middle">
        <div>
          <Typography.Text strong>{t('upload.batchName')}</Typography.Text>
          <Input
            style={{ marginTop: 6 }}
            value={name}
            maxLength={120}
            placeholder={t('upload.batchNamePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {config && (
          <Alert
            type="info"
            showIcon
            message={t('upload.softLimitNote', { count: config.softMaxRecords })}
          />
        )}

        <Button
          type="primary"
          size="large"
          icon={<PlayCircleOutlined />}
          loading={submitting}
          onClick={handleSubmit}
          disabled={fileList.length === 0}
        >
          {t('upload.start')}
        </Button>
      </Space>
    </>
  );
}

function TemplateCard({ config }: { config: AppConfig | null }) {
  const { t } = useTranslation();
  return (
    <Card title={t('upload.templateTitle')}>
      <Space direction="vertical" size="middle" className="full-width">
        <Space wrap>
          <Button icon={<FileExcelOutlined />} href={templateUrl('xlsx')}>
            {t('upload.downloadTemplateXlsx')}
          </Button>
          <Button icon={<FileTextOutlined />} href={templateUrl('csv')}>
            {t('upload.downloadTemplateCsv')}
          </Button>
        </Space>

        {config && (
          <div>
            <Typography.Text strong>
              {t('upload.supportedTypes')}:{' '}
            </Typography.Text>
            <Space size={[4, 4]} wrap>
              {config.recordTypes.map((type) => (
                <Tag key={type}>{typeLabel(type)}</Tag>
              ))}
            </Space>
          </div>
        )}
      </Space>
    </Card>
  );
}
