import { Router } from 'express';
import os from 'node:os';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { aiHealth } from '../ai/client.js';

const router = Router();

function lanUrls(): string[] {
  const urls: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${config.port}`);
    }
  }
  return urls;
}

router.get('/', (_req, res) => {
  res.json({
    name: 'Unote',
    version: '0.1.0',
    port: config.port,
    ai: { configured: Boolean(config.ai.apiKey), baseUrl: config.ai.baseUrl, textModels: config.ai.textModels },
    lan: { urls: lanUrls() },
  });
});

router.get('/ai-health', async (_req, res) => {
  res.json(await aiHealth());
});

// QR code (data URL) pointing the phone at the LAN address for photo capture.
router.get('/qr', async (req, res) => {
  const urls = lanUrls();
  const target = typeof req.query.url === 'string' ? req.query.url : urls[0];
  if (!target) return res.status(404).json({ error: 'no LAN address found' });
  const dataUrl = await QRCode.toDataURL(target, { width: 320, margin: 1 });
  res.json({ url: target, all: urls, dataUrl });
});

export default router;
