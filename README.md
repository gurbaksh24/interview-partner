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

## Setup (once)

Backend (Python 3.11+):

```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
cp .env.example .env
```

Then edit `backend/.env` (never `.env.example`, which is committed to git):

- `ANTHROPIC_API_KEY`: required.
- `ANTHROPIC_WORKSPACE_ID`: only if your key isn't scoped to a workspace. Requests fail with a 400
  that says so; the ID (`wrkspc_…`) is under Settings → Workspaces in the Claude Console.
- `ASSEMBLYAI_API_KEY`: optional. Without it the app still works; Record is disabled and you type
  your answers.

Desktop app (Node 20+):

```bash
cd desktop
npm install
npm install-scripts approve electron   # npm 12+ blocks Electron's binary download by default
```

## Run it

```bash
cd desktop
npm start
```

The app starts the backend for you if it isn't already running, and stops it again when you quit.
Its output goes to `backend.log` in the app's data folder (`%APPDATA%\Interview Partner` on
Windows). To watch the backend's logs live, run it yourself first and the app will use that one:

```bash
cd backend
.venv/Scripts/python app.py   # http://127.0.0.1:8787
```

Set `INTERVIEW_AUTOSTART_BACKEND=0` to turn auto-start off, or `INTERVIEW_BACKEND_URL` to use a
backend elsewhere (auto-start only applies to a local URL).

Package a Windows build with `npm run dist` (or `npm run pack` for an unpacked folder).

## Using it

1. Paste (or load from a `.txt`/`.md` file) your resume and the job description, optionally a role.
2. Pick your microphone in the dropdown next to **Record** (remembered between sessions).
3. **Record**, answer out loud, **Stop**. Edit the transcript if needed, then **Ctrl+Enter**.
4. Read the feedback, answer the next question. **End & get report** when you're done.

## Troubleshooting

- **"Waiting for backend…" doesn't go away.** Check `backend.log` (see above). The usual causes
  are a missing `backend/.venv` (run the setup) or a missing or wrong key in `backend/.env`.
- **Recording shows nothing.** Watch the level meter next to the microphone dropdown while you
  speak. If it doesn't move, pick another microphone. Virtual mics such as Camo send pure silence
  when their phone app isn't connected, and the app warns about that after 2 seconds.
- **"Model API error (400)".** The backend log has the API's reason. A key that isn't scoped to a
  workspace needs `ANTHROPIC_WORKSPACE_ID`.

## Configuration (`backend/.env`)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_WORKSPACE_ID` | (unset) | Only for keys not scoped to a workspace |
| `INTERVIEW_MODEL` | `claude-opus-5-5` | |
| `INTERVIEW_TURN_EFFORT` | `low` | Interview turns favour latency |
| `INTERVIEW_REPORT_EFFORT` | `medium` | The final report gets more thought |
| `ASSEMBLYAI_SPEECH_MODEL` | `universal-3-6-pro` | |
| `PORT` | `8787` | |

Model requests opt into server-side refusal fallbacks (`fallbacks: "default"`).

## Roadmap

- Phase 2: PDF resume upload, per-answer timing, saved session history.
- Phase 3: auth and per-minute usage metering, question banks per role, progress across sessions.
