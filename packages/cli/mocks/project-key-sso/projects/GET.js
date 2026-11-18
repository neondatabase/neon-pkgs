// SSO denials arrive as 404 with a machine code; the CLI's SSO handler owns them.
export default function (_req, res) {
  res.status(404).json({
    code: 'SSO_ORG_CREDS_ONLY',
    message: 'This organization only accepts organization API keys.',
  });
}
