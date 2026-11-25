import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toEqual({ enabled: req.body.enabled });
  expect(typeof req.body.enabled).toBe('boolean');
  res.send({ enabled: req.body.enabled });
}
