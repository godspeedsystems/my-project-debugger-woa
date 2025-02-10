import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import axios from 'axios';
import { writeFile } from 'fs/promises';
import { FileContent } from '../types/common';
import { ConversationSession, ConversationMessage } from '../types/conversation';
import { ProjectContextGatherer } from './ProjectContextGatherer'; // adjust if needed
import { glob } from 'glob';

// --- Utility functions ---

export const STACK_TRACE_PATTERNS = {
  nodeStyle: /at\s+(?:(?<functionName>[^(]+)?\s+)?\(?(?<fileInfo>(?<fileName>[^:]+):(?<lineNumber>\d+):(?<columnNumber>\d+))?\)?/,
  browserStyle: /(?<functionName>[^@]*)@(?<fileName>[^:]+):(?<lineNumber>\d+):(?<columnNumber>\d+)/,
  javaStyle: /at\s+(?<className>[\w$\.]+)\.(?<methodName>[\w$]+)\((?<fileName>[\w$\.]+):(?<lineNumber>\d+)\)/,
  pythonStyle: /File\s+"(?<fileName>[^"]+)",\s+line\s+(?<lineNumber>\d+),\s+in\s+(?<functionName>\w+)/,
  errorMessage: /(?<type>[\w$\.]+Error):\s+(?<message>.*)/
};

export function parseStackTrace(errorLog: string) {
  const lines = errorLog.trim().split('\n').map(line => line.trim());
  const frames: any[] = [];
  let message = '';
  let type = '';
  const errorMatch = lines[0].match(STACK_TRACE_PATTERNS.errorMessage);
  if (errorMatch?.groups) {
    type = errorMatch.groups.type;
    message = errorMatch.groups.message;
  } else {
    message = lines[0];
  }
  for (const line of lines.slice(1)) {
    let frame: any = { rawLine: line };
    let matched = false;


    for (const [style, pattern] of Object.entries(STACK_TRACE_PATTERNS)) {
      if (style === 'errorMessage') continue;
      const match = line.match(pattern);
      if (match?.groups) {
        matched = true;
        frame = {
          ...frame,
          ...match.groups,
          lineNumber: match.groups.lineNumber ? parseInt(match.groups.lineNumber, 10) : undefined,
          columnNumber: match.groups.columnNumber ? parseInt(match.groups.columnNumber, 10) : undefined
        };
        if (frame.functionName) {
          frame.isConstructor = frame.functionName.includes('new ');
          frame.functionName = frame.functionName.replace('new ', '').trim();
        }
        if (frame.fileName) {
          frame.isNative = frame.fileName.includes('native');
          frame.fileRelativePath = path.relative(process.cwd(), frame.fileName);
        }
        break;
      }
    }
    if (matched && frame.fileName) {
      frames.push(frame);
    }
  }
  return {
    message,
    type,
    frames,
    rawStack: errorLog
  };
}

