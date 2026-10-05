import "./server.js";

import { createServer } from "vite";

const vite = await createServer();
await vite.listen();
vite.printUrls();
