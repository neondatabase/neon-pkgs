export default function (req, res) {
  res.status(201).send({
    domain: req.body.domain,
    entity_type: req.body.entity_type,
    entity_id: req.body.entity_id,
    cname_target: 'abc.custom.neon.tech',
  });
}
