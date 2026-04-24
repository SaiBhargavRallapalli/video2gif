/**
 * @fileoverview GIF Converter — Express backend
 * @description Upload a video, get an optimised GIF back.
 */

'use strict';

const express   = require('express');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { spawn } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Security & Proxy Configuration ────────────────────────────────────────────
// Trust the Render proxy so Express identifies the correct client IP
app.set('trust proxy', 1); 

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1kb' }));

const limiter = rateLimit({
  windowMs: 60_000, 
  max: 10,
  message: { error: 'Too many requests. Please wait a minute.' },
});

// ── Upload config ─────────────────────────────────────────────────────────────
const ACCEPTED_MIME = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo',
  'video/webm', 'video/x-matroska', 'video/mpeg',
]);

const MAX_FILE_MB  = parseInt(process.env.MAX_FILE_MB  || '200', 10);
const MAX_DURATION = parseInt(process.env.MAX_DURATION || '120', 10);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ACCEPTED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type.'));
  }
});

// ── Cleanup Helper ────────────────────────────────────────────────────────────
const cleanup = (filePath) => {
  if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
};

// ── Conversion Logic ──────────────────────────────────────────────────────────
app.post('/api/convert', limiter, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided.' });

  const inputPath = req.file.path;
  const outputPath = path.join(os.tmpdir(), `gif-${Date.now()}.gif`);
  const palettePath = path.join(os.tmpdir(), `palette-${Date.now()}.png`);

  const { start = 0, duration = 5, fps = 10, width = 480, quality = 2 } = req.body;

  try {
    // 1. Generate Palette
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-ss', start, '-t', duration, '-i', inputPath,
        '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen`,
        '-y', palettePath
      ]);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('Palette gen failed')));
    });

    // 2. Encode GIF
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-ss', start, '-t', duration, '-i', inputPath,
        '-i', palettePath,
        '-lavfi', `fps=${fps},scale=${width}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=${quality}`,
        '-y', outputPath
      ]);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('Encoding failed')));
    });

    const stat = fs.statSync(outputPath);
    const sizeMB = (stat.size / 1_048_576).toFixed(2);

    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', 'attachment; filename="output.gif"');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-GIF-Size-MB', sizeMB);
    res.setHeader('X-GIF-Duration', duration);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => { cleanup(inputPath); cleanup(outputPath); cleanup(palettePath); });
    stream.on('error', () => { cleanup(inputPath); cleanup(outputPath); cleanup(palettePath); });

  } catch (err) {
    cleanup(inputPath);
    cleanup(outputPath);
    cleanup(palettePath);
    console.error('Conversion error:', err.message);
    res.status(500).json({ error: err.message || 'Conversion failed.' });
  }
});

// ── Static & Error Handler ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Max ${MAX_FILE_MB}MB.` });
  }
  res.status(500).json({ error: err.message || 'Server error.' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
