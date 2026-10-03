export default function (req, res) {
  const { name, no_login } = req.body.role;
  // Answer a wrong body with 400 rather than throwing, so a regression fails fast instead of
  // waiting for the CLI's request timeout.
  const expected = name === 'no_login_role' ? true : undefined;
  if ((name !== 'test_role' && name !== 'no_login_role') || no_login !== expected) {
    return res.status(400).send({ message: `unexpected role body: ${JSON.stringify(req.body)}` });
  }

  // Like the API: a login role comes back with its generated password, a no-login role without one.
  res.send({
    role: {
      name,
      ...(no_login ? {} : { password: 'generated_pwd' }),
      created_at: '2019-01-01T00:00:00.000Z',
    },
  });
}
