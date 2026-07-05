/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import { TranscriptionJob, TranscriptLine } from './src/types';
import { createServer as createViteServer } from 'vite';

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 7420;

// Ensure local directories exist
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const JOBS_FILE = path.join(process.cwd(), 'jobs.json');
const ENV_LOCAL_FILE = path.join(process.cwd(), '.env.local');

// Configure disk storage for Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, 'audio-' + uniqueSuffix + ext);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit (aligned with cloud reverse proxy limits)
  },
});

// JSON Helper functions
function readJobs(): TranscriptionJob[] {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const data = fs.readFileSync(JOBS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error reading jobs file:', err);
    // Preserve the corrupt file instead of silently losing job history on the next write.
    try {
      if (fs.existsSync(JOBS_FILE)) {
        fs.renameSync(JOBS_FILE, `${JOBS_FILE}.corrupted-${Date.now()}`);
      }
    } catch {}
  }
  return [];
}

function writeJobs(jobs: TranscriptionJob[]) {
  const tmpFile = `${JOBS_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(jobs, null, 2), 'utf-8');
    fs.renameSync(tmpFile, JOBS_FILE); // atomic replace on the same volume
  } catch (err) {
    console.error('Error writing jobs file:', err);
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Shows just enough of the key to confirm which one is configured, without exposing it.
function maskApiKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `••••••••${key.slice(-4)}`;
}

// Persists a new GEMINI_API_KEY into .env.local (preserving any other lines already there)
// and updates process.env immediately, so a running server picks up the change without a restart.
function saveGeminiApiKey(newKey: string) {
  let lines: string[] = [];
  if (fs.existsSync(ENV_LOCAL_FILE)) {
    lines = fs.readFileSync(ENV_LOCAL_FILE, 'utf-8').split('\n');
  }
  const keyLine = `GEMINI_API_KEY="${newKey}"`;
  const existingIndex = lines.findIndex(line => /^\s*GEMINI_API_KEY\s*=/.test(line));
  if (existingIndex !== -1) {
    lines[existingIndex] = keyLine;
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(keyLine);
  }
  fs.writeFileSync(ENV_LOCAL_FILE, lines.join('\n'), 'utf-8');
  process.env.GEMINI_API_KEY = newKey;
}

function updateJobStatus(jobId: string, updates: Partial<TranscriptionJob>) {
  const jobs = readJobs();
  const index = jobs.findIndex((j) => j.id === jobId);
  if (index !== -1) {
    jobs[index] = { ...jobs[index], ...updates };
    writeJobs(jobs);
  }
}

// Escapes text before it's interpolated into exported HTML/.doc output
function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Regex parser to convert Gemini transcription block back to speaker arrays
function parseTranscript(text: string): TranscriptLine[] {
  const lines = text.split('\n');
  const transcriptLines: TranscriptLine[] = [];
  let currentSpeaker = 'Person 1';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Matches "Person 1: Speech text" or "Srikanta: Speech text" or "Speaker Name: Speech text"
    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      currentSpeaker = match[1].trim();
      const speech = match[2].trim();
      transcriptLines.push({
        id: Math.random().toString(36).substring(2, 9),
        speaker: currentSpeaker,
        text: speech,
      });
    } else {
      // Append multi-line strings to the previous entry if possible
      if (transcriptLines.length > 0) {
        transcriptLines[transcriptLines.length - 1].text += ' ' + trimmed;
      } else {
        transcriptLines.push({
          id: Math.random().toString(36).substring(2, 9),
          speaker: currentSpeaker,
          text: trimmed,
        });
      }
    }
  }
  return transcriptLines;
}

// Gemini Files API keeps uploads for ~48h; reuse an existing upload up to 47h to leave margin.
const GEMINI_FILE_TTL_MS = 47 * 60 * 60 * 1000;

// Background transcription runner
async function transcribeAudioInBackground(
  jobId: string,
  filePath: string,
  mimeType: string,
  existingFile?: TranscriptionJob['geminiFile']
) {
  try {
    updateJobStatus(jobId, { status: 'transcribing', progress: 15 });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not configured. Please add your Gemini API Key in Settings > Secrets.'
      );
    }

    // Lazy initialization of SDK to prevent startup crashes if key is initially absent
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
        // A 2-3hr recording can take tens of minutes to upload and transcribe; a generous
        // timeout here also raises the SDK's underlying fetch timeout (avoids the default
        // ~5min network timeout killing a long-running call), and retryOptions gets us
        // backoff+retry on transient 429/5xx errors for free.
        timeout: 45 * 60 * 1000,
        retryOptions: { attempts: 4 },
      },
    });

    let fileRef = existingFile;
    const isFresh = fileRef && (Date.now() - new Date(fileRef.uploadedAt).getTime()) < GEMINI_FILE_TTL_MS;

    if (!fileRef || !isFresh) {
      updateJobStatus(jobId, { status: 'transcribing', progress: 30 });

      console.log(`[Job ${jobId}] Uploading file to Gemini File API: ${filePath}`);

      // Upload standard audio files via Files API
      const uploadResult = await ai.files.upload({
        file: filePath,
        config: {
          mimeType: mimeType,
        }
      });

      console.log(`[Job ${jobId}] Gemini File API Upload Success: ${uploadResult.name}`);

      fileRef = {
        name: uploadResult.name!,
        uri: uploadResult.uri!,
        mimeType: uploadResult.mimeType!,
        uploadedAt: new Date().toISOString(),
      };
      updateJobStatus(jobId, { status: 'transcribing', progress: 50, geminiFile: fileRef });
    } else {
      console.log(`[Job ${jobId}] Reusing existing Gemini file (uploaded ${fileRef.uploadedAt}), skipping re-upload.`);
      updateJobStatus(jobId, { status: 'transcribing', progress: 50 });
    }

    const promptText = `You are a professional audio transcriber. Transcribe the provided audio recording accurately with the following strict requirements:

1. Language Handling:
- Kannada speech must be transcribed strictly in Kannada script (ಕನ್ನಡ).
- English speech must be transcribed in English.
- Do not translate any part. Preserve the original spoken language exactly.
- If a sentence contains both Kannada and English, keep each word in its respective script. Use English words in between Kannada script if it is an English word (e.g. "meeting", "timeline", "project").

2. Speaker Labeling:
- Identify and label different speakers as:
  Person 1
  Person 2
  Person 3, etc.
- Maintain consistent speaker labels throughout the transcript.

3. Accuracy & Detail:
- Capture the transcript word-for-word, including fillers (e.g., "uh", "um", "like", "okay", etc.) if present.
- Preserve sentence structure, pauses, and natural speech patterns.

4. Formatting:
- Use the following format:
  Person 1: <speech>
  Person 2: <speech>
- Start a new line whenever the speaker changes.

5. Unclear Audio:
- If any part is unclear, mark it exactly as:
  - [inaudible] (if completely unclear)
  - [unclear: <best guess>] (if partially understandable, with your best guess inside)

6. No Extra Output:
- Do NOT summarize, interpret, or add any explanations, introductions, or notes.
- Only output the raw speaker-labeled transcription text starting immediately with the first speaker.`;

    console.log(`[Job ${jobId}] Submitting transcription request to gemini-3.5-flash...`);

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: createUserContent([
        createPartFromUri(fileRef.uri, fileRef.mimeType),
        promptText,
      ]),
      config: {
        // A verbatim, filler-inclusive transcript of a 2-3hr recording can be tens of
        // thousands of words; leave a generous ceiling so it isn't cut off mid-transcript.
        maxOutputTokens: 65536,
      },
    });

    updateJobStatus(jobId, { status: 'transcribing', progress: 90 });

    const finishReason = response.candidates?.[0]?.finishReason;
    const truncated = finishReason === 'MAX_TOKENS';
    if (truncated) {
      console.error(`[Job ${jobId}] Warning: response hit MAX_TOKENS — transcript may be incomplete.`);
    }

    const rawTranscript = response.text || '';
    const transcriptLines = parseTranscript(rawTranscript);

    // Promptly delete the file from Gemini cloud storage to keep user files private
    try {
      await ai.files.delete({ name: fileRef.name });
      console.log(`[Job ${jobId}] Cleaned up Gemini File API storage: ${fileRef.name}`);
    } catch (cleanupErr) {
      console.error(`[Job ${jobId}] Warning: Failed to clean up Gemini File API:`, cleanupErr);
    }

    updateJobStatus(jobId, {
      status: 'completed',
      progress: 100,
      rawTranscript,
      transcriptLines,
      completedAt: new Date().toISOString(),
      truncated,
    });
    console.log(`[Job ${jobId}] Transcription completed successfully.`);

  } catch (error: any) {
    console.error(`[Job ${jobId}] Background transcription failed:`, error);
    // Deliberately do not delete the Gemini file here: if upload succeeded but generation
    // failed, the file reference already persisted on the job (see above) lets /retry skip
    // re-uploading. It expires on its own via Gemini's ~48h Files API TTL if never retried.
    updateJobStatus(jobId, {
      status: 'failed',
      progress: 100,
      error: error.message || 'An unknown error occurred during Gemini transcription.',
      completedAt: new Date().toISOString(),
    });
  }
}

// ----------------------------------------------------
// REST API ROUTES
// ----------------------------------------------------

// A verbatim multi-hour transcript's JSON payload can exceed the 100kb default easily.
app.use(express.json({ limit: '25mb' }));

// Serve local audio uploads statically
app.use('/uploads', express.static(UPLOADS_DIR));

// Settings: check/update the Gemini API key without ever exposing the full value back to the client
app.get('/api/settings', (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  res.json({
    hasApiKey: !!key,
    maskedKey: key ? maskApiKey(key) : null,
  });
});

app.post('/api/settings', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'A non-empty API key is required.' });
  }
  try {
    saveGeminiApiKey(apiKey.trim());
    res.json({ hasApiKey: true, maskedKey: maskApiKey(apiKey.trim()) });
  } catch (err: any) {
    console.error('Failed to save API key:', err);
    res.status(500).json({ error: 'Failed to save API key.' });
  }
});

// 1. Get all jobs
app.get('/api/jobs', (req, res) => {
  res.json(readJobs());
});

// 2. Get specific job
app.get('/api/jobs/:id', (req, res) => {
  const jobs = readJobs();
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Transcription job not found.' });
  }
  res.json(job);
});

// 3. Upload file and initiate background transcription
app.post('/api/jobs/upload', upload.single('audio'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  // Create new transcription job
  const jobId = Date.now().toString();
  const jobs = readJobs();
  const newJob: TranscriptionJob = {
    id: jobId,
    fileName: file.originalname,
    fileSize: file.size,
    mimeType: file.mimetype,
    audioUrl: `/uploads/${file.filename}`,
    status: 'pending',
    progress: 5,
    createdAt: new Date().toISOString(),
    speakerMap: {},
  };

  jobs.push(newJob);
  writeJobs(jobs);

  // Trigger background job without awaiting to avoid browser request timeout
  transcribeAudioInBackground(jobId, file.path, file.mimetype);

  res.status(201).json(newJob);
});

// 3.5 Chunked upload for large files (to prevent 413 Request Entity Too Large error)
app.post('/api/jobs/upload-chunk', upload.single('chunk'), (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks, fileName, mimeType, fileSize } = req.body;
    const file = req.file;

    if (!uploadId || chunkIndex === undefined || !totalChunks || !fileName || !file) {
      return res.status(400).json({ error: 'Missing required chunked upload parameters or chunk file.' });
    }

    // uploadId is client-supplied and used to build filesystem paths below — sanitize it
    // the same way fileName already is, to prevent path traversal (e.g. uploadId="../../evil").
    const safeUploadId = String(uploadId).replace(/[^a-zA-Z0-9.-]/g, '_');

    const chunkIdx = parseInt(chunkIndex, 10);
    const totChunks = parseInt(totalChunks, 10);
    const totalSize = fileSize ? parseInt(fileSize, 10) : file.size;

    // Temporary folder for chunks: uploads/chunks-<uploadId>/
    const chunksDir = path.join(UPLOADS_DIR, `chunks-${safeUploadId}`);
    if (!fs.existsSync(chunksDir)) {
      fs.mkdirSync(chunksDir, { recursive: true });
    }

    // Move the uploaded chunk file to its correct index name inside chunksDir
    const chunkPath = path.join(chunksDir, `chunk-${chunkIdx}`);
    fs.renameSync(file.path, chunkPath);

    // Check if we have received all chunks
    const receivedChunks = fs.readdirSync(chunksDir).filter(name => name.startsWith('chunk-'));
    if (receivedChunks.length === totChunks) {
      // Reassemble the file synchronously to prevent race conditions or partial file locks
      const finalFileName = `${safeUploadId}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
      const finalPath = path.join(UPLOADS_DIR, finalFileName);

      // Remove any pre-existing file at the final path just in case
      if (fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
      }

      for (let i = 0; i < totChunks; i++) {
        const currentChunkPath = path.join(chunksDir, `chunk-${i}`);
        if (!fs.existsSync(currentChunkPath)) {
          return res.status(400).json({ error: `Missing chunk ${i} for assembly.` });
        }
        const data = fs.readFileSync(currentChunkPath);
        fs.appendFileSync(finalPath, data);
      }

      // Clean up the temporary chunks folder now that final assembly is complete and saved
      try {
        fs.rmSync(chunksDir, { recursive: true, force: true });
      } catch (rmErr) {
        console.error('Failed to clean up chunks directory:', rmErr);
      }

      // Reject the assembled file if it exceeds the same cap the frontend enforces —
      // nothing previously validated the reassembled total against fileSize/MAX_FILE_SIZE.
      const MAX_TOTAL_SIZE = 500 * 1024 * 1024;
      const assembledSize = fs.statSync(finalPath).size;
      if (assembledSize > MAX_TOTAL_SIZE) {
        fs.unlinkSync(finalPath);
        return res.status(400).json({
          error: `Assembled file (${assembledSize} bytes) exceeds the ${MAX_TOTAL_SIZE} byte limit.`,
        });
      }

      // Create new transcription job
      const jobId = safeUploadId;
      const jobs = readJobs();
      const newJob: TranscriptionJob = {
        id: jobId,
        fileName: fileName,
        fileSize: totalSize,
        mimeType: mimeType || 'audio/mpeg',
        audioUrl: `/uploads/${finalFileName}`,
        status: 'pending',
        progress: 5,
        createdAt: new Date().toISOString(),
        speakerMap: {},
      };

      jobs.push(newJob);
      writeJobs(jobs);

      // Trigger background job without awaiting to avoid browser request timeout
      transcribeAudioInBackground(jobId, finalPath, mimeType || 'audio/mpeg');

      return res.status(201).json(newJob);
    } else {
      // Return success for this chunk, letting the client know to send the next chunk
      return res.status(200).json({ 
        success: true, 
        message: `Chunk ${chunkIdx + 1}/${totChunks} received successfully.`,
        progress: Math.round(((chunkIdx + 1) / totChunks) * 100)
      });
    }
  } catch (err: any) {
    console.error('Error handling chunk upload:', err);
    return res.status(500).json({ error: `Chunk upload failed: ${err.message}` });
  }
});

