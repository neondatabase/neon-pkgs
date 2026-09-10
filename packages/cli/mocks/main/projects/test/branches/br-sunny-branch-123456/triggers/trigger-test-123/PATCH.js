import { expect } from 'vitest';

export default function (req, res) {
  const body = req.body ?? {};
  // PATCH must always carry the schedule discriminator.
  expect(body).toMatchObject({ type: 'schedule' });

  // A missing target function returns a DIFFERENT 404 than a missing trigger;
  // the CLI must let this one through untranslated.
  if (body.function_slug === 'ghostfn') {
    res.status(404).send({ message: 'target function not visible on branch' });
    return;
  }

  res.send({
    trigger: {
      type: 'schedule',
      trigger_id: 'trigger-test-123',
      function_slug: body.function_slug ?? 'uptime',
      name: body.name ?? 'uptime-check',
      function_path: body.function_path ?? '/',
      schedule: body.schedule ?? { cron: '*/15 * * * *' },
      enabled: body.enabled ?? true,
      version: 2,
      next_run_at: body.enabled === false ? null : '2026-09-10T03:00:00.000Z',
      source_branch_id: 'br-sunny-branch-123456',
      inherited: false,
    },
  });
}
