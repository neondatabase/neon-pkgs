// A bucket with no keys at all: nothing to list and nothing to collapse.
export default function (req, res) {
  res.status(200).json({
    folders: [],
    objects: [],
    prefix: req.query.prefix || '',
    next_cursor: '',
    is_truncated: false,
  });
}
