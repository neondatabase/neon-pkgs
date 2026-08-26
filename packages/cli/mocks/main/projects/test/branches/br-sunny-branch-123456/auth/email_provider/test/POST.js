import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toEqual({
    recipient_email: req.body.recipient_email,
  });
  expect(typeof req.body.recipient_email).toBe('string');

  if (req.body.recipient_email === 'fail@test.com') {
    res.send({
      success: false,
      error_message: 'auth failed: 535',
    });
    return;
  }

  res.send({
    success: true,
  });
}
