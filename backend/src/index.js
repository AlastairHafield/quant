import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import routes from './api/routes.js';
import mcpRouter from './mcp/router.js';
import { getDb } from './data/db.js';

dotenv.config();

// Ensure data directory exists
const __dirname = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(__dirname, '../data'), { recursive: true });

// Init DB
getDb();

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// In production the React build is served same-origin, so CORS isn't needed.
// In dev, allow the CRA dev server on :3000.
if (!isProd) {
  app.use(cors({ origin: 'http://localhost:3000' }));
}
app.use(express.json());

app.use('/api', routes);
app.use('/mcp', mcpRouter);

// Serve the built React frontend in production (single dyno = full stack).
if (isProd) {
  const buildDir = path.join(__dirname, '../../frontend/build');
  app.use(express.static(buildDir));
  app.get('*', (req, res) => res.sendFile(path.join(buildDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`Quant backend running on port ${PORT} (${isProd ? 'production' : 'development'})`);
  console.log(`FMP API key: ${process.env.FMP_API_KEY ? 'SET' : 'NOT SET'}`);
});
