let calls = 0;

export default function (_req, res) {
  calls += 1;
  res.send({
    enabled: true,
    pending: calls === 1,
    allowed_origins: ['https://app.example.com', 'http://localhost:3000'],
  });
}
