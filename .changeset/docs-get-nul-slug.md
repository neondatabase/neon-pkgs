---
"@neon/tools": patch
---

`docs.get` (`get_doc`) rejects a slug that contains a NUL character with "Invalid doc slug: NUL characters are not allowed", reported as the caller's mistake. It used to send the request, get a 400 from neon.com, and fail as a server error.
