import { expect } from 'vitest';

export default function (req, res) {
  expect(Array.isArray(req.body.schedule)).toBe(true);
  expect(req.body.schedule.length).toBeGreaterThan(0);
  for (const item of req.body.schedule) {
    expect(typeof item.frequency).toBe('string');
  }
  // PUT backup_schedule returns an empty body on success.
  res.status(200).send();
}
