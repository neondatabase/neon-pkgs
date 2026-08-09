import { writeFileSync } from 'node:fs';

// `unknown-field` reproduces the API's rejection of a field this branch has
// never emitted; every other name returns values and captures the query string
// the CLI sent.
export default function (req, res) {
  if (req.params.field_name === 'unknown-field') {
    res.status(400).json({
      code: 'invalid_query',
      message:
        'unknown log field "unknown-field"; call the log fields endpoint for the fields this branch supports',
      reason: 'unknown_field',
    });
    return;
  }
  const sink = process.env.NEONCTL_TEST_LOGS_FIELD_VALUES_SINK;
  if (sink) {
    writeFileSync(
      sink,
      JSON.stringify({ field_name: req.params.field_name, query: req.query })
    );
  }
  res.status(200).json({
    values: ['api', 'postgres', 'worker'],
    is_truncated: false,
  });
}
