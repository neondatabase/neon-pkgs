import { expect } from 'vitest';

export default function (req, res) {
  const body = req.body ?? {};
  expect(body).toMatchObject({ type: 'storage_object_created' });
  expect(body).not.toHaveProperty('schedule');

  res.send({
    trigger: {
      type: 'storage_object_created',
      trigger_id: 'trigger-storage-123',
      function_slug: body.function_slug ?? 'ingest',
      name: body.name ?? 'uploads',
      function_path: body.function_path ?? '/',
      storage_object_created: body.storage_object_created ?? {
        bucket_name: 'uploads',
        prefix: 'incoming/',
      },
      enabled: body.enabled ?? true,
      version: 2,
      inherited: false,
    },
  });
}
