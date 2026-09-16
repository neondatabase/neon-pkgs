import { expect } from 'vitest';

export default function (req, res) {
  if (req.body.type === 'storage_object_created') {
    expect(req.body).toMatchObject({
      type: 'storage_object_created',
      function_slug: 'ingest',
      name: 'on-upload',
      storage_object_created: { bucket_name: 'assets', prefix: 'logos/' },
    });

    res.status(201).send({
      trigger: {
        type: 'storage_object_created',
        trigger_id: 'trigger-storage-123',
        function_slug: 'ingest',
        name: 'on-upload',
        function_path: '/object',
        storage_object_created: {
          bucket_name: 'assets',
          prefix: 'logos/',
        },
        enabled: true,
        version: 1,
        inherited: false,
      },
    });
    return;
  }

  expect(req.body).toMatchObject({
    type: 'schedule',
    function_slug: 'uptime',
    name: 'uptime-check',
    schedule: { cron: '*/15 * * * *' },
  });

  res.status(201).send({
    trigger: {
      type: 'schedule',
      trigger_id: 'trigger-test-123',
      function_slug: 'uptime',
      name: 'uptime-check',
      function_path: '/',
      schedule: { cron: '*/15 * * * *' },
      enabled: true,
      version: 1,
      next_run_at: '2026-09-10T03:00:00.000Z',
      source_branch_id: 'br-sunny-branch-123456',
      inherited: false,
    },
  });
}
