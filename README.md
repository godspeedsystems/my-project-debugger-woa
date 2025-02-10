# My Project Debugger

A CLI tool for analyzing code and errors using LLM (Language Model) capabilities, with a Godspeed backend for handling LLM integration.

## Features

- Analyze code and error logs with AI assistance.
- Interactive chat sessions for real-time debugging.
- Continue previous sessions to maintain conversation history.
- Automated repomap generation for project context.
- Save and load analysis context for future reference.

## CLI Options

The CLI supports various options for its commands. For example:

### General Options
```sh
# Specify a directory to work in and continue an existing session
code-help --chat --directory /path/to/project --continue
```


## Project Structure

- `frontend/` - CLI application written in TypeScript.
- `backend/` - Godspeed server with LLM integration.

## Setup

### Backend Setup

1. Navigate to the backend directory:
```sh
cd backend
npm install 
godspeed serve
```

2. Ensure you have `tokenjs.yaml` configured for your datasource.

3. Configure your LLM settings as per token.js docs:
```yaml
type: tokenjs
config:
  provider: "your-provider"
  model: "your-model"
```

_For example, using an ollama model:_

```
type: tokenjs
config:
  provider: openai-compatible
  baseURL: http://localhost:11434/v1
  models:
    - name: <model_name>
      config:
        temperature: 0.7
        max_tokens: 1000
```

For more details, refer to the tokenjs docs: https://docs.tokenjs.ai/providers

### Frontend Setup

1. Navigate to the frontend directory:
```sh
cd frontend
npm install
npm run build
```

2. Launch the CLI tool:
```sh
code-help
```

## Data Storage

All session history and project context are automatically saved under the `.superdebugger` folder in your specified directory.

## Backend Routes

The backend exposes the following routes:


- **POST /api/code/context**  
  Processes code analysis with LLM.  
  _Request Body:_
  ```json
  {
    "analysisContext": {
      "files": [
        { "name": "file.ts", "content": "file content" }
      ],
      "errorLog": "Full error log here",
      "projectContext": "Formatted project context",
      "timestamp": "ISO8601 timestamp"
    },
    "prompt": "User question"
  }
  ```
  _Responses:_  
  200 - Returns answer, model and usage stats  
  400 - Invalid request  
  503 - Service unavailable

- **POST /repomap**  
  Generates a repository map based on the provided Git repository URL.  
  _Request Body:_
  ```json
  {
    "gitUrl": "https://github.com/example/repo.git"
  }
  ```
  _Response:_  
  Returns a structured repo map.

## Credits

Repomap functionality is based on a pagerank algorithm. Special thanks to [Paul Gauthier Aider-AI](https://github.com/Aider-AI/aider) for his python code, which was ported to TypeScript for this project.


