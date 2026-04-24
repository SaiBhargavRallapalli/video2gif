# GIFforge — Video to GIF Converter

Upload a video, get a high-quality GIF back. Runs entirely on your own server.

## Features
- Drag & drop upload (MP4, MOV, WebM, AVI, MKV)
- Trim: set start time and duration
- Control width, FPS, and quality (palette-based optimisation)
- Streams GIF directly back to browser for instant download
- Rate limited (10 conversions/min per IP)

## Prerequisites
- Node.js 18+
- **ffmpeg** installed on the host:
  - Mac: `brew install ffmpeg`
  - Ubuntu/Debian: `apt install ffmpeg`
  - Cloud Run: use the provided Dockerfile (ffmpeg included)

## Run locally
```bash
npm install
npm start
# → http://localhost:8080
```

## Deploy to Cloud Run
```bash
gcloud run deploy gifforge \
  --source . \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300
```

## Environment Variables
| Variable | Default | Description |
|---|---|---|
| PORT | 8080 | Server port |
| MAX_FILE_MB | 200 | Max upload size in MB |
| MAX_DURATION | 120 | Max GIF duration in seconds |

## How it works
1. Video uploaded via multipart form to `/api/convert`
2. Server runs ffmpeg in two passes: palette generation → GIF encoding
3. GIF streamed back to client, temp files cleaned up immediately
