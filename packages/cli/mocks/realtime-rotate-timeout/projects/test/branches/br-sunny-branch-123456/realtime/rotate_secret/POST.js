import { expect } from 'vitest';

let calls = 0;

export default function (req, res) {
  calls += 1;
  expect(calls).toBe(1);
  expect(req.body).toEqual({});
  res.status(202).send();
}
