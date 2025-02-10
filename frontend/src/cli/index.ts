#!/usr/bin/env ts-node

import { Command } from 'commander';
import inquirer from 'inquirer';

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import axios from 'axios';
import {exec} from 'child_process'; 
import ora from 'ora' ; 
// import { glob } from 'glob';
// import { promisify } from 'util';
// import { ProjectContextGatherer } from '../utils/ProjectContextGatherer';
// import { writeFile } from 'fs/promises';
import { ConversationManager } from '../utils/conversationManager';
import { ConversationSession, ConversationMessage } from '../types/conversation';
import { FileHandler } from '../utils/fileHandler';
import { FileContent } from '../types/common';
import {
  parseStackTrace,
  prepareAnalysisContext,
  analyzeStackTrace,
  getErrorContext,
  displayFormattedResponse,
  saveContextToFile,
  sendToLLM,
  printProjectContext,
  formatTimestamp
} from '../utils/analysisUtils';
import { ChildProcess } from 'child_process';

// Type definitions
export const spinner = ora('Initializing code-help...').start();
interface Interaction {
  prompt: string;
  response: string;
  timestamp: string;
}

interface AnalysisContext {
  files: FileContent[];
  errorLog: string;
  projectContext: string;
  timestamp: string;
  conversationHistory?: {
    messages: ConversationMessage[];
    interactions: Interaction[];
  };
}

interface LLMResponse {
  answer: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  choices?: Array<{
    message: {
      content: string;
      role: string;
    };
    index: number;
    finish_reason: string;
  }>;
}

