// Every key in this bucket sits inside a folder, so the folder-collapsed
// listing returns folders and no objects: nothing lives directly at the root.
// Echoes the requested prefix like the my-bucket mock.
export default function (req, res) {
  res.status(200).json({
    folders: ['images/', 'logs/'],
    objects: [],
    prefix: req.query.prefix || '',
    next_cursor: '',
    is_truncated: false,
  });
}
