/**
 * @fileoverview GIF Converter — Express backend
 * @description Upload a video, get an optimised GIF back.
 *   Uses ffmpeg (must be installed on the host) for conversion.
 *   Supports trim, fps, width, and quality controls.
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

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1kb' }));

const limiter = rateLimit({
  windowMs: 60_000, max: 10,
  message: { error: 'Too many requests. Please wait a minute.' },
});

// ── Upload config ─────────────────────────────────────────────────────────────
const ACCEPTED_MIME = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo',
  'video/webm', 'video/x-matroska', 'video/mpeg',
]);

const MAX_FILE_MB  = parseInt(process.env.MAX_FILE_MB  || '200', 10);
const MAX_DURATION = parseInt(process.env.MAX_DURATION || '120', 10); // seconds

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase() || '.mp4';
      const name = `upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
      cb(null, name);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ACCEPTED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Cleans up a file silently (ignores errors).
 * @param {string} filePath
 */
function cleanup(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  catch (_) { /* ignore */ }
}

/**
 * Returns the duration of a video file in seconds using ffprobe.
 * @param {string} inputPath
 * @returns {Promise<number>}
 */
function getVideoDuration(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', inputPath,
    ];
    const proc = spawn('ffprobe', args);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const json = JSON.parse(out);
        const dur  = parseFloat(json.streams?.[0]?.duration || '0');
        resolve(isFinite(dur) ? dur : 0);
      } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
}

/**
 * Converts a video file to an optimised GIF using ffmpeg with palette generation.
 * @param {object} opts
 * @param {string} opts.input      - Input video path
 * @param {string} opts.output     - Output GIF path
 * @param {number} opts.startTime  - Start time in seconds
 * @param {number} opts.duration   - Duration to convert in seconds
 * @param {number} opts.fps        - Frames per second (1–15)
 * @param {number} opts.width      - Output width in pixels (100–1200)
 * @param {number} opts.quality    - Palette colours: low=64, med=128, high=256
 * @returns {Promise<void>}
 */
function convertToGif({ input, output, startTime, duration, fps, width, quality }) {
  return new Promise((resolve, reject) => {
    const paletteFile = output.replace('.gif', '_palette.png');

    // Step 1 — generate palette
    const paletteArgs = [
      '-y',
      '-ss', String(startTime),
      '-t',  String(duration),
      '-i',  input,
      '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=max_colors=${quality}`,
      paletteFile,
    ];

    const p1 = spawn('ffmpeg', paletteArgs);
    p1.on('close', code1 => {
      if (code1 !== 0) return reject(new Error('Palette generation failed'));

      // Step 2 — apply palette to generate GIF
      const gifArgs = [
        '-y',
        '-ss', String(startTime),
        '-t',  String(duration),
        '-i',  input,
        '-i',  paletteFile,
        '-filter_complex', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`,
        '-loop', '0',
        output,
      ];

      const p2 = spawn('ffmpeg', gifArgs);
      let stderr = '';
      p2.stderr.on('data', d => { stderr += d; });
      p2.on('close', code2 => {
        cleanup(paletteFile);
        if (code2 !== 0) return reject(new Error(`GIF conversion failed:\n${stderr.slice(-500)}`));
        resolve();
      });
      p2.on('error', e => { cleanup(paletteFile); reject(e); });
    });
    p1.on('error', reject);
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** Health check */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', maxFileMB: MAX_FILE_MB, maxDuration: MAX_DURATION });
});

/**
 * POST /api/convert
 * Multipart form fields:
 *   file       — video file (required)
 *   startTime  — seconds (default 0)
 *   duration   — seconds to convert, max MAX_DURATION (default 15)
 *   fps        — 1–15 (default 10)
 *   width      — 100–1200 pixels (default 800)
 *   quality    — low | medium | high (default medium)
 */
app.post('/api/convert', limiter, upload.single('file'), async (req, res) => {
  const inputPath  = req.file?.path;
  const outputPath = inputPath ? inputPath.replace(path.extname(inputPath), '.gif') : null;

  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    // Parse and clamp options
    const startTime = Math.max(0, parseFloat(req.body.startTime) || 0);
    const rawDur    = Math.min(MAX_DURATION, Math.max(1, parseFloat(req.body.duration) || 15));
    const fps       = Math.min(15, Math.max(1, parseInt(req.body.fps, 10) || 10));
    const width     = Math.min(1200, Math.max(100, parseInt(req.body.width, 10) || 800));
    const qualityMap = { low: 64, medium: 128, high: 256 };
    const quality   = qualityMap[req.body.quality] ?? 128;

    // Validate against actual video duration
    const videoDur = await getVideoDuration(inputPath);
    if (videoDur > 0 && startTime >= videoDur) {
      return res.status(400).json({ error: `Start time (${startTime}s) exceeds video length (${videoDur.toFixed(1)}s).` });
    }
    const duration = videoDur > 0
      ? Math.min(rawDur, videoDur - startTime)
      : rawDur;

    // Convert
    await convertToGif({ input: inputPath, output: outputPath, startTime, duration, fps, width, quality });

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'GIF file was not created.' });
    }

    const stat    = fs.statSync(outputPath);
    const sizeMB  = (stat.size / 1_048_576).toFixed(2);

    // Stream GIF back to client
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', 'attachment; filename="output.gif"');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-GIF-Size-MB', sizeMB);
    res.setHeader('X-GIF-Duration', duration.toFixed(1));

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => { cleanup(inputPath); cleanup(outputPath); });
    stream.on('error', () => { cleanup(inputPath); cleanup(outputPath); });

  } catch (err) {
    cleanup(inputPath);
    cleanup(outputPath);
    console.error('Conversion error:', err.message);
    res.status(500).json({ error: err.message || 'Conversion failed.' });
  }
});

// ── Static & Error Handler ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Max ${MAX_FILE_MB}MB.` });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`GIF Converter on http://localhost:${PORT}`);
  console.log(`Max upload: ${MAX_FILE_MB}MB | Max duration: ${MAX_DURATION}s`);
});
