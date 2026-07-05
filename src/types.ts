/**
 * @license
 * SPDX-License-Identifier: MIT
 */

export interface TranscriptLine {
  id: string;
  speaker: string; // e.g., "Person 1"
  text: string;    // e.g., "ನಮಸ್ಕಾರ, how are you?"
}

export interface TranscriptionJob {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  audioUrl?: string; // Relative URL to play/stream the audio from the backend
  status: 'pending' | 'transcribing' | 'completed' | 'failed';
  progress: number;  // 0 to 100
  error?: string;
  createdAt: string;
  completedAt?: string;
  transcriptLines?: TranscriptLine[];
  rawTranscript?: string;
  speakerMap?: Record<string, string>; // Maps "Person 1" -> "Rajesh", etc.
  truncated?: boolean; // True if the model hit maxOutputTokens before finishing
  geminiFile?: {
    name: string;
    uri: string;
    mimeType: string;
    uploadedAt: string;
  };
}
