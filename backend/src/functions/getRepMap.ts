import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import ora from 'ora'; // For spinner logging internally
import cliProgress from 'cli-progress'; // For progress bar (for internal logging)
import ignore from 'ignore';
import RepoMap from '../utils/repomap';
import { GSContext } from "@godspeedsystems/core";

function scanFolder(folderPath: string): string[] {
  const ig = ignore();
  const gitignorePath = path.join(folderPath, '.gitignore');

  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    ig.add(gitignoreContent);
  }

  const files: string[] = [];
  const allowedExtensions = ['.ts', '.js', '.py', '.java', '.go', '.rb', '.php', '.cpp', '.c', '.h'];

  function scan(dir: string) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const itemPath = path.join(dir, item);
      const relativePath = path.relative(folderPath, itemPath);

      if (ig.ignores(relativePath)) continue;

      const stat = fs.statSync(itemPath);
      if (stat.isDirectory()) {
        scan(itemPath);
      } else if (stat.isFile()) {
        const ext = path.extname(itemPath).toLowerCase();
        if (allowedExtensions.includes(ext)) {
          files.push(itemPath);
        }
      }
    }
  }

  scan(folderPath);
  return files;
}

async function generateRepoMapFromGitUrl(gitUrl: string): Promise<any> {
  const spinner = ora('Preparing repository...').start();
  // Create a temporary directory for cloning the repository.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));

  try {
    // Clone the repository
    spinner.text = 'Cloning repository...';
    execSync(`git clone ${gitUrl} ${tempDir}`, { stdio: 'pipe' });
    spinner.succeed('Repository cloned');

    // Use a progress bar for internal progress updates.
    const progressBar = new cliProgress.SingleBar({
      format: 'Generating repo map [{bar}] {percentage}%',
      barCompleteChar: '=',
      barIncompleteChar: ' ',
    });
    progressBar.start(100, 0);

    // Capture and redirect console.log to update progress bar.
    const originalLog = console.log;
    console.log = (...args) => {
      const msg = args[0]?.toString() || '';
      // Update progress bar on specific log messages.
      if (msg.includes('Parsing code...')) {
        progressBar.increment(10);
      }
      originalLog(...args);
    };

    const testConfig = {
      maxMapTokens: 1024,
      mapMultiplierNoFiles: 8,
      maxContextWindow: 8192
    };

    const repoMap = new RepoMap({
      root: tempDir,
      map_tokens: testConfig.maxMapTokens,
      verbose: false,
    });

    const files = scanFolder(tempDir);

    // Generate the repository map.
    const map = await repoMap.get_repo_map([], files, new Set(), new Set());

    // Restore original console.log and end progress bar.
    console.log = originalLog;
    progressBar.stop();

    // Parse the generated map if possible.
    let mapObj;
    try {
      mapObj = JSON.parse(map);
    } catch {
      mapObj = map;
    }
    return mapObj;
  } catch (error) {
    spinner.fail('Error generating repo map');
    throw error;
  } finally {
    // Clean up the temporary repository folder.
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Godspeed API function to generate a repository map from a git URL.
 * The function expects the request body to contain a gitUrl property.
 */
export default async function (ctx: GSContext, args: any) {
  try {
    const { inputs: { data: { body } } } = ctx;
    const { gitUrl } = body;
    if (!gitUrl || typeof gitUrl !== "string") {
      throw new Error("gitUrl parameter is required in the request body");
    }
    
    // Debug logging (can be replaced with a proper logger)
    console.log('Received gitUrl:', gitUrl);
    
    const repoMapResult = await generateRepoMapFromGitUrl(gitUrl);
    
    return {
      repoMap: repoMapResult
    };
  } catch (error: any) {
    console.error("Error generating repository map:", error);
    throw error;
  }
}