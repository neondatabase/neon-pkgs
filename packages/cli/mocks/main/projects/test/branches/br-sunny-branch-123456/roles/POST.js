import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toMatchObject({
    role: {
      name: 'test_role',
    },
  });

  // Like the API: a login role comes back with its generated password, a no-login role without one.
  res.send({
    role: {
      name: 'test_role',
      ...(req.body.role.no_login ? {} : { password: 'generated_pwd' }),
      created_at: '2019-01-01T00:00:00.000Z',
    },
  });
}
