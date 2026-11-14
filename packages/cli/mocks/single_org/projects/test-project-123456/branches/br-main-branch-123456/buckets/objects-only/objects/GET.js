// A flat listing: every key comes back as an object and none collapse into a
// folder, as with --recursive on a bucket whose keys are all nested.
export default function (req, res) {
  res.status(200).json({
    folders: [],
    objects: [
      {
        key: 'images/logo.png',
        size: 4096,
        last_modified: '2021-03-03T00:00:00.000Z',
        etag: '"ghi789"',
      },
      {
        key: 'logs/app.log',
        size: 512,
        last_modified: '2021-04-04T00:00:00.000Z',
        etag: '"jkl012"',
      },
    ],
    prefix: req.query.prefix || '',
    next_cursor: '',
    is_truncated: false,
  });
}