export async function prepareAnalysisContext(
  files: FileContent[],
  errorLog: string,
  stackTrace: ReturnType<typeof parseStackTrace>,
  directory: string,
  session?: ConversationSession,
  currentPrompt?: string
) {
  try {
    let projectContext: string;
    const contextFilePath = path.join(directory, '.superdebugger', 'context.json');
    try {
      await fs.access(contextFilePath);
      projectContext = await fs.readFile(contextFilePath, 'utf-8');
    } catch {
      // Fallback: gather context using ProjectContextGatherer if context.json is not available
      const { ProjectContextGatherer } = require('./ProjectContextGatherer');
      const contextGatherer = new ProjectContextGatherer(directory);
      projectContext = await contextGatherer.formatForLLM();
    }

    let conversationHistory;
    if (session?.messages) {
      const interactions: { prompt: string; response: string; timestamp: string }[] = [];
      let userMessage: ConversationMessage | undefined;
      for (const msg of session.messages) {
        if (msg.role === 'user') {
          userMessage = msg;
        } else if (msg.role === 'assistant' && userMessage) {
          interactions.push({
            prompt: userMessage.content,
            response: msg.content,
            timestamp: msg.timestamp
          });
          userMessage = undefined;
        }
      }
      if (currentPrompt) {
        interactions.push({
          prompt: currentPrompt,
          response: '',
          timestamp: new Date().toISOString()
        });
      }
      conversationHistory = {
        messages: session.messages,
        interactions
      };
    }
    return {
      files,
      errorLog,
      projectContext,
      timestamp: new Date().toISOString(),
      conversationHistory
    };
  } catch (error) {
    console.error(chalk.yellow('Warning: Error gathering project context:'), error);
    return {
      files,
      errorLog,
      projectContext: 'Project context gathering failed',
      timestamp: new Date().toISOString()
    };
  }
}

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/build/**',
  '**/.cache/**',
  '**/coverage/**'
];

export async function analyzeStackTrace(
  stackTrace: ReturnType<typeof parseStackTrace>,
  baseDir: string
): Promise<Set<string>> {
  const relevantFiles = new Set<string>();
  const filePatterns = new Set<string>();
  for (const frame of stackTrace.frames) {
    if (frame.fileName) {
      const fileName = path.basename(frame.fileName);
      const fileNameWithoutExt = path.parse(fileName).name;
      filePatterns.add(`**/${fileName}`);
      filePatterns.add(`**/${fileNameWithoutExt}.*`);
      if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) {
        filePatterns.add(`**/${fileNameWithoutExt}.d.ts`);
      }
      if (fileName.endsWith('.js')) {
        filePatterns.add(`**/${fileNameWithoutExt}.ts`);
        filePatterns.add(`**/${fileNameWithoutExt}.tsx`);
      }
    }
  }
  try {
    const files = await glob(Array.from(filePatterns), {
      cwd: baseDir,
      ignore: IGNORE_PATTERNS,
      absolute: true,
      nodir: true
    });
    files.forEach(file => relevantFiles.add(file));
  } catch (error) {
    console.error(chalk.yellow('Error finding related files:', error));
  }
  return relevantFiles;
}

export async function getErrorContext(
  filePath: string,
  lineNumber: number,
  contextLines: number = 5
): Promise<string> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, lineNumber - contextLines - 1);
    const end = Math.min(lines.length, lineNumber + contextLines);
    return lines
      .slice(start, end)
      .map((line, index) => {
        const currentLineNumber = start + index + 1;
        const isErrorLine = currentLineNumber === lineNumber;
        return `${currentLineNumber.toString().padStart(4)} | ${isErrorLine ? chalk.red(line) : line}`;
      })
      .join('\n');
  } catch (error) {
    return `Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export function displayFormattedResponse(
  response: { answer: string; model: string; usage?: any },
  options: { wrapWidth?: number; codeBlockColor?: string; textColor?: string } = {}
) {
  const { wrapWidth = 80, codeBlockColor = 'cyan', textColor = 'white' } = options;
  const applyChalkColor = (text: string, color: string): string => {
    const chalkMethod = (chalk as any)[color];
    return typeof chalkMethod === 'function' ? chalkMethod(text) : text;
  };
  try {
    console.log(chalk.yellow('\nDebug: Raw Response:'));
    console.log(chalk.gray('─'.repeat(wrapWidth)));
    console.log(chalk.white(JSON.stringify(response, null, 2)));
    console.log(chalk.gray('─'.repeat(wrapWidth)));
    if (!response?.answer) {
      throw new Error('Invalid response format: missing answer field');
    }
    const answer = response.answer.trim();
    const metadata = response;
    console.log('\n' + chalk.green('Analysis Result:'));
    console.log(chalk.gray('─'.repeat(wrapWidth)));
    const segments: string[] = answer.split(/(```[\s\S]*?```)/g);
    segments.forEach(segment => {
      segment = segment.trim();
      if (!segment) return;
      if (segment.startsWith('```')) {
        const codeBlock = segment.replace(/```(\w+)?/, '').replace(/```$/, '').trim();
        const language = segment.match(/```(\w+)/)?.[1] || '';
        console.log(chalk.yellow(`\nCode${language ? ` (${language})` : ''}:`));
        console.log(applyChalkColor(codeBlock, codeBlockColor));
        console.log();
      } else {
        const words = segment.split(/\s+/);
        let currentLine = '';
        words.forEach(word => {
          if ((currentLine + ' ' + word).length <= wrapWidth) {
            currentLine += (currentLine ? ' ' : '') + word;
          } else {
            if (currentLine) {
              console.log(applyChalkColor(currentLine, textColor));
            }
            currentLine = word;
          }
        });
        if (currentLine) {
          console.log(applyChalkColor(currentLine, textColor));
        }
      }
    });
    console.log(chalk.gray('─'.repeat(wrapWidth)));
    if (metadata.model) {
      console.log(chalk.gray(`\nModel: ${metadata.model}`));
    }
    if (metadata.usage) {
      console.log(chalk.gray('Usage Statistics:'));
      console.log(chalk.gray(`  - Prompt Tokens: ${metadata.usage.prompt_tokens}`));
      console.log(chalk.gray(`  - Completion Tokens: ${metadata.usage.completion_tokens}`));
      console.log(chalk.gray(`  - Total Tokens: ${metadata.usage.total_tokens}`));
    }
  } catch (error) {
    console.error(chalk.red('\nError parsing response:'));
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    console.log(chalk.yellow('\nAttempting to display raw response data:'));
    console.log(chalk.gray('─'.repeat(wrapWidth)));
    try {
      if (typeof response === 'string') {
        console.log(chalk.white(response));
      } else if (response instanceof Buffer) {
        console.log(chalk.white(response.toString()));
      } else {
        console.log(chalk.white(JSON.stringify(response, null, 2)));
      }
    } catch (displayError) {
      console.error(chalk.red('\nFailed to stringify response:'), displayError instanceof Error ? displayError.message : 'Unknown error');
      console.log(chalk.white(response));
    }
    console.log(chalk.gray('─'.repeat(wrapWidth)));
  }
}

export async function saveContextToFile(
  context: any,
  directory: string,
  prefix: string = 'llm-context'
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${prefix}-${timestamp}.json`;
  const filepath = path.join(directory, filename);
  try {
    await writeFile(filepath, JSON.stringify(context, null, 2), 'utf-8');
    return filepath;
  } catch (error) {
    console.error(chalk.red('Error saving context to file:'), error);
    throw error;
  }
}

export async function sendToLLM(
  files: FileContent[],
  errorLog: string,
  prompt?: string,
  saveContext: boolean = false,
  session?: ConversationSession
) {
  try {
    const stackTrace = parseStackTrace(errorLog);
    // Updated: pass session.directory as the 4th argument.
    const analysisContext = await prepareAnalysisContext(
      files,
      errorLog,
      stackTrace,
      session?.directory || process.cwd(),
      session,
      prompt
    );
    const requestPayload = {
      analysisContext,
      prompt: prompt || "Please analyze the code and error log, and explain what might be wrong.",
    //   conversationHistory: session?.messages || []
    };
    if (saveContext) {
      try {
        const savedPath = await saveContextToFile(requestPayload, process.cwd());
        console.log(chalk.green('\nContext saved to:'), chalk.cyan(savedPath));
      } catch (error) {
        console.error(chalk.yellow('Warning: Failed to save context file'), error);
      }
    }
    const response = await axios.post('http://localhost:3000/api/code/context', requestPayload);
    let answer: string;
    if (response.data.choices && response.data.choices.length > 0) {
      answer = response.data.choices[0].message.content;
    } else if (response.data.answer) {
      answer = response.data.answer;
    } else {
      throw new Error('No valid answer found in response');
    }
    return {
      answer,
      model: response.data.model || 'unknown',
      usage: response.data.usage
    };
  } catch (error) {
    console.error(chalk.red('\nDetailed Error Information:'));
    if (error instanceof Error && error.message.includes('ProjectContextGatherer')) {
      console.error(chalk.yellow('Error gathering project context:'), error.message);
    } else if (axios.isAxiosError(error)) {
      console.error(chalk.red(`Status: ${error.response?.status || 'unknown'}`));
      console.error(chalk.red(`Message: ${error.message}`));
      if (error.response?.data) {
        console.error(chalk.yellow('\nResponse Data:'));
        console.error(JSON.stringify(error.response.data, null, 2));
      }
    } else {
      console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    }
    throw error;
  }
}

export async function printProjectContext(directory: string, debug: boolean = false): Promise<void> {
  try {
    console.log(chalk.blue('\nGathering Project Context...'));
    const gatherer = new ProjectContextGatherer(directory);
    const context = await gatherer.formatForLLM();
    console.log(chalk.gray('─'.repeat(80)));
    console.log(context);
    console.log(chalk.gray('─'.repeat(80)));
    if (debug) {
      const rawInfo = await gatherer.gatherEnvironmentInfo();
      console.log(chalk.yellow('\nDebug: Raw Project Information:'));
      console.log(JSON.stringify(rawInfo, null, 2));
    }
  } catch (error) {
    console.error(chalk.red('Error gathering project context:'), error);
    throw error;
  }
}

export function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString('en-US', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour12: false
  });
}

// ...you may add further shared utilities here...
