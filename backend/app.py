"""Interview Partner backend.

Two jobs, so the desktop client never holds a real provider key:
  GET  /api/stt-token  -> short-lived AssemblyAI streaming token + the websocket URL to use
  POST /api/chat       -> streams the interviewer's next turn (or the final report) over SSE
"""

import json
import logging
import os
from typing import Literal
from urllib.parse import urlencode

import anthropic
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import prompts

load_dotenv()
log = logging.getLogger("interview-partner")

MODEL = os.getenv("INTERVIEW_MODEL", "claude-opus-5-5")
# Interview turns are conversational, so they run at low effort for latency;
# the end-of-session report is worth more thought.
TURN_EFFORT = os.getenv("INTERVIEW_TURN_EFFORT", "low")
REPORT_EFFORT = os.getenv("INTERVIEW_REPORT_EFFORT", "medium")
ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY", "")
ASSEMBLYAI_SPEECH_MODEL = os.getenv("ASSEMBLYAI_SPEECH_MODEL", "universal-3-6-pro")
STT_SAMPLE_RATE = 16000

# Keys that aren't scoped to a workspace must name one on every request.
ANTHROPIC_WORKSPACE_ID = os.getenv("ANTHROPIC_WORKSPACE_ID", "")
client = anthropic.AsyncAnthropic(
    default_headers={"anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID} if ANTHROPIC_WORKSPACE_ID else None
)
app = FastAPI(title="Interview Partner")

# The Electron renderer is loaded from file://, which sends Origin: null.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null", "http://localhost", "http://127.0.0.1"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class Turn(BaseModel):
    role: Literal["interviewer", "candidate"]
    text: str = Field(min_length=1, max_length=20_000)


class ChatRequest(BaseModel):
    resume: str = Field(min_length=1, max_length=60_000)
    job_description: str = Field(min_length=1, max_length=60_000)
    role: str | None = Field(default=None, max_length=200)
    history: list[Turn] = Field(default_factory=list, max_length=200)
    action: Literal["next", "report"] = "next"


@app.get("/api/health")
async def health():
    return {"ok": True, "model": MODEL, "stt": bool(ASSEMBLYAI_API_KEY)}


@app.get("/api/stt-token")
async def stt_token():
    if not ASSEMBLYAI_API_KEY:
        raise HTTPException(503, "Speech-to-text is not configured (set ASSEMBLYAI_API_KEY).")
    async with httpx.AsyncClient(timeout=10) as http:
        resp = await http.get(
            "https://streaming.assemblyai.com/v3/token",
            params={"expires_in_seconds": 60, "max_session_duration_seconds": 3600},
            headers={"Authorization": ASSEMBLYAI_API_KEY},
        )
    if resp.status_code != 200:
        log.warning("AssemblyAI token request failed: %s %s", resp.status_code, resp.text)
        raise HTTPException(502, "Could not get a speech-to-text token.")
    token = resp.json()["token"]
    query = urlencode(
        {
            "sample_rate": STT_SAMPLE_RATE,
            "encoding": "pcm_s16le",
            "speech_model": ASSEMBLYAI_SPEECH_MODEL,
            "token": token,
        }
    )
    return {
        "provider": "assemblyai",
        "sample_rate": STT_SAMPLE_RATE,
        "ws_url": f"wss://streaming.assemblyai.com/v3/ws?{query}",
    }


def build_messages(req: ChatRequest) -> list[dict]:
    """Map the transcript onto Claude turns: interviewer -> assistant, candidate -> user.

    The list is append-only from one request to the next, so the cached prefix keeps hitting.
    """
    messages: list[dict] = [{"role": "user", "content": prompts.START_MESSAGE}]
    expected = "interviewer"
    for turn in req.history:
        if turn.role != expected:
            raise HTTPException(422, "History must alternate, starting with the interviewer.")
        messages.append(
            {"role": "assistant" if turn.role == "interviewer" else "user", "content": turn.text}
        )
        expected = "candidate" if expected == "interviewer" else "interviewer"

    if req.action == "next":
        if messages[-1]["role"] != "user":
            raise HTTPException(422, "Waiting for the candidate's answer before the next question.")
    else:
        if messages[-1]["role"] == "assistant":
            messages.append({"role": "user", "content": "Let's stop the interview here."})
        # Operator instruction appended mid-conversation instead of editing the system
        # prompt, so the cached prefix stays intact.
        messages.append({"role": "system", "content": prompts.REPORT_INSTRUCTIONS})
    return messages


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@app.post("/api/chat")
async def chat(req: ChatRequest):
    messages = build_messages(req)
    system = [
        {"type": "text", "text": prompts.INTERVIEWER_INSTRUCTIONS},
        {
            "type": "text",
            "text": prompts.candidate_context(req.resume, req.job_description, req.role),
            # Resume + JD are identical on every turn of a session: cache them.
            "cache_control": {"type": "ephemeral"},
        },
    ]
    effort = REPORT_EFFORT if req.action == "report" else TURN_EFFORT

    async def events():
        try:
            async with client.beta.messages.stream(
                model=MODEL,
                max_tokens=16000,
                system=system,
                messages=messages,
                # Also cache the growing transcript up to the latest turn.
                cache_control={"type": "ephemeral"},
                output_config={"effort": effort},
                betas=["server-side-fallback-2026-07-01"],
                extra_body={"fallbacks": "default"},
            ) as stream:
                async for text in stream.text_stream:
                    yield sse({"type": "text", "text": text})
                final = await stream.get_final_message()
            if final.stop_reason == "refusal":
                yield sse({"type": "error", "message": "The model declined to answer this turn."})
                return
            u = final.usage
            log.info(
                "turn done: in=%s cache_read=%s cache_write=%s out=%s",
                u.input_tokens,
                u.cache_read_input_tokens,
                u.cache_creation_input_tokens,
                u.output_tokens,
            )
            yield sse({"type": "done", "stop_reason": final.stop_reason})
        except anthropic.RateLimitError:
            yield sse({"type": "error", "message": "Rate limited by the model API. Try again shortly."})
        except anthropic.APIStatusError as e:
            log.exception("Claude API error")
            yield sse({"type": "error", "message": f"Model API error ({e.status_code})."})
        except anthropic.APIConnectionError:
            yield sse({"type": "error", "message": "Could not reach the model API."})
        except Exception:
            # e.g. no Anthropic credentials configured; keep the stream well-formed.
            log.exception("Interviewer turn failed")
            yield sse({"type": "error", "message": "The backend could not run this turn (check its log)."})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8787")))
