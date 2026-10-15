import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toEqual({});
  res.status(202).send();
}
