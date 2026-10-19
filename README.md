# Interview Partner

Practice job interviews out loud. Claude plays the interviewer using your resume and the job
description, listens to your spoken answers (streaming speech-to-text), coaches you after each
answer, and writes an end-of-session report.

```
desktop/  Electron app: setup screen, interview chat, mic capture -> 16 kHz PCM -> STT websocket
backend/  FastAPI: mints short-lived STT tokens, streams Claude's turns over SSE
```

## How it works

- **Thin client.** The desktop app sends the resume, job description and transcript to
  `POST /api/chat`; the backend owns the prompts and the model and streams the reply back as SSE.
  Prompts live in `backend/prompts.py` and change without a new desktop build.
- **No provider keys in the client.** `GET /api/stt-token` returns a 60-second AssemblyAI
  streaming token plus the websocket URL; the Anthropic key never leaves the backend.
- **Prompt caching.** Instructions, then resume + job description, form a cached system prefix;
  the transcript is append-only so each turn reuses the cache. Cache hits are logged per turn.
- **Reply format.** Each interviewer turn is `[FEEDBACK]` (coaching on your last answer) and
  `[QUESTION]` (the next question, read aloud with the system voice if enabled).
- **Hardened Electron.** `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict CSP,
  allowlisted IPC with sender-frame checks, mic-only permissions, navigation blocked, and the
  packaged binary's fuses flipped (RunAsNode, `NODE_OPTIONS`, `--inspect` off; ASAR integrity on).

## Run it

Backend (Python 3.11+):

```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
cp .env.example .env   # add ANTHROPIC_API_KEY, and ASSEMBLYAI_API_KEY for voice
.venv/Scripts/python app.py   # http://127.0.0.1:8787
```

Desktop app (Node 20+):

```bash
cd desktop
npm install
npm install-scripts approve electron   # npm 12+ blocks Electron's binary download by default
npm start
```

Without `ASSEMBLYAI_API_KEY` the app still works; Record is disabled and you type your answers.
Point the app at another backend with `INTERVIEW_BACKEND_URL`.

Package a Windows build with `npm run dist` (or `npm run pack` for an unpacked folder).

## Using it

1. Paste (or load from a `.txt`/`.md` file) your resume and the job description, optionally a role.
2. **Record**, answer out loud, **Stop**. Edit the transcript if needed, then **Ctrl+Enter**.
3. Read the feedback, answer the next question. **End & get report** when you're done.

## Configuration (`backend/.env`)

| Variable | Default | |
|---|---|---|
| `INTERVIEW_MODEL` | `claude-opus-5-5` | |
| `INTERVIEW_TURN_EFFORT` | `low` | Interview turns favour latency |
| `INTERVIEW_REPORT_EFFORT` | `medium` | The final report gets more thought |
| `ASSEMBLYAI_SPEECH_MODEL` | `universal-3-6-pro` | |
| `PORT` | `8787` | |

Model requests opt into server-side refusal fallbacks (`fallbacks: "default"`).

## Roadmap

- Phase 2: PDF resume upload, per-answer timing, saved session history.
- Phase 3: auth and per-minute usage metering, question banks per role, progress across sessions.