// 4. Update transcript edits and speaker names
app.post('/api/jobs/:id/update', (req, res) => {
  const jobId = req.params.id;
  const { transcriptLines, speakerMap } = req.body;

  const jobs = readJobs();
  const index = jobs.findIndex((j) => j.id === jobId);
  if (index === -1) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const updates: Partial<TranscriptionJob> = {};
  if (transcriptLines) updates.transcriptLines = transcriptLines;
  if (speakerMap) updates.speakerMap = speakerMap;

  // Sync rawTranscript with manual edits
  if (transcriptLines) {
    const currentMap = speakerMap || jobs[index].speakerMap || {};
    updates.rawTranscript = transcriptLines
      .map((line: TranscriptLine) => {
        const displayName = currentMap[line.speaker] || line.speaker;
        return `${displayName}: ${line.text}`;
      })
      .join('\n');
  }

  jobs[index] = { ...jobs[index], ...updates };
  writeJobs(jobs);

  res.json(jobs[index]);
});

// 5. Delete specific job
app.delete('/api/jobs/:id', (req, res) => {
  const jobId = req.params.id;
  const jobs = readJobs();
  const index = jobs.findIndex((j) => j.id === jobId);
  if (index === -1) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const job = jobs[index];

  // Clean up physical file on disk
  if (job.audioUrl) {
    const filename = path.basename(job.audioUrl);
    const localFilePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(localFilePath)) {
      try {
        fs.unlinkSync(localFilePath);
        console.log(`Deleted local file: ${localFilePath}`);
      } catch (err) {
        console.error(`Error deleting local file ${localFilePath}:`, err);
      }
    }
  }

  jobs.splice(index, 1);
  writeJobs(jobs);
  res.json({ success: true });
});

