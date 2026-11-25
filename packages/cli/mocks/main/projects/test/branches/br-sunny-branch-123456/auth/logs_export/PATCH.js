import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toStrictEqual({ enabled: expect.any(Boolean) });
  expect([true, false]).toContain(req.body.enabled);
  res.send({ enabled: req.body.enabled });
}