interface APIResponse {
  success?: boolean;  // Made optional since it's not in the response
  code?: number;      // Made optional since it's not in the response
  answer: string;     // Direct properties from the response
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Update the ChalkColor type to match chalk's actual color methods
type ChalkColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray' | 'grey';

interface DisplayOptions {
  wrapWidth?: number;
  codeBlockColor?: ChalkColor;
  textColor?: ChalkColor;
}

// Constants
const DEFAULT_API_URL = 'http://localhost:3000/api/code/context';
const DEFAULT_FILE_PATTERNS = ['**/*.{ts,js,tsx,jsx,json,md,py,java,cpp,c,h,hpp,cs,go,rs,rb}'];
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/build/**',
  '**/.cache/**',
  '**/coverage/**'
];
interface StackTraceFrame {
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  functionName?: string;
  methodName?: string;
  className?: string;
  isNative?: boolean;
  isConstructor?: boolean;
  fileRelativePath?: string;
  rawLine: string;
}

interface ParsedStackTrace {
  message: string;
  type?: string;
  frames: StackTraceFrame[];
  rawStack: string;
}

// Main CLI Application
async function main() {
  const program = new Command();

  program
    .name('code-help')
    .description('CLI tool to get AI help with code issues')
    .version('1.1.0.3');

  // Add new command for context
  program
    .command('context')
    .description('Display project context information')
    .option('-d, --directory <path>', 'Specify directory to scan', process.cwd())
    .option('--debug', 'Show raw context data', false)
    .action(async (options) => {
      try {
        await printProjectContext(options.directory, options.debug);
      } catch (error) {
        console.error(chalk.red('Error:'), error);
        process.exit(1);
      }
    });

  program
    .command('analyze')
    .description('Analyze code files and error logs')
    .option('-d, --directory <path>', 'Specify directory to scan', process.cwd())
    .option('-p, --pattern <pattern>', 'File pattern to match')
    .option('--debug', 'Enable debug mode', false)
    .option('--save-context', 'Save the analysis context to a file', false)
    .action(async (options) => {
      try {
        console.log(chalk.blue('\nCode Analysis Helper'));
        console.log(chalk.blue('===================\n'));

        const fileHandler = new FileHandler(options.directory);
        let files: FileContent[] = [];

        // File Selection Method
        const fileQuestions = await inquirer.prompt<{ fileSelection: 'scan' | 'manual' }>([
          {
            type: 'list',
            name: 'fileSelection',
            message: 'How would you like to add files?',
            choices: [
              { name: 'Scan current directory', value: 'scan' },
              { name: 'Add files manually', value: 'manual' }
            ]
          }
        ]);

        files = await fileHandler.selectFiles([], fileQuestions.fileSelection);

        // Error Log Input
        const errorLogQuestions = await inquirer.prompt<{ errorLog: string }>([
          {
            type: 'editor',
            name: 'errorLog',
            message: 'Please paste your error log (press i to start editing, ESC then :wq to save):',
            default: ''
          }
        ]);

        // Optional Question Input



        const stackTrace = parseStackTrace(errorLogQuestions.errorLog);

      
        if (options.debug) {
          console.log(chalk.yellow('\nParsed Stack Trace:'));
          console.log(JSON.stringify(stackTrace, null, 2));
        }
  
        console.log(chalk.blue('\nError Analysis:'));
        console.log(chalk.red(`Error: ${stackTrace.type || 'Unknown Error'}`));
        console.log(chalk.red(`Message: ${stackTrace.message}`));
  
        // Find relevant files
        const relevantFiles = await analyzeStackTrace(stackTrace, options.directory);
  
        if (relevantFiles.size > 0) {
          console.log(chalk.yellow('\nRelevant files found:'));
          for (const file of relevantFiles) {
            console.log(chalk.cyan(`- ${path.relative(options.directory, file)}`));
          }
  
          // Show context for error locations
          console.log(chalk.yellow('\nError context:'));
          for (const frame of stackTrace.frames) {
            if (frame.fileName && frame.lineNumber) {
              const filePath = path.resolve(options.directory, frame.fileName);
              if (await fs.access(filePath).then(() => true).catch(() => false)) {
                console.log(chalk.cyan(`\nIn ${frame.fileName}:`));
                console.log(await getErrorContext(filePath, frame.lineNumber));
              }
            }
          }
  
          // Ask user which files to include
          const fileSelection = await inquirer.prompt<{ selectedFiles: string[] }>([
            {
              type: 'checkbox',
              name: 'selectedFiles',
              message: 'Select files to include in analysis:',
              choices: Array.from(relevantFiles).map(file => ({
                name: path.relative(options.directory, file),
                value: file,
                checked: true
              }))
            }
          ]);
  
          // Add selected files to analysis
          for (const file of fileSelection.selectedFiles) {
            const content = await fileHandler.readFileContent(file);
            files.push({
              name: path.relative(options.directory, file),
              content
            });
          }
        }



        const promptQuestions = await inquirer.prompt<{ hasPrompt: boolean; prompt?: string }>([
          {
            type: 'confirm',
            name: 'hasPrompt',
            message: 'Would you like to add a specific question?',
            default: false
          },
          {
            type: 'input',
            name: 'prompt',
            message: 'Enter your question:',
            when: (answers) => answers.hasPrompt
          }
        ]);
        // Show Summary
        console.log(chalk.yellow('\nAnalysis Summary:'));
        console.log('─'.repeat(50));
        console.log(chalk.white('Files to analyze:'));
        files.forEach(f => console.log(chalk.cyan(`- ${f.name}`)));
        console.log(chalk.white(`\nError log size: ${errorLogQuestions.errorLog.length} characters`));
        if (promptQuestions.prompt) {
          console.log(chalk.white(`Question: ${promptQuestions.prompt}`));
        }
        console.log('─'.repeat(50));

        // Confirmation
        const confirm = await inquirer.prompt<{ proceed: boolean }>([
          {
            type: 'confirm',
            name: 'proceed',
            message: 'Would you like to proceed with the analysis?',
            default: true
          }
        ]);

        if (!confirm.proceed) {
          console.log(chalk.yellow('\nOperation cancelled'));
          return;
        }

        // Show Progress
        console.log(chalk.blue('\nSending request to AI...'));

        try {
          // Call API and handle response
          const response = await sendToLLM(
            files,
            errorLogQuestions.errorLog,
            promptQuestions.prompt,
            
            options.saveContext  // Pass the save option
          );

          // Display the response with debug information
          displayFormattedResponse(response, {
            wrapWidth: 80,
            codeBlockColor: 'cyan',
            textColor: 'white'
          });

        } catch (error) {
          if (options.debug) {
            console.error(chalk.red('\nDetailed Error Information:'));
            console.error(error);
          } else {
            console.error(chalk.red('\nError during analysis:'), error instanceof Error ? error.message : error);
          }
        }
      } catch (error) {
        console.error(chalk.red('Error during analysis:', error));
        if (options.debug) {
          console.error('\nStack trace:', error);
        }
      }
    });

  // Add to the main CLI application
  program
    .command('chat')
    .description('Start an interactive debugging session')
    .option('-d, --directory <path>', 'Specify directory to scan', process.cwd())
    .option('--debug', 'Enable debug mode', false)
    .option('-c, --continue', 'Continue an existing session', false)
    .action(async (options) => {
      
      const conversationManager = new ConversationManager(options.directory);
      spinner.text = "Conversation Manager Initialized";
      const fileHandler = new FileHandler(options.directory);
      spinner.text = "File Manager Initialized";
      await conversationManager.initialize();
      spinner.text = "Code-help sucessfully initialized" ;


      // const repomap = await axios.post('http://localhost:3000/repomap', {gitUrl});
      
      let session: ConversationSession;
      let currentFiles: FileContent[] = [];
      let currentErrorLog: string = '';
      let lastMessageTimestamp: string = '';

      if (options.continue) {
        // Get recent sessions
        const directory = options.directory || process.cwd(); 



        const recentSessions = await conversationManager.getRecentSessions();
        
        
        if (recentSessions.length === 0) {
          console.log(chalk.yellow('\nNo existing sessions found. Starting new session...'));
          session = await conversationManager.createSession();
        } else {
          // Let user choose a session
          const { sessionId } = await inquirer.prompt<{ sessionId: string }>([{
            type: 'list',
            name: 'sessionId',
            message: 'Choose a session to continue:',
            choices: recentSessions.map(s => ({
              name: `${s.id} (${s.messages.length} messages)`,
              value: s.id,
              description: s.messages[s.messages.length - 1]?.content || 'No messages'
            }))
          }]);

          session = await conversationManager.loadSession(sessionId);
          
          // Restore last state
          const lastMessage = session.messages[session.messages.length - 1];
          if (lastMessage) {
            lastMessageTimestamp = lastMessage.timestamp;
            currentFiles = lastMessage.files ? await Promise.all(
              lastMessage.files.map(async f => ({
                name: f,
                content: await fileHandler.readFileContent(path.join(options.directory, f))
              }))
            ) : [];
            currentErrorLog = lastMessage.errorLog || '';
          }

          console.log(chalk.green('\nContinuing session from:', (session.startTime).toLocaleString()));
          console.log(chalk.gray('Last message:', new Date(lastMessageTimestamp).toLocaleString()));
        }
      } else {
        const directory = options.directory || process.cwd();

        session = await conversationManager.createSession(directory);
      }

      
      
      
      console.log(chalk.blue('\nStarting interactive debugging session...'));
      console.log(chalk.gray('Type "quit" to exit, "history" to view conversation history\n'));

      while (true) {
        const { command } = await inquirer.prompt<{ command: string }>([{
          type: 'input',
          name: 'command',
          message: chalk.green('What would you like to do?')
        }]);

        if (command.toLowerCase() === 'quit') {
          session.endTime = new Date().toISOString();
          await conversationManager.saveSession(session); // Final save
          break;
        }
        if (command.toLowerCase() === 'history') {
          // Show conversation history with resolved error summaries
          console.log(chalk.yellow('\nConversation History:'));
          session.messages.forEach((msg) => {
            const prefix = msg.isResolved ? chalk.gray('(Resolved) ') : '';
            console.log(chalk.gray(`\n--- ${prefix}${msg.role.toUpperCase()} (${formatTimestamp(msg.timestamp)}) ---`));
            if (msg.contextUpdate) {
              console.log(chalk.cyan('Context Updates:'));
              if (msg.contextUpdate.addedFiles?.length) {
                console.log(chalk.green(`Added files: ${msg.contextUpdate.addedFiles.join(', ')}`));
              }
              if (msg.contextUpdate.removedFiles?.length) {
                console.log(chalk.red(`Removed files: ${msg.contextUpdate.removedFiles.join(', ')}`));
              }
              if (msg.contextUpdate.errorLogChanged) {
                console.log(chalk.yellow('Error log was updated'));
              }
            }
            console.log(msg.content);
          });
          continue;
        }

        // Initial file selection if no files are selected
        if (currentFiles.length === 0) {
          const { fileSelection } = await inquirer.prompt<{ fileSelection: 'scan' | 'manual' }>([{
            type: 'list',
            name: 'fileSelection',
            message: 'How would you like to add files?',
            choices: [
              { name: 'Scan current directory', value: 'scan' },
              { name: 'Add files manually', value: 'manual' }
            ]
          }]);

          currentFiles = await fileHandler.selectFiles([], fileSelection);
        }

        // Error log handling
        let errorLogChanged = false;
        if (!currentErrorLog) {
          const { errorLog } = await inquirer.prompt<{ errorLog: string }>([{
            type: 'editor',
            name: 'errorLog',
            message: 'Please paste your error log:',
            default: ''
          }]);
          currentErrorLog = errorLog;
          errorLogChanged = true;
        } else {
          const { updateErrorLog } = await inquirer.prompt<{ updateErrorLog: boolean }>([{
            type: 'confirm',
            name: 'updateErrorLog',
            message: 'Would you like to update the error log?',
            default: false
          }]);

          if (updateErrorLog) {
            const { errorLog } = await inquirer.prompt<{ errorLog: string }>([{
              type: 'editor',
              name: 'errorLog',
              message: 'Please paste your updated error log:',
              default: currentErrorLog
            }]);
            currentErrorLog = errorLog;
            errorLogChanged = true;
          }
        }

        const timestamp = new Date().toISOString();
        const message: ConversationMessage = {
          id: timestamp,
          role: 'user',
          content: command,
          timestamp: timestamp,
          files: currentFiles.map(f => f.name),
          errorLog: currentErrorLog,
          replyTo: lastMessageTimestamp,
          contextUpdate: {
            errorLogChanged
          }
        };

        // Save message immediately
        await conversationManager.addMessage(session.id, message);

        try {
          const response = await sendToLLM(
            currentFiles,
            currentErrorLog,
            command,
            options.saveContext,
            session // Pass the updated session with the new message
          );

          const assistantTimestamp = new Date().toISOString();
          const assistantMessage: ConversationMessage = {
            id: assistantTimestamp,
            role: 'assistant',
            content: response.answer,
            timestamp: assistantTimestamp,
            replyTo: timestamp
          };

          lastMessageTimestamp = assistantTimestamp;
          // Save assistant message immediately
          await conversationManager.addMessage(session.id, assistantMessage);
          displayFormattedResponse(response);

          // Ask if error is resolved
          const { isResolved } = await inquirer.prompt<{ isResolved: boolean }>([{
            type: 'confirm',
            name: 'isResolved',
            message: 'Has this error been resolved?',
            default: false
          }]);

          if (isResolved) {
            await conversationManager.markErrorAsResolved(
              session.id,
              currentErrorLog,
              [message, assistantMessage]
            );

            const resolutionTimestamp = new Date().toISOString();
            const resolutionMessage: ConversationMessage = {
              id: resolutionTimestamp,
              role: 'system',
              content: 'Error resolved',
              timestamp: resolutionTimestamp,
              replyTo: assistantTimestamp,
              isResolved: true
            };

            await conversationManager.addMessage(session.id, resolutionMessage);
            console.log(chalk.green('\nGreat! Error has been resolved.'));
            
            const { endSession } = await inquirer.prompt<{ endSession: boolean }>([{
              type: 'confirm',
              name: 'endSession',
              message: 'Would you like to end the session?',
              default: true
            }]);

            if (endSession) {
              session.endTime = new Date().toISOString();
              // Single final save
              await conversationManager.saveSession(session);
              console.log(chalk.blue('\nSession ended. Goodbye!'));
              break;
            }
            
            console.log(chalk.blue('\nContinuing session...'));
            continue;
          }

          // Continue with context update handling if error not resolved
          const { needMoreContext } = await inquirer.prompt<{ needMoreContext: boolean }>([{
            type: 'confirm',
            name: 'needMoreContext',
            message: 'Would you like to update the context (files/error log)?',
            default: false
          }]);

          if (needMoreContext) {
            const { keepExisting } = await inquirer.prompt<{ keepExisting: boolean }>([{
              type: 'confirm',
              name: 'keepExisting',
              message: 'Would you like to keep the existing files?',
              default: true
            }]);

            const existingFiles = [...currentFiles];

            const { fileSelection } = await inquirer.prompt<{ fileSelection: 'scan' | 'manual' }>([{
              type: 'list',
              name: 'fileSelection',
              message: 'How would you like to add more files?',
              choices: [
                { name: 'Scan current directory', value: 'scan' },
                { name: 'Add files manually', value: 'manual' }
              ]
            }]);

            currentFiles = await fileHandler.selectFiles(
              keepExisting ? currentFiles : [],
              fileSelection
            );

            const contextUpdateTimestamp = new Date().toISOString();
            const contextUpdateMessage: ConversationMessage = {
              id: contextUpdateTimestamp,
              role: 'system',
              content: 'Context updated',
              timestamp: contextUpdateTimestamp,
              replyTo: assistantTimestamp,
              contextUpdate: {
                addedFiles: currentFiles.slice(keepExisting ? existingFiles.length : 0).map(f => f.name),
                removedFiles: keepExisting ? [] : existingFiles.map(f => f.name)
              }
            };

            // Save context update message immediately
            await conversationManager.addMessage(session.id, contextUpdateMessage);
          }

        } catch (error) {
          const errorTimestamp = new Date().toISOString();
          const errorMessage: ConversationMessage = {
            id: errorTimestamp,
            role: 'system',
            content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: errorTimestamp,
            replyTo: timestamp
          };
          // Save error message immediately
          await conversationManager.addMessage(session.id, errorMessage);
        }
      }

      console.log(chalk.blue('\nSession ended. Goodbye!'));
    });

  program.parse();
}

// Execute
main().catch((error) => {
  console.error(chalk.red('Fatal Error:', error));
  process.exit(1);
});