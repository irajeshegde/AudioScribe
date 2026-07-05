/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FileAudio,
  Volume2,
  Download,
  Edit2,
  Trash2,
  Plus,
  RefreshCw,
  FileText,
  Check,
  AlertCircle,
  Sparkles,
  Play,
  Pause,
  Copy,
  Save,
  X,
  Search,
  Settings,
  Info,
  Calendar,
  Layers,
  ArrowRight,
  Moon,
  Sun,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { TranscriptionJob, TranscriptLine } from './types';

// Shared speaker color assignment, used by both the Speaker Customizer and the transcript
// line renderer so the same speaker index always maps to the same color in both places.
const SPEAKER_COLORS = [
  { bg: 'bg-purple-100', text: 'text-purple-700', short: 'P1' },
  { bg: 'bg-amber-100', text: 'text-amber-700', short: 'P2' },
  { bg: 'bg-teal-100', text: 'text-teal-700', short: 'P3' },
  { bg: 'bg-blue-100', text: 'text-blue-700', short: 'P4' },
  { bg: 'bg-rose-100', text: 'text-rose-700', short: 'P5' },
];

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function sortJobsNewestFirst(jobs: TranscriptionJob[]): TranscriptionJob[] {
  return [...jobs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function mergePolledJobs(previousJobs: TranscriptionJob[], incomingJobs: TranscriptionJob[]): TranscriptionJob[] {
  const previousById = new Map(previousJobs.map(job => [job.id, job]));

  return sortJobsNewestFirst(incomingJobs.map(incomingJob => {
    const previousJob = previousById.get(incomingJob.id);
    if (!previousJob) return incomingJob;

    const wouldRewindCompleted = previousJob.status === 'completed' && incomingJob.status !== 'completed';
    const wouldRewindActive = previousJob.status === 'transcribing' && incomingJob.status === 'pending';
    if (wouldRewindCompleted || wouldRewindActive) {
      return {
        ...incomingJob,
        status: previousJob.status,
        progress: Math.max(previousJob.progress, incomingJob.progress),
        error: previousJob.error,
        transcriptLines: previousJob.transcriptLines,
        rawTranscript: previousJob.rawTranscript,
        completedAt: previousJob.completedAt,
      };
    }

    if (incomingJob.status === previousJob.status && incomingJob.status !== 'failed') {
      return {
        ...incomingJob,
        progress: Math.max(previousJob.progress, incomingJob.progress),
      };
    }

    return incomingJob;
  }));
}

// Retries a chunk upload on likely-transient failures (network errors, 5xx). Doesn't retry
// 4xx — retrying a bad request won't help. FormData built from a Blob slice is safely
// re-readable across attempts, so the same instance can be reused.
async function uploadChunkWithRetry(formData: FormData, maxAttempts = 4): Promise<Response> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch('/api/jobs/upload-chunk', { method: 'POST', body: formData });
      if (response.ok || response.status < 500) return response;
      lastErr = new Error(`Server Error (${response.status})`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // linear backoff: 1s, 2s, 3s
    }
  }
  throw lastErr;
}

