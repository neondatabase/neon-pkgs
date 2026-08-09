import { writeFileSync } from 'node:fs';

// Captures the request body the CLI actually sent, so a test can assert every
// flag reached the API under its wire name. The response envelope stays exactly
// what the API returns — echoing the request into it would make the snapshots
// document a shape the API never emits.
export default function (req, res) {
  const sink = process.env.NEONCTL_TEST_LOGS_QUERY_SINK;
  if (sink) {
    writeFileSync(sink, JSON.stringify(req.body));
  }
  res.status(200).json({
    logs: [
      {
        timestamp: '2025-01-01T00:00:02.000Z',
        message: 'GET /api/todos 200',
        source: 'function',
        entity_id: 'fn-api',
        service_name: 'api',
        scope_name: 'http',
        severity_number: 9,
        severity_text: 'INFO',
        trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        span_id: '00f067aa0ba902b7',
        attributes: { http_status: 200 },
      },
      {
        timestamp: '2025-01-01T00:00:01.000Z',
        message: 'connection to database failed',
        source: 'pg_endpoint',
        entity_id: 'ep-quiet-hill-123456',
        service_name: 'postgres',
        severity_number: 17,
        severity_text: 'ERROR',
        attributes: {},
      },
    ],
    next_cursor: '',
    is_truncated: false,
  });
}
