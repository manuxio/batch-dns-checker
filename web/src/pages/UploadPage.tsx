import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Divider,
  Input,
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
} from '@ant-design/icons';
import { createBatch, getConfig, templateUrl } from '../api/client';
import { ApiRequestError } from '../api/client';
import type { AppConfig } from '../api/types';

const { Dragger } = Upload;
const { Title, Paragraph } = Typography;

export function UploadPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

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
      navigate(`/batches/${batch.id}`);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : 'generic';
      message.error(t(`errors.${code}`, t('errors.generic')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card>
        <Title level={3}>{t('upload.title')}</Title>
        <Paragraph type="secondary">{t('upload.description')}</Paragraph>

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

        <Space direction="vertical" style={{ width: '100%' }} size="middle">
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
              message={t('upload.softLimitNote', {
                count: config.softMaxRecords,
              })}
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
      </Card>

      <Card title={t('upload.templateTitle')}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Button
              icon={<FileExcelOutlined />}
              href={templateUrl('xlsx')}
            >
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
                  <Tag key={type}>{type}</Tag>
                ))}
              </Space>
            </div>
          )}
        </Space>
      </Card>
    </Space>
  );
}
