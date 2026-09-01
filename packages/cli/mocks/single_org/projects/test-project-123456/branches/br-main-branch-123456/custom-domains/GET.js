const page1 = {
  custom_domains: [
    {
      domain: 'docs.example.com',
      entity_type: 'function',
      entity_id: 'api',
      cname_target: 'abc.custom.neon.tech',
    },
  ],
  pagination: { next: 'page-2' },
};

const page2 = {
  custom_domains: [
    {
      domain: 'app.example.com',
      entity_type: 'function',
      entity_id: 'app',
      cname_target: 'abc.custom.neon.tech',
    },
  ],
};

export default function (req, res) {
  if (req.query.limit !== '100') {
    return res.status(500).send({ message: 'expected limit=100' });
  }
  res.send(req.query.cursor === 'page-2' ? page2 : page1);
}
