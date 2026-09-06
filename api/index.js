const express = require('express');
const fetch = require('node-fetch');
const Jimp = require('jimp');
const JSZip = require('jszip');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ========== HELPER: resize icon ==========
async function resizeIcon(base64, size) {
  const buffer = Buffer.from(base64.split(',')[1] || base64, 'base64');
  const image = await Jimp.read(buffer);
  const newImage = new Jimp(size, size, 0xffffffff);
  image.resize(size, size);
  const x = (size - image.bitmap.width) / 2;
  const y = (size - image.bitmap.height) / 2;
  newImage.composite(image, x, y);
  const resizedBuffer = await newImage.getBufferAsync(Jimp.MIME_PNG);
  return 'data:image/png;base64,' + resizedBuffer.toString('base64');
}

// ========== HELPER: generate default icon ==========
async function generateDefaultIcon(name) {
  const size = 512;
  const image = new Jimp(size, size, 0xffffffff);
  const hue = Math.floor(Math.random() * 360);
  const baseColor = Jimp.rgbaToInt(
    200 + 55 * Math.sin(hue * Math.PI / 180),
    150 + 100 * Math.cos(hue * Math.PI / 180),
    200 + 55 * Math.sin((hue + 120) * Math.PI / 180),
    255
  );
  image.scan(0, 0, size, size, (x, y, idx) => {
    const ratio = (x + y) / (2 * size);
    const r = (baseColor >> 24) & 0xff;
    const g = (baseColor >> 16) & 0xff;
    const b = (baseColor >> 8) & 0xff;
    const newR = Math.floor(r + (255 - r) * ratio);
    const newG = Math.floor(g + (255 - g) * ratio);
    const newB = Math.floor(b + (255 - b) * ratio);
    image.setPixelColor(Jimp.rgbaToInt(newR, newG, newB, 255), x, y);
  });
  const font = await Jimp.loadFont(Jimp.FONT_SANS_128_BLACK);
  const text = name.charAt(0).toUpperCase();
  const textImg = new Jimp(size, size, 0x00000000);
  textImg.print(font, 0, 0, text, size, size);
  const bounds = await Jimp.measureText(font, text);
  const tx = (size - bounds.width) / 2;
  const ty = (size - bounds.height) / 2;
  const white = new Jimp(size, size, 0xffffffff);
  white.print(font, tx, ty, text);
  image.composite(white, 0, 0);
  const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
  return 'data:image/png;base64,' + buffer.toString('base64');
}

// ========== HELPER: buat PWA ZIP (fallback) ==========
async function generatePWAZip(name, url, icon192, icon512) {
  const zip = new JSZip();
  const manifest = {
    name,
    short_name: name,
    start_url: url,
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1c1c2e',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
    ]
  };
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"><link rel="manifest" href="manifest.json"><link rel="icon" href="icon-192.png"><title>${name}</title><style>body{margin:0;padding:0;overflow:hidden;background:#fff}iframe{width:100vw;height:100vh;border:none}</style></head><body><iframe src="${url}" allow="geolocation; microphone; camera; midi; encrypted-media"></iframe></body></html>`;
  const sw = `self.addEventListener('install',e=>e.waitUntil(caches.open('baim-cache').then(c=>c.addAll(['/','index.html','manifest.json','icon-192.png','icon-512.png']))));self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));`;
  zip.file('index.html', html);
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('sw.js', sw);
  const toBuffer = (base64) => Buffer.from(base64.split(',')[1], 'base64');
  zip.file('icon-192.png', toBuffer(icon192));
  zip.file('icon-512.png', toBuffer(icon512));
  return await zip.generateAsync({ type: 'nodebuffer' });
}

// ========== MAIN ENDPOINT /build ==========
app.post('/build', async (req, res) => {
  try {
    const { name, url, icon } = req.body;
    if (!name || !url) {
      return res.status(400).json({ error: 'Nama dan URL wajib diisi' });
    }

    // 1. Siapkan icon
    let iconBase64 = icon;
    if (!iconBase64) {
      iconBase64 = await generateDefaultIcon(name);
    }
    const icon192 = await resizeIcon(iconBase64, 192);
    const icon512 = await resizeIcon(iconBase64, 512);

    // 2. Build manifest
    const manifest = {
      name,
      short_name: name,
      start_url: url,
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#1c1c2e',
      icons: [
        { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    };

    // 3. Kirim ke PWABuilder
    const payload = { manifest, platforms: ['android'] };
    const pwabuilderRes = await fetch('https://pwabuilder.com/api/apps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!pwabuilderRes.ok) {
      console.warn('PWABuilder error, fallback to PWA zip');
      const zipBuffer = await generatePWAZip(name, url, icon192, icon512);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name.toLowerCase().replace(/\s+/g, '-')}-pwa.zip"`);
      return res.send(zipBuffer);
    }

    const postData = await pwabuilderRes.json();
    const appId = postData.id;
    if (!appId) throw new Error('ID aplikasi tidak ditemukan');

    // 4. Polling status
    let status = 'pending';
    let attempts = 0;
    while (status !== 'completed' && status !== 'failed' && attempts < 45) {
      await new Promise(r => setTimeout(r, 3000));
      attempts++;
      const statusRes = await fetch(`https://pwabuilder.com/api/apps/${appId}/status`);
      if (!statusRes.ok) continue;
      const statusData = await statusRes.json();
      status = statusData.status || 'pending';
      if (status === 'completed') break;
      if (status === 'failed') throw new Error('Build gagal di PWABuilder');
    }

    if (status !== 'completed') throw new Error('Waktu build habis');

    // 5. Download APK
    const downloadRes = await fetch(`https://pwabuilder.com/api/apps/${appId}/download/android`);
    if (!downloadRes.ok) throw new Error(`Gagal download APK: ${downloadRes.status}`);

    const apkBuffer = await downloadRes.buffer();
    const fileName = `${name.toLowerCase().replace(/\s+/g, '-')}.apk`;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(apkBuffer);

  } catch (err) {
    console.error(err);
    // Fallback: kirim PWA ZIP
    try {
      const { name, url, icon } = req.body;
      let iconBase64 = icon || await generateDefaultIcon(name);
      const icon192 = await resizeIcon(iconBase64, 192);
      const icon512 = await resizeIcon(iconBase64, 512);
      const zipBuffer = await generatePWAZip(name, url, icon192, icon512);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name.toLowerCase().replace(/\s+/g, '-')}-pwa.zip"`);
      return res.send(zipBuffer);
    } catch (fallbackErr) {
      res.status(500).json({ error: err.message || 'Terjadi kesalahan' });
    }
  }
});

module.exports = app;