// Retry a failed job
app.post('/api/jobs/:id/retry', (req, res) => {
  const jobId = req.params.id;
  const jobs = readJobs();
  const index = jobs.findIndex((j) => j.id === jobId);
  if (index === -1) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const job = jobs[index];
  if (!job.audioUrl) {
    return res.status(400).json({ error: 'No audio associated with this recording.' });
  }

  const filename = path.basename(job.audioUrl);
  const localFilePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(localFilePath)) {
    return res.status(400).json({ error: 'Source audio file not found on the server.' });
  }

  // Update status to pending and reset errors/transcripts
  job.status = 'pending';
  job.progress = 5;
  job.error = undefined;
  job.transcriptLines = undefined;

  writeJobs(jobs);

  // Restart backend background transcribing — reuse the prior Gemini file reference (if any
  // and still fresh) so a retry after a generation-side failure doesn't re-upload the whole file.
  transcribeAudioInBackground(job.id, localFilePath, job.mimeType || 'audio/mpeg', job.geminiFile);

  res.json(job);
});

// 6. Export document in desired format (TXT or MS Word .doc)
app.get('/api/jobs/:id/export/:format', (req, res) => {
  const jobId = req.params.id;
  const format = req.params.format;

  const jobs = readJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  if (job.status !== 'completed' || !job.transcriptLines) {
    return res.status(400).json({ error: 'Transcription is not yet complete.' });
  }

  const speakerMap = job.speakerMap || {};

  if (format === 'txt') {
    const textContent = job.transcriptLines
      .map((line) => {
        const speakerName = speakerMap[line.speaker] || line.speaker;
        return `${speakerName}: ${line.text}`;
      })
      .join('\n\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transcript-${jobId}.txt"`);
    return res.send(textContent);
  }

  if (format === 'doc') {
    const rowsHtml = job.transcriptLines
      .map((line) => {
        const speakerName = speakerMap[line.speaker] || line.speaker;
        return `
          <div class="line">
            <span class="speaker">${escapeHtml(speakerName)}:</span>
            <span class="text">${escapeHtml(line.text)}</span>
          </div>
        `;
      })
      .join('\n');

    const formattedDate = new Date(job.createdAt).toLocaleString();
    const htmlContent = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
      <title>Transcription Document</title>
      <!--[if gte mso 9]>
      <xml>
        <w:WordDocument>
          <w:View>Print</w:View>
          <w:Zoom>100</w:Zoom>
          <w:DoNotOptimizeForBrowser/>
        </w:WordDocument>
      </xml>
      <![endif]-->
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; padding: 40px; color: #111827; }
        h1 { color: #1e3a8a; font-size: 24px; border-bottom: 2px solid #1e3a8a; padding-bottom: 8px; margin-top: 0; }
        .meta-box { background-color: #f3f4f6; border-left: 4px solid #3b82f6; padding: 12px 16px; margin-bottom: 30px; font-size: 13px; color: #4b5563; }
        .meta-item { margin-bottom: 4px; }
        .meta-label { font-weight: bold; }
        .line { margin-bottom: 16px; font-size: 14px; }
        .speaker { font-weight: bold; color: #1e40af; min-width: 100px; display: inline-block; }
        .text { margin-left: 8px; color: #111827; }
      </style>
      </head>
      <body>
        <h1>Audio Transcription Report</h1>
        <div class="meta-box">
          <div class="meta-item"><span class="meta-label">Original File Name:</span> ${escapeHtml(job.fileName)}</div>
          <div class="meta-item"><span class="meta-label">Transcription Date:</span> ${formattedDate}</div>
          <div class="meta-item"><span class="meta-label">Languages Spoken:</span> Kannada (ಕನ್ನಡ) & English (Original Scripts)</div>
        </div>
        <div class="transcript-content">
          ${rowsHtml}
        </div>
      </body>
      </html>
    `;

    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transcript-${jobId}.doc"`);
    return res.send(htmlContent);
  }

  res.status(400).json({ error: 'Unsupported export format.' });
});

// Global error handler middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Express global error handler:', err);
  res.status(err.status || err.statusCode || 500).json({
    error: err.message || 'An internal server error occurred during processing.'
  });
});

// ----------------------------------------------------
// VITE DEV SERVER OR STATIC ASSETS ROUTING
// ----------------------------------------------------

// If the process was restarted (crash, dev-server reload, sleep) while a job was mid-flight,
// its status/progress would otherwise stay frozen forever with no Retry affordance in the UI
// (which only shows Retry for 'failed' jobs). Mark them failed so the existing Retry flow
// picks them up — and thanks to the persisted geminiFile reference, retrying skips re-upload
// if the audio had already made it to Gemini.
function markInterruptedJobsFailed() {
  const jobs = readJobs();
  let changed = false;
  for (const job of jobs) {
    if (job.status === 'pending' || job.status === 'transcribing') {
      job.status = 'failed';
      job.error = 'Interrupted by server restart. Click Retry to resume.';
      job.completedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeJobs(jobs);
}

async function startServer() {
  markInterruptedJobsFailed();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
