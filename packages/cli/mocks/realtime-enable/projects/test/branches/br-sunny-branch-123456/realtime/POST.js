import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toEqual({
    allowed_origins: [
      'https://app.example.com',
      'http://localhost:3000',
    ],
  });
  res.status(202).send();
}