export default function App() {
  const [jobs, setJobs] = useState<TranscriptionJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  
  // Inline editing states
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editingLineText, setEditingLineText] = useState<string>('');
  const [editingSpeakerKey, setEditingSpeakerKey] = useState<string | null>(null);
  const [editingSpeakerValue, setEditingSpeakerValue] = useState<string>('');
  const [isSpeakerCustomizerCollapsed, setIsSpeakerCustomizerCollapsed] = useState<boolean>(false);
  
  // Feedback states
  const [copyFeedback, setCopyFeedback] = useState<boolean>(false);
  const [saveFeedback, setSaveFeedback] = useState<{ message: string; isError: boolean } | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  // Settings panel (Gemini API key management)
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<{ hasApiKey: boolean; maskedKey: string | null }>({ hasApiKey: false, maskedKey: null });
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [isSavingApiKey, setIsSavingApiKey] = useState<boolean>(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    const savedTheme = window.localStorage.getItem('audioscribe-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioPlayerRef = useRef<HTMLAudioElement>(null);
  const selectedJobIdRef = useRef<string | null>(selectedJobId);
  const jobsRequestSeqRef = useRef(0);

  useEffect(() => {
    selectedJobIdRef.current = selectedJobId;
  }, [selectedJobId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('audioscribe-theme', theme);
  }, [theme]);

  const fetchApiKeyStatus = async () => {
    try {
      const response = await fetch('/api/settings');
      if (response.ok) {
        setApiKeyStatus(await response.json());
      }
    } catch (err) {
      console.error('Failed to fetch API key status:', err);
    }
  };

  useEffect(() => {
    fetchApiKeyStatus();
  }, []);

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    setIsSavingApiKey(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });
      if (response.ok) {
        setApiKeyStatus(await response.json());
        setApiKeyInput('');
        showToast('Gemini API key saved.');
      } else {
        const errData = await response.json().catch(() => ({}));
        showToast(errData.error || 'Failed to save API key.', true);
      }
    } catch (err) {
      console.error('Failed to save API key:', err);
      showToast('Failed to save API key (connection error).', true);
    } finally {
      setIsSavingApiKey(false);
    }
  };

  // Fetch all jobs on component mount
  const fetchJobs = useCallback(async (silent = false) => {
    const requestId = ++jobsRequestSeqRef.current;

    try {
      const response = await fetch('/api/jobs');
      if (requestId !== jobsRequestSeqRef.current) return;

      if (response.ok) {
        const data = await response.json();
        const sortedJobs = sortJobsNewestFirst(data);
        setJobs(previousJobs => mergePolledJobs(previousJobs, sortedJobs));

        // Auto-select the first job if none is selected
        if (sortedJobs.length > 0 && !selectedJobIdRef.current) {
          setSelectedJobId(sortedJobs[0].id);
        }
      } else if (!silent) {
        showToast('Failed to refresh recordings list.', true);
      }
    } catch (err) {
      if (requestId !== jobsRequestSeqRef.current) return;

      console.error('Failed to fetch transcription jobs:', err);
      if (!silent) showToast('Failed to refresh recordings list (connection error).', true);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Poll for active jobs (status === pending or transcribing). Keyed off the set of active
  // job IDs (not the whole `jobs` array) so the interval isn't torn down and rebuilt on every
  // tick just because fetchJobs() produces a new array reference each time.
  const activeJobsKey = jobs
    .filter(job => job.status === 'pending' || job.status === 'transcribing')
    .map(job => job.id)
    .join(',');

  useEffect(() => {
    if (!activeJobsKey) return;

    // Silent: transient polling failures during a long transcription shouldn't spam toasts.
    const interval = setInterval(() => {
      fetchJobs(true);
    }, 3000); // Poll every 3 seconds

    return () => clearInterval(interval);
  }, [activeJobsKey, fetchJobs]);

  // Real elapsed-time tick, so a long transcription shows honest wall-clock progress instead
  // of a spinner with no signal to distinguish "still working" from "hung."
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    if (!activeJobsKey) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [activeJobsKey]);

  const activeJob = jobs.find(job => job.id === selectedJobId) || null;

  // Handle Drag & Drop uploading
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      uploadFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      uploadFile(e.target.files[0]);
    }
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  // Upload file function
  const uploadFile = async (file: File) => {
    // Basic verification of audio type
    if (!file.type.startsWith('audio/') && !file.name.endsWith('.mp3') && !file.name.endsWith('.wav') && !file.name.endsWith('.m4a') && !file.name.endsWith('.aac') && !file.name.endsWith('.ogg')) {
      setUploadError('Please select a valid audio file (MP3, WAV, M4A, etc.).');
      return;
    }

    // Client-side file size verification (500MB limit aligned with UI expectations)
    const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
    if (file.size > MAX_FILE_SIZE) {
      setUploadError(`File is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). The maximum allowed file size is 500MB. Please upload a smaller file.`);
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setUploadError(null);

    // If file is smaller than 5MB, we can do a simple single-request upload
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
    if (file.size <= CHUNK_SIZE) {
      const formData = new FormData();
      formData.append('audio', file);

      try {
        setUploadProgress(30);
        const response = await fetch('/api/jobs/upload', {
          method: 'POST',
          body: formData,
        });

        setUploadProgress(80);
        const contentType = response.headers.get('content-type');
        const isJson = contentType && contentType.includes('application/json');

        if (response.ok) {
          if (isJson) {
            const newJob = await response.json();
            setJobs(prev => [newJob, ...prev]);
            setSelectedJobId(newJob.id);
          } else {
            setUploadError('Server returned an invalid response format.');
          }
          setIsUploading(false);
          setUploadProgress(100);
        } else {
          if (isJson) {
            const errData = await response.json();
            setUploadError(errData.error || `Failed to upload audio file (Status: ${response.status}).`);
          } else {
            const errText = await response.text();
            const cleanErrText = errText.length > 150 ? errText.substring(0, 150) + '...' : errText;
            setUploadError(`Server Error (${response.status}): ${cleanErrText || 'No detailed message provided.'}`);
          }
          setIsUploading(false);
        }
      } catch (err: any) {
        console.error('Upload failed:', err);
        setUploadError(`Upload failed: ${err.message || 'Network error or connection refused.'}`);
        setIsUploading(false);
      }
      return;
    }

    // Otherwise, perform a chunked upload!
    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const uploadId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const formData = new FormData();
        formData.append('chunk', chunk, `${file.name}.part${chunkIndex}`);
        formData.append('uploadId', uploadId);
        formData.append('chunkIndex', chunkIndex.toString());
        formData.append('totalChunks', totalChunks.toString());
        formData.append('fileName', file.name);
        formData.append('fileSize', file.size.toString());
        formData.append('mimeType', file.type || 'audio/mpeg');

        const response = await uploadChunkWithRetry(formData);

        if (!response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const errData = await response.json();
            throw new Error(errData.error || `Failed to upload chunk ${chunkIndex + 1}/${totalChunks}.`);
          } else {
            const errText = await response.text();
            const cleanErrText = errText.length > 100 ? errText.substring(0, 100) + '...' : errText;
            throw new Error(`Server Error (${response.status}) on chunk ${chunkIndex + 1}: ${cleanErrText}`);
          }
        }

        // Update progress dynamically based on completed chunks
        const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
        setUploadProgress(progress);

        // If it was the last chunk, the server returns the complete job object
        if (chunkIndex === totalChunks - 1) {
          const result = await response.json();
          setJobs(prev => [result, ...prev]);
          setSelectedJobId(result.id);
          setIsUploading(false);
        }
      }
    } catch (err: any) {
      console.error('Chunked upload failed:', err);
      setUploadError(`Upload failed: ${err.message || 'Connection lost during chunk upload.'}`);
      setIsUploading(false);
    }
  };

  // Delete transcription job
  const handleDeleteJob = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent choosing as active job
    
    if (confirmingDeleteId !== jobId) {
      setConfirmingDeleteId(jobId);
      // Auto-reset after 4 seconds if they don't click again
      setTimeout(() => {
        setConfirmingDeleteId(prev => prev === jobId ? null : prev);
      }, 4000);
      return;
    }

    setConfirmingDeleteId(null);

    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        const remainingJobs = jobs.filter(j => j.id !== jobId);
        setJobs(remainingJobs);
        if (selectedJobId === jobId) {
          setSelectedJobId(remainingJobs.length > 0 ? remainingJobs[0].id : null);
        }
        showToast('Recording deleted successfully.');
      } else {
        const errData = await response.json().catch(() => ({}));
        showToast(errData.error || 'Failed to delete recording.', true);
      }
    } catch (err) {
      console.error('Failed to delete job:', err);
      showToast('Failed to delete recording (connection error).', true);
    }
  };

  // Retry transcription job
  const handleRetryJob = async (jobId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    
    // Optimistically update the UI to pending
    setJobs(prev => prev.map(j => {
      if (j.id === jobId) {
        return { ...j, status: 'pending', progress: 5, error: undefined };
      }
      return j;
    }));

    try {
      const response = await fetch(`/api/jobs/${jobId}/retry`, {
        method: 'POST',
      });

      if (response.ok) {
        const updatedJob = await response.json();
        setJobs(prev => prev.map(j => j.id === jobId ? updatedJob : j));
        showToast('Transcription retry started!');
      } else {
        const errData = await response.json();
        setJobs(prev => prev.map(j => {
          if (j.id === jobId) {
            return { ...j, status: 'failed', error: errData.error || 'Failed to trigger retry.' };
          }
          return j;
        }));
        showToast('Failed to start retry.', true);
      }
    } catch (err: any) {
      console.error('Retry failed:', err);
      setJobs(prev => prev.map(j => {
        if (j.id === jobId) {
          return { ...j, status: 'failed', error: err.message || 'Connection error.' };
        }
        return j;
      }));
      showToast('Connection failed.', true);
    }
  };

  // Extract unique speakers from transcript lines
  const getUniqueSpeakers = (job: TranscriptionJob): string[] => {
    if (!job.transcriptLines) return [];
    const speakers = new Set<string>();
    job.transcriptLines.forEach(line => {
      speakers.add(line.speaker);
    });
    return Array.from(speakers);
  };

  // Rename a speaker across the transcript
  const handleUpdateSpeakerName = async (speakerKey: string, newName: string) => {
    if (!activeJob) return;

    const updatedSpeakerMap = {
      ...(activeJob.speakerMap || {}),
      [speakerKey]: newName.trim(),
    };

    try {
      const response = await fetch(`/api/jobs/${activeJob.id}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          speakerMap: updatedSpeakerMap,
        }),
      });

      if (response.ok) {
        const updatedJob = await response.json();
        setJobs(prev => prev.map(j => j.id === activeJob.id ? updatedJob : j));
        setEditingSpeakerKey(null);
        showToast('Speaker names updated!');
      } else {
        const errData = await response.json().catch(() => ({}));
        showToast(errData.error || 'Failed to update speaker name.', true);
      }
    } catch (err) {
      console.error('Failed to update speaker name:', err);
      showToast('Failed to update speaker name (connection error).', true);
    }
  };

  // Edit in-line text line content
  const handleSaveLineText = async (lineId: string) => {
    if (!activeJob || !activeJob.transcriptLines) return;

    const updatedLines = activeJob.transcriptLines.map(line => {
      if (line.id === lineId) {
        return { ...line, text: editingLineText };
      }
      return line;
    });

    try {
      const response = await fetch(`/api/jobs/${activeJob.id}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transcriptLines: updatedLines,
        }),
      });

      if (response.ok) {
        const updatedJob = await response.json();
        setJobs(prev => prev.map(j => j.id === activeJob.id ? updatedJob : j));
        setEditingLineId(null);
        showToast('Transcript line saved!');
      } else {
        const errData = await response.json().catch(() => ({}));
        showToast(errData.error || 'Failed to save transcript line.', true);
      }
    } catch (err) {
      console.error('Failed to save line edits:', err);
      showToast('Failed to save transcript line (connection error).', true);
    }
  };

  // Helper toast notification
  const showToast = (message: string, isError = false) => {
    setSaveFeedback({ message, isError });
    setTimeout(() => {
      setSaveFeedback(null);
    }, 3000);
  };

  // Copy transcript text to clipboard
  const handleCopyToClipboard = () => {
    if (!activeJob || !activeJob.transcriptLines) return;

    const map = activeJob.speakerMap || {};
    const textToCopy = activeJob.transcriptLines
      .map(line => {
        const speakerName = map[line.speaker] || line.speaker;
        return `${speakerName}: ${line.text}`;
      })
      .join('\n\n');

    navigator.clipboard.writeText(textToCopy);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  // File size formatter
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Filter lines based on search query
  const filteredLines = activeJob?.transcriptLines?.filter(line => {
    if (!searchQuery) return true;
    const speakerName = (activeJob.speakerMap?.[line.speaker] || line.speaker).toLowerCase();
    const lineText = line.text.toLowerCase();
    const query = searchQuery.toLowerCase();
    return speakerName.includes(query) || lineText.includes(query);
  }) || [];

  return (
    <div id="app-root" data-theme={theme} className={`theme-${theme} min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans flex flex-col antialiased`}>
      {/* HEADER BAR */}
      <header id="app-header" className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4 sm:px-8 shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-black rounded flex items-center justify-center">
            <div className="w-4 h-1 bg-white rounded-full"></div>
          </div>
          <span className="font-semibold text-lg tracking-tight">
            AudioScribe
          </span>
          <span className="hidden md:inline-block text-xs text-gray-400 font-medium border-l border-gray-200 pl-3">
            Bilingual Kannada & English Transcriber
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}
            title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            className="p-2 rounded-lg text-gray-400 hover:text-black hover:bg-gray-100 transition cursor-pointer"
          >
            {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </button>
          <button
            onClick={() => setIsSettingsOpen(true)}
            title="Settings"
            className="p-2 rounded-lg text-gray-400 hover:text-black hover:bg-gray-100 transition cursor-pointer"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* TOAST FEEDBACK */}
      {saveFeedback && (
        <div className="fixed bottom-5 right-5 z-50 bg-black text-white px-4 py-3 rounded-lg shadow-lg flex items-center space-x-2">
          {saveFeedback.isError ? (
            <AlertCircle className="w-4 h-4 text-red-400" />
          ) : (
            <Check className="w-4 h-4 text-emerald-400" />
          )}
          <span className="text-sm font-semibold">{saveFeedback.message}</span>
        </div>
      )}

      {/* SETTINGS MODAL */}
      {isSettingsOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="bg-white rounded-xl border border-gray-200 shadow-lg w-full max-w-md p-6 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wider">Settings</h2>
              <button
                onClick={() => setIsSettingsOpen(false)}
                title="Close settings"
                className="p-1 rounded text-gray-400 hover:text-black hover:bg-gray-100 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <label className="text-[10px] uppercase tracking-widest text-gray-400 font-bold block mb-1.5">
              Gemini API Key
            </label>
            <p className="text-xs text-gray-500 mb-3">
              {apiKeyStatus.hasApiKey
                ? `Currently configured (${apiKeyStatus.maskedKey}). Enter a new key below to replace it.`
                : 'No API key configured yet. Transcription will fail until one is set.'}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Enter Gemini API key"
                className="flex-1 text-xs border border-gray-300 rounded-lg px-3 py-2 bg-gray-50 focus:outline-hidden focus:ring-1 focus:ring-black focus:bg-white"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveApiKey();
                }}
              />
              <button
                onClick={handleSaveApiKey}
                disabled={isSavingApiKey || !apiKeyInput.trim()}
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-white bg-black rounded-lg hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSavingApiKey ? 'Saving...' : 'Save'}
              </button>
            </div>
            <p className="text-[10px] text-gray-400 mt-3">
              Get a key at Google AI Studio. Saved directly to .env.local on this machine — never sent anywhere else.
            </p>
          </div>
        </div>
      )}

      {/* MAIN TWO-COLUMN DASHBOARD */}
      <main className="flex-1 w-full px-4 sm:px-6 lg:px-8 py-8 flex flex-col lg:flex-row gap-8">
        
        {/* LEFT COLUMN: SIDEBAR */}
        <aside className="w-full lg:w-80 shrink-0 flex flex-col">
          
          {/* HIDDEN NATIVE FILE INPUT */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="audio/*"
            className="hidden"
          />

          {/* JOBS LIST / HISTORY */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 flex-1 flex flex-col min-h-[450px]">
            <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-3 shrink-0">
              <label className="text-[10px] uppercase tracking-widest text-gray-400 font-bold block text-left">
                Recordings ({jobs.length})
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={triggerFileSelect}
                  title="Upload New Recording"
                  className="px-2.5 py-1.5 rounded-lg text-white bg-black hover:opacity-90 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New</span>
                </button>
                <button
                  onClick={() => fetchJobs()}
                  title="Refresh jobs history list"
                  className="p-1.5 rounded-lg text-gray-400 hover:text-black hover:bg-gray-100 transition cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* INLINE UPLOAD ERROR (shown right above history when uploading fails) */}
            {uploadError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-xl flex items-start space-x-2 text-left relative shrink-0">
                <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0 pr-4">
                  <span className="text-xs text-red-700 font-semibold leading-relaxed block break-words">{uploadError}</span>
                </div>
                <button 
                  onClick={() => setUploadError(null)}
                  className="text-red-400 hover:text-red-700 absolute top-2 right-2 p-0.5"
                  title="Clear error"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* INLINE UPLOADING PROGRESS BAR (shown right above history when uploading) */}
            {isUploading && (
              <div className="mb-4 p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-left shrink-0">
                <div className="flex items-center justify-between mb-2 text-[10px] font-bold text-gray-700 uppercase tracking-wider">
                  <span className="flex items-center space-x-1.5 text-black">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    <span>Uploading file...</span>
                  </span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full bg-gray-200 h-1 rounded-full overflow-hidden">
                  <div
                    className="bg-black h-1 rounded-full transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  ></div>
                </div>
              </div>
            )}

            {jobs.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border border-dashed border-gray-150 rounded-xl">
                <Volume2 className="w-6 h-6 text-gray-300 mb-2" />
                <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">No files uploaded</p>
                <p className="text-[10px] text-gray-400 mt-1">Transcriptions will appear here once processed.</p>
              </div>
            ) : (
              <div className="space-y-2 overflow-y-auto max-h-[500px] pr-1 flex-1">
                {jobs.map((job) => {
                  const isSelected = job.id === selectedJobId;
                  return (
                    <div
                      key={job.id}
                      onClick={() => setSelectedJobId(job.id)}
                      className={`job-card p-3 rounded-lg border transition text-left flex flex-col space-y-1.5 relative group cursor-pointer ${
                        isSelected
                          ? 'border-black bg-gray-50/50'
                          : 'border-gray-200 hover:border-black hover:bg-gray-50/20'
                      }`}
                    >
                      {/* Name & Trash can */}
                      <div className="flex items-start justify-between">
                        <div className="flex items-center space-x-2 min-w-0 pr-6">
                          <FileAudio className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-black font-bold' : 'text-gray-400'}`} />
                          <h3 className="text-xs font-semibold text-gray-900 truncate" title={job.fileName}>
                            {job.fileName}
                          </h3>
                        </div>
                        {confirmingDeleteId === job.id ? (
                          <div className="job-delete-confirm flex items-center space-x-1 absolute top-2 right-2 z-10 bg-white p-0.5 rounded border border-gray-200 shadow-xs">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmingDeleteId(null);
                              }}
                              className="px-1.5 py-0.5 text-[9px] font-bold uppercase text-gray-500 hover:text-black hover:bg-gray-100 rounded transition cursor-pointer"
                            >
                              No
                            </button>
                            <button
                              onClick={(e) => handleDeleteJob(job.id, e)}
                              className="job-delete-confirm-button px-1.5 py-0.5 text-[9px] font-bold uppercase text-white bg-red-600 hover:bg-red-700 rounded transition cursor-pointer flex items-center"
                            >
                              Delete
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => handleDeleteJob(job.id, e)}
                            title="Delete transcription"
                            className="job-delete-button opacity-0 group-hover:opacity-100 p-1 rounded text-gray-400 hover:text-red-600 hover:bg-gray-100 transition absolute top-2 right-2 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Status metrics */}
                      <div className="job-card-meta flex items-center justify-between text-[10px] text-gray-400 font-medium">
                        <span>{formatBytes(job.fileSize)}</span>
                        <span>{new Date(job.createdAt).toLocaleDateString()}</span>
                      </div>

                      {/* Status Indicator */}
                      <div className="pt-1 flex items-center justify-between">
                        {job.status === 'pending' && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-amber-50 text-amber-700 border border-amber-100">
                            <RefreshCw className="w-2.5 h-2.5 mr-1 animate-spin" />
                            Queued
                          </span>
                        )}

                        {job.status === 'transcribing' && (
                          <div className="w-full">
                            <div className="flex justify-between text-[9px] text-gray-700 font-bold uppercase tracking-wide mb-1">
                              <span className="flex items-center">
                                <RefreshCw className="w-2.5 h-2.5 mr-1 animate-spin" />
                                Processing ({job.progress}%)
                              </span>
                            </div>
                            <div className="w-full bg-gray-100 h-0.5 rounded-full overflow-hidden">
                              <div
                                className="bg-black h-0.5 rounded-full transition-all duration-300"
                                style={{ width: `${job.progress}%` }}
                              ></div>
                            </div>
                          </div>
                        )}

                        {job.status === 'completed' && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-gray-100 text-gray-800 border border-gray-200">
                            <Check className="w-2.5 h-2.5 mr-1" />
                            Completed
                          </span>
                        )}

                        {job.status === 'failed' && (
                          <div className="flex items-center gap-1.5 shrink-0 z-10">
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-red-50 text-red-700 border border-red-100"
                              title={job.error}
                            >
                              <AlertCircle className="w-2.5 h-2.5 mr-1 shrink-0" />
                              Failed
                            </span>
                            <button
                              onClick={(e) => handleRetryJob(job.id, e)}
                              title="Retry transcription job"
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-gray-50 hover:bg-gray-100 text-gray-700 border border-gray-200 cursor-pointer"
                            >
                              <RefreshCw className="w-2.5 h-2.5 mr-1" />
                              Retry
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* RIGHT COLUMN: DETAIL WORKSPACE */}
        <section className="flex-1 min-w-0 flex flex-col">
          {activeJob ? (
            <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-10 shadow-sm flex-1 flex flex-col space-y-6">
              
              {/* TOP HEADER: File Info & Controls */}
              <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-gray-150 pb-5 gap-4">
                <div className="space-y-1.5 text-left">
                  <div className="flex items-center gap-2">
                    <span className="bg-gray-100 text-gray-700 text-[10px] font-bold px-2 py-0.5 rounded font-mono uppercase tracking-widest">
                      ID: {activeJob.id.slice(0, 8)}
                    </span>
                    <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider flex items-center font-mono">
                      <Calendar className="w-3 h-3 mr-1" />
                      {new Date(activeJob.createdAt).toLocaleDateString()} • {new Date(activeJob.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </span>
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-serif font-medium text-gray-900 leading-tight">
                    {activeJob.fileName}
                  </h1>
                </div>

                {/* Export Buttons */}
                {activeJob.status === 'completed' && (
                  <div className="flex flex-wrap items-center gap-2 self-start md:self-center">
                    {/* Copy Transcript Button */}
                    <button
                      onClick={handleCopyToClipboard}
                      className="flex items-center space-x-1.5 px-4 py-2 text-xs font-semibold rounded-lg border border-gray-200 text-gray-800 bg-white hover:bg-gray-50 transition cursor-pointer font-sans"
                    >
                      {copyFeedback ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-green-600" />
                          <span>Copied!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy Transcript</span>
                        </>
                      )}
                    </button>

                    {/* Export Word Document */}
                    <a
                      href={`/api/jobs/${activeJob.id}/export/doc`}
                      download
                      className="inline-flex items-center space-x-1.5 px-4 py-2 text-xs font-semibold text-white bg-black rounded-lg hover:opacity-90 transition font-sans"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Export .DOCX</span>
                    </a>

                    {/* Export Text Document */}
                    <a
                      href={`/api/jobs/${activeJob.id}/export/txt`}
                      download
                      className="inline-flex items-center space-x-1.5 px-4 py-2 text-xs font-semibold text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition font-sans"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>.TXT</span>
                    </a>
                  </div>
                )}
              </div>

              {/* ACTIVE AUDIO PLAYER INTEGRATION */}
              {activeJob.audioUrl && (activeJob.status === 'completed' || activeJob.status === 'transcribing') && (
                <div className="bg-[#F1F3F5] rounded-xl p-4 border border-gray-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center space-x-3 text-left">
                    <div className="w-8 h-8 rounded bg-white flex items-center justify-center text-black border border-gray-100 shadow-xs">
                      <Volume2 className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-gray-900 uppercase tracking-wider">Source Recording</h4>
                    </div>
                  </div>
                  <div className="flex-1 max-w-sm">
                    <audio
                      ref={audioPlayerRef}
                      controls
                      src={activeJob.audioUrl}
                      className="w-full h-7 outline-hidden bg-transparent"
                    />
                  </div>
                </div>
              )}

              {/* TRANSCRIPTION PROCESSING STATE */}
              {activeJob.status === 'pending' && (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-12 space-y-4">
                  <div className="w-12 h-12 rounded-lg bg-gray-50 flex items-center justify-center text-gray-700 animate-pulse border border-gray-200">
                    <RefreshCw className="w-6 h-6 animate-spin" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-gray-900 uppercase tracking-widest">Queue Position: Pending</h3>
                    <p className="text-xs text-gray-500 mt-2 max-w-xs mx-auto">
                      Your audio is loaded and waiting. Gemini is initializing standard speech alignment models.
                    </p>
                  </div>
                </div>
              )}

              {activeJob.status === 'transcribing' && (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-12 space-y-6">
                  <div className="w-12 h-12 rounded-lg bg-gray-50 flex items-center justify-center text-gray-800 border border-gray-200">
                    <RefreshCw className="w-6 h-6 animate-spin" />
                  </div>
                  <div className="max-w-md space-y-3">
                    <h3 className="text-sm font-bold text-gray-900 uppercase tracking-widest">Processing & Transcribing</h3>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      Securing standard multi-script model checkpoints. Speech patterns, language transitions, and word timings are being aligned.
                    </p>
                    <div className="pt-3 max-w-xs mx-auto">
                      <div className="flex justify-between text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">
                        <span>
                          {activeJob.progress < 30 ? 'Preparing audio...' :
                           activeJob.progress < 50 ? 'Uploading to API...' :
                           activeJob.progress < 90 ? 'Analyzing bilingual scripts...' : 'Finalizing transcript...'}
                        </span>
                        <span>{activeJob.progress}%</span>
                      </div>
                      <div className="w-full bg-gray-100 h-1 rounded-full overflow-hidden">
                        <div
                          className="bg-black h-1 rounded-full transition-all duration-300"
                          style={{ width: `${activeJob.progress}%` }}
                        ></div>
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-400 font-mono pt-1">
                      Processing for {formatElapsed(now - new Date(activeJob.createdAt).getTime())} — long recordings (2-3hrs) can take tens of minutes.
                    </p>
                  </div>
                </div>
              )}

              {/* TRANSCRIPTION FAILED STATE */}
              {activeJob.status === 'failed' && (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-12 bg-red-50/25 border border-red-150 rounded-xl space-y-4">
                  <div className="w-12 h-12 rounded-lg bg-white flex items-center justify-center text-red-600 border border-red-100 shadow-sm">
                    <AlertCircle className="w-6 h-6" />
                  </div>
                  <div className="max-w-md space-y-4">
                    <h3 className="text-sm font-bold text-red-950 uppercase tracking-widest">Transcription Failed</h3>
                    <p className="text-xs text-red-800 mt-2 font-mono text-left bg-white border border-red-100 rounded-lg p-3 overflow-auto max-h-[120px]">
                      {activeJob.error || 'An error occurred during audio processing.'}
                    </p>
                    <p className="text-[10px] text-gray-400 leading-relaxed">
                      Please check that the audio is clean, confirm server connection, and verify your <strong className="text-gray-600">GEMINI_API_KEY</strong> configuration.
                    </p>
                    <div className="pt-2 flex items-center justify-center gap-3">
                      <button
                        onClick={(e) => handleRetryJob(activeJob.id, e)}
                        className="inline-flex items-center space-x-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-white bg-black rounded-lg hover:opacity-90 transition cursor-pointer shadow-sm"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Retry Transcription</span>
                      </button>
                      <button
                        onClick={(e) => handleDeleteJob(activeJob.id, e)}
                        className="inline-flex items-center space-x-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete Recording</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* TRANSCRIPTION COMPLETED SUCCESS WORKSPACE */}
              {activeJob.status === 'completed' && activeJob.transcriptLines && (
                <div className="flex-1 flex flex-col space-y-6">

                  {activeJob.truncated && (
                    <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl flex items-start space-x-2 text-left">
                      <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                      <span className="text-xs text-amber-800 font-medium leading-relaxed">
                        This transcript may be incomplete — the model hit its output limit before finishing. Review the end of the transcript, or try again.
                      </span>
                    </div>
                  )}

                  {/* SECTION 1: SPEAKER RENAMER & ALIGNER */}
                  <div className="bg-[#F1F3F5] rounded-xl border border-gray-200 text-left overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200/80">
                      <div className="flex items-center space-x-2">
                        <Layers className="w-3.5 h-3.5 text-gray-500" />
                        <label className="text-[10px] uppercase tracking-widest text-gray-400 font-bold block">
                          Speaker Label Customizer ({getUniqueSpeakers(activeJob).length} identified)
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsSpeakerCustomizerCollapsed(prev => !prev)}
                        className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-600 hover:bg-gray-50 hover:text-black transition cursor-pointer"
                      >
                        {isSpeakerCustomizerCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                        <span>{isSpeakerCustomizerCollapsed ? 'Expand' : 'Collapse'}</span>
                      </button>
                    </div>

                    {!isSpeakerCustomizerCollapsed && (
                      <div className="p-5">
                        <p className="text-[11px] text-gray-500 mb-4 leading-relaxed font-sans">
                          Rename default speaker labels (e.g., Person 1, Person 2). This instantly modifies their headings throughout the document editor and exports.
                        </p>

                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 font-sans">
                          {getUniqueSpeakers(activeJob).map((speakerKey, idx) => {
                            const isEditingThisSpeaker = editingSpeakerKey === speakerKey;
                            const currentDisplayName = activeJob.speakerMap?.[speakerKey] || speakerKey;

                            const col = SPEAKER_COLORS[idx % SPEAKER_COLORS.length];

                            return (
                              <div
                                key={speakerKey}
                                className="bg-white border border-gray-200 p-3 rounded-lg flex items-center justify-between shadow-xs"
                              >
                                {isEditingThisSpeaker ? (
                                  <div className="flex items-center space-x-1.5 w-full">
                                    <input
                                      type="text"
                                      value={editingSpeakerValue}
                                      onChange={(e) => setEditingSpeakerValue(e.target.value)}
                                      placeholder={speakerKey}
                                      className="text-xs border border-gray-300 rounded px-2 py-1 w-full bg-gray-50 focus:outline-hidden focus:ring-1 focus:ring-black focus:bg-white font-medium"
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          handleUpdateSpeakerName(speakerKey, editingSpeakerValue);
                                        } else if (e.key === 'Escape') {
                                          setEditingSpeakerKey(null);
                                        }
                                      }}
                                      autoFocus
                                    />
                                    <button
                                      onClick={() => handleUpdateSpeakerName(speakerKey, editingSpeakerValue)}
                                      title="Save"
                                      className="p-1 rounded text-green-700 hover:bg-green-50 shrink-0"
                                    >
                                      <Save className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={() => setEditingSpeakerKey(null)}
                                      title="Cancel"
                                      className="p-1 rounded text-gray-400 hover:bg-gray-100 shrink-0"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div className={`w-6 h-6 ${col.bg} ${col.text} text-[10px] font-bold rounded flex items-center justify-center shrink-0`}>
                                        {col.short}
                                      </div>
                                      <span className="text-xs font-semibold text-gray-800 truncate" title={currentDisplayName}>
                                        {currentDisplayName}
                                      </span>
                                    </div>
                                    <button
                                      onClick={() => {
                                        setEditingSpeakerKey(speakerKey);
                                        setEditingSpeakerValue(currentDisplayName === speakerKey ? '' : currentDisplayName);
                                      }}
                                      title="Rename Speaker"
                                      className="p-1 rounded text-gray-400 hover:text-black hover:bg-gray-100 transition cursor-pointer"
                                    >
                                      <Edit2 className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* SECTION 2: TRANSCRIPT VIEWER AND LINE-EDITOR */}
                  <div className="flex-1 flex flex-col space-y-4">
                    
                    {/* Search & Statistics bar */}
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                      <div className="relative w-full sm:max-w-xs">
                        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          placeholder="Search keywords or speakers..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          className="w-full text-xs border border-gray-200 rounded-lg pl-9 pr-4 py-2 bg-gray-50 focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-black focus:border-black transition font-sans"
                        />
                      </div>
                      
                      <div className="text-[10px] uppercase tracking-wider text-gray-400 font-bold font-mono">
                        Showing <strong className="text-gray-950 font-extrabold">{filteredLines.length}</strong> of {activeJob.transcriptLines.length} phrases
                      </div>
                    </div>

                    {/* TRANSCRIPT BLOCKS CONTAINER */}
                    <div className="border border-gray-200 rounded-xl overflow-hidden bg-white flex-1 flex flex-col">
                      <div className="px-5 py-3.5 bg-gray-50 border-b border-gray-100 text-left text-[10px] uppercase tracking-widest font-bold text-gray-400 flex items-center justify-between">
                        <span>Transcript Content</span>
                        <span className="flex items-center text-gray-400 font-medium lowercase tracking-normal">
                          <Info className="w-3 h-3 mr-1" />
                          Double-click any speech block to edit
                        </span>
                      </div>

                      <div className="flex-1 overflow-y-auto max-h-[600px] p-6 sm:p-8 space-y-6 divide-y divide-gray-100">
                        {filteredLines.length === 0 ? (
                          <div className="text-center py-12 text-gray-400">
                            <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
                            <p className="text-xs font-bold uppercase tracking-wider">No matching phrases found</p>
                            <p className="text-[10px] mt-1">Try another search phrase or language character.</p>
                          </div>
                        ) : (
                          filteredLines.map((line, index) => {
                            const isEditingLine = editingLineId === line.id;
                            const speakerName = activeJob.speakerMap?.[line.speaker] || line.speaker;
                            
                            // Escape the raw text first, then apply the cosmetic tag styling —
                            // otherwise literal <, >, & in a transcript (or a maliciously
                            // edited line) would render as live HTML via dangerouslySetInnerHTML.
                            const formattedText = escapeHtml(line.text)
                              .replace(/\[inaudible\]/gi, '<span class="px-1.5 py-0.5 mx-0.5 rounded bg-red-50 text-red-600 font-mono font-bold text-[10px]">[inaudible]</span>')
                              .replace(/\[unclear:\s*([^\]]+)\]/gi, '<span class="px-1.5 py-0.5 mx-0.5 rounded bg-amber-50 text-amber-700 font-mono font-bold text-[10px]" title="Unclear word">[guess: $1]</span>');

                            // Find speaker index to apply the shared speaker color palette
                            const speakersList = getUniqueSpeakers(activeJob);
                            const speakerIdx = speakersList.indexOf(line.speaker);
                            const speakerColorClass = SPEAKER_COLORS[speakerIdx % SPEAKER_COLORS.length].text;

                            return (
                              <div
                                key={line.id}
                                className={`pt-5 ${index === 0 ? 'pt-0' : ''} text-left flex gap-4 group/line transition-colors duration-150 rounded-lg p-2.5 -mx-2.5 hover:bg-gray-50/50`}
                              >
                                {/* Text Body & Editor column */}
                                <div className="flex-1 min-w-0 pl-2 relative">
                                  {isEditingLine ? (
                                    <div className="space-y-2">
                                      <textarea
                                        value={editingLineText}
                                        onChange={(e) => setEditingLineText(e.target.value)}
                                        rows={2}
                                        className="w-full text-sm border border-gray-300 rounded-lg p-3 focus:outline-hidden focus:ring-1 focus:ring-black bg-white font-sans"
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleSaveLineText(line.id);
                                          } else if (e.key === 'Escape') {
                                            setEditingLineId(null);
                                          }
                                        }}
                                        autoFocus
                                      />
                                      <div className="flex justify-end space-x-2">
                                        <button
                                          onClick={() => setEditingLineId(null)}
                                          className="px-2.5 py-1 text-xs font-semibold rounded text-gray-500 bg-gray-100 hover:bg-gray-200 transition cursor-pointer font-sans"
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          onClick={() => handleSaveLineText(line.id)}
                                          className="px-2.5 py-1 text-xs font-semibold rounded text-white bg-black hover:opacity-90 transition flex items-center space-x-1 font-sans"
                                        >
                                          <Save className="w-3.5 h-3.5" />
                                          <span>Save</span>
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="pr-10 relative">
                                      <span className={`font-bold text-sm ${speakerColorClass} font-sans`}>
                                        {speakerName}:
                                      </span>
                                      <span
                                        className="text-base leading-relaxed ml-2 text-gray-800 font-sans cursor-text"
                                        onDoubleClick={() => {
                                          setEditingLineId(line.id);
                                          setEditingLineText(line.text);
                                        }}
                                        dangerouslySetInnerHTML={{ __html: formattedText }}
                                      />
                                      
                                      {/* Inline edit button shown on hover */}
                                      <button
                                        onClick={() => {
                                          setEditingLineId(line.id);
                                          setEditingLineText(line.text);
                                        }}
                                        title="Edit this block"
                                        className="sm:opacity-0 group-hover/line:opacity-100 absolute top-1 right-1 p-1 rounded text-gray-400 hover:text-black hover:bg-gray-100 transition duration-150 cursor-pointer"
                                      >
                                        <Edit2 className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* BEAUTIFUL MAIN DRAG-AND-DROP UPLOAD ZONE WHEN NO ACTIVE JOB SELECTED */
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={triggerFileSelect}
              className={`bg-white rounded-xl border-2 border-dashed p-12 sm:p-20 shadow-xs flex-1 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 ${
                isDragOver
                  ? 'border-black bg-gray-50 scale-[0.99]'
                  : 'border-gray-200 hover:border-black hover:bg-gray-50/50'
              } font-sans`}
            >
              <div className="w-16 h-16 rounded-2xl bg-gray-50 border border-gray-150 flex items-center justify-center text-black shadow-xs mb-6 shrink-0">
                <FileAudio className="w-8 h-8" />
              </div>
              <div className="max-w-md space-y-4">
                <h2 className="text-xl font-serif font-medium text-gray-900 tracking-tight sm:text-2xl leading-snug">
                  Transcribe Bilingual Recording
                </h2>
                <p className="text-xs text-gray-500 leading-relaxed max-w-sm mx-auto">
                  Drag and drop your audio here, or click to browse files. AudioScribe transcribes and aligns Kannada & English conversation tracks side-by-side.
                </p>
                <div className="pt-3 flex flex-col items-center justify-center gap-3">
                  <span className="inline-flex items-center space-x-2 px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white bg-black rounded-lg hover:opacity-90 transition shadow-sm cursor-pointer">
                    <Plus className="w-4 h-4" />
                    <span>Select Audio File</span>
                  </span>
                  <span className="text-[10px] text-gray-400 font-mono">
                    MP3, M4A, AAC, OGG recommended for long recordings (up to 500MB). Uncompressed WAV only fits ~45-50 min at that size.
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* FOOTER */}
      <footer id="app-footer" className="bg-white border-t border-gray-200 py-4 mt-12 shrink-0 font-sans">
        <div className="w-full px-4 sm:px-6 lg:px-8 text-xs text-gray-400">
          <p className="text-left font-medium">
            AudioScribe • Bilingual Kannada & English speech transcription.
          </p>
        </div>
      </footer>
    </div>
  );
}
