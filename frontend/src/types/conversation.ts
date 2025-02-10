export interface ConversationMessage {
  id: string;          // Will be timestamp
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  replyTo?: string;
  files?: string[];
  errorLog?: string;
  isResolved?: boolean;
  contextUpdate?: {
    addedFiles?: string[];
    removedFiles?: string[];
    errorLogChanged?: boolean;
  };
}

export interface ResolvedError {
  errorLog: string;
  timestamp: string;
}

export interface ConversationSession {
  id: string;          // Will be timestamp
  startTime: string;
  endTime?: string;
  messages: ConversationMessage[];
  resolvedErrors: ResolvedError[];
  directory: string;
}
