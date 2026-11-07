// Folders and objects share one paged listing, so a page of only folders says
// nothing about the objects directly at the prefix: they can sit on a page
// before or after it. Page one is truncated and hands out `page-2`; the page
// that cursor resumes is the last one.
export default function (req, res) {
  const resumed = req.query.cursor === 'page-2';
  res.status(200).json({
    folders: resumed ? ['logs/'] : ['images/'],
    objects: [],
    prefix: req.query.prefix || '',
    next_cursor: resumed ? '' : 'page-2',
    is_truncated: !resumed,
  });
}
