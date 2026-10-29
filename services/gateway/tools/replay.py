"""Replay a scripted (or recorded) briefing through the real stack, end to end.

    python -m services.gateway.tools.replay --script samples/briefing_01.json --speed 4
    python -m services.gateway.tools.replay --script samples/briefing_01.json --audio briefing.wav  # azure STT

Creates a session via the form API (unless ``--session-id``), checks the crew in, starts it,
streams the briefing over the device WebSocket in (real time / speed), prints live events
(form patches, gaps, voice prompts) and finally the drafted form once the session reaches
REVIEW.

Script format::

    {"title", "task_type", "location", "crew": ["u-crew-1", ...],
     "lines": [{"speaker": "u-crew-1", "text": "...", "at_ms": 0}, ...]}
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import sys
import time
import wave
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from packages.common.config import get_settings

WPS_SUBPROTOCOL = "json.webpubsub.azure.v1"
AUDIO_CHUNK_MS = 100
PING_EVERY_S = 20.0
WORDS_PER_SECOND = 2.6


def _short(value: Any, limit: int = 70) -> str:
    if isinstance(value, dict):
        if "name" in value:
            extra = [str(value[k]) for k in ("status", "severity") if value.get(k)]
            text = f"{value['name']} ({', '.join(extra)})" if extra else str(value["name"])
        elif "value" in value:
            text = str(value["value"])
        elif "description" in value:
            text = str(value["description"])
        else:
            text = json.dumps(value)
    else:
        text = str(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


class Console:
    """Concise, line-per-event console output."""

    def __init__(self, verbose: bool):
        self.verbose = verbose
        self.t0 = time.monotonic()
        self.open_gaps: dict[str, dict[str, Any]] = {}
        self.review = asyncio.Event()
        self.ready = asyncio.Event()
        self.stt_unavailable = asyncio.Event()

    def out(self, tag: str, text: str) -> None:
        print(f"{time.monotonic() - self.t0:6.1f}s [{tag:<7}] {text}", flush=True)

    def event(self, msg: dict[str, Any]) -> None:
        kind, payload = msg.get("type"), msg.get("payload") or {}
        if kind == "ready":
            self.ready.set()
            self.out("ready", f"device stream ready ({msg.get('mode')} mode)")
        elif kind == "pong":
            pass
        elif kind == "form.patched":
            for p in payload.get("patches", []):
                self.out("form", f"r{payload.get('revision')} {p['op']} {p['path']} = {_short(p.get('value'))}")
        elif kind == "gaps.updated":
            self._gaps(payload.get("gaps", []))
        elif kind == "voice.prompt":
            self.out("VOICE", f">> {payload.get('text')}")
        elif kind == "session.state_changed":
            self.out("state", f"{payload.get('from')} -> {payload.get('to')}"
                              + (f" ({payload['reason']})" if payload.get("reason") else ""))
            if payload.get("to") == "REVIEW":
                self.review.set()
        elif kind == "recording.changed":
            self.out("rec", str(payload.get("recording")))
        elif kind == "transcript.segment":
            notes = [f"filtered: {payload.get('filter_reason')}"] if payload.get("filtered") else []
            if payload.get("redacted"):
                notes.append(f"PII redacted -> {payload.get('text')!r}")
            if notes or self.verbose:
                who = payload.get("speaker_name") or payload.get("speaker_id")
                self.out("stored", f"#{payload.get('seq')} {who}: " + ("; ".join(notes) or _short(payload.get('text'))))
        elif kind == "error":
            code = payload.get("code")
            self.out("ERROR", f"{code}: {payload.get('message')}")
            if code == "stt_unavailable_local":
                self.stt_unavailable.set()
        elif self.verbose:
            self.out(str(kind)[:7], _short(payload, 100))

    def _gaps(self, gaps: list[dict[str, Any]]) -> None:
        current = {g["id"]: g for g in gaps if g.get("status") == "open"}
        for gid, g in current.items():
            if gid not in self.open_gaps:
                self.out("gap+", f"[{g['severity']}] {g['message']}")
        for gid, g in self.open_gaps.items():
            if gid not in current:
                self.out("gap-", f"closed: {g['message']}")
        self.open_gaps = current


# --- form API helpers ----------------------------------------------------------------------


async def _token(api: httpx.AsyncClient, user_id: str) -> str:
    resp = await api.post("/api/auth/dev-token", json={"user_id": user_id})
    resp.raise_for_status()
    return resp.json()["access_token"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _prepare_session(api: httpx.AsyncClient, script: dict[str, Any], token: str, session_id: str | None,
                           console: Console) -> str:
    if session_id is None:
        body = {"title": script["title"], "task_type": script.get("task_type"),
                "location": script.get("location"), "crew_member_ids": script.get("crew", [])}
        resp = await api.post("/api/sessions", json=body, headers=_bearer(token))
        resp.raise_for_status()
        session_id = resp.json()["session"]["id"]
        console.out("session", f"created {session_id}: {script['title']}")
    resp = await api.get(f"/api/sessions/{session_id}", headers=_bearer(token))
    resp.raise_for_status()
    if resp.json()["session"]["state"] != "CREATED":
        return session_id
    for user_id in script.get("crew", []):
        crew_token = await _token(api, user_id)
        for step in ("check-in", "consent"):
            r = await api.post(f"/api/sessions/{session_id}/{step}", json={} if step == "check-in" else None,
                               headers=_bearer(crew_token))
            if r.is_error:
                console.out("warn", f"{step} {user_id}: HTTP {r.status_code} {r.text[:120]}")
    console.out("session", f"checked in {', '.join(script.get('crew', [])) or 'nobody'}")
    resp = await api.post(f"/api/sessions/{session_id}/start", headers=_bearer(token))
    resp.raise_for_status()
    return session_id


# --- streaming -------------------------------------------------------------------------------


async def _receive(ws: ClientConnection, console: Console, *, webpubsub: bool = False) -> None:
    with contextlib.suppress(ConnectionClosed):
        async for raw in ws:
            if isinstance(raw, bytes):
                continue
            msg = json.loads(raw)
            if webpubsub:  # Web PubSub JSON subprotocol wraps server messages
                if msg.get("type") != "message":
                    continue
                msg = msg.get("data") if isinstance(msg.get("data"), dict) else json.loads(msg.get("data") or "{}")
            console.event(msg)


async def _pinger(ws: ClientConnection) -> None:
    with contextlib.suppress(ConnectionClosed):
        while True:
            await asyncio.sleep(PING_EVERY_S)
            await ws.send(json.dumps({"type": "ping"}))


async def _stream_text(ws: ClientConnection, script: dict[str, Any], speed: float, console: Console) -> None:
    lines = sorted(script["lines"], key=lambda ln: ln["at_ms"])
    start = time.monotonic()
    for i, line in enumerate(lines):
        await asyncio.sleep(max(0.0, start + line["at_ms"] / 1000 / speed - time.monotonic()))
        words = len(line["text"].split())
        nxt = lines[i + 1]["at_ms"] if i + 1 < len(lines) else line["at_ms"] + 5000
        end_ms = min(nxt, line["at_ms"] + int(words / WORDS_PER_SECOND * 1000))
        await ws.send(json.dumps({"type": "transcript", "text": line["text"], "speaker_user_id": line["speaker"],
                                  "confidence": line.get("confidence", 0.93), "start_ms": line["at_ms"],
                                  "end_ms": end_ms}))
        console.out("said", f"{line['speaker']}: {_short(line['text'], 90)}")


async def _stream_audio(ws: ClientConnection, path: Path, speed: float, console: Console) -> bool:
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() not in (8000, 16000):
            raise SystemExit("WAV must be mono PCM16 at 16 kHz (or 8 kHz)")
        rate = wav.getframerate()
        await ws.send(json.dumps({"type": "start", "mode": "audio", "sample_rate": rate, "encoding": "pcm16",
                                  "device_id": "replay-tool"}))
        await asyncio.wait_for(console.ready.wait(), timeout=10)
        frames_per_chunk = rate * AUDIO_CHUNK_MS // 1000
        start, sent_ms = time.monotonic(), 0
        while chunk := wav.readframes(frames_per_chunk):
            if console.stt_unavailable.is_set():
                console.out("audio", "gateway cannot transcribe audio in local mode; use text replay instead")
                return False
            await ws.send(chunk)
            sent_ms += AUDIO_CHUNK_MS
            await asyncio.sleep(max(0.0, start + sent_ms / 1000 / speed - time.monotonic()))
    console.out("audio", f"streamed {sent_ms / 1000:.1f}s of audio")
    return True


# --- summary -----------------------------------------------------------------------------------


def _print_summary(detail: dict[str, Any]) -> None:
    session, draft, gaps = detail["session"], detail["draft"], detail.get("gaps", [])
    form = draft["form"]

    def fv(node: dict[str, Any] | None) -> str:
        return str(node["value"]) if node and node.get("value") not in (None, "") else "-"

    print("\n" + "=" * 78)
    print(f"Draft for {session['id']}  state={session['state']}  revision={draft['revision']}  "
          f"segments={detail.get('transcript_count')}")
    print("=" * 78)
    job = form.get("job", {})
    for key in ("title", "location", "work_order_id", "task_type", "description"):
        if job.get(key):
            print(f"{key:>15}: {fv(job[key])}")
    print(f"{'crew':>15}: {', '.join(c['name'] for c in form.get('crew', {}).values()) or '-'}")
    for task in sorted(form.get("tasks", {}).values(), key=lambda t: t["order"]):
        print(f"{'task ' + str(task['order']):>15}: {_short(task['description'], 90)}")
    for sc in form.get("site_conditions", {}).values():
        print(f"{'site':>15}: {_short(sc['description'], 90)}")
    print(f"\nHazards ({len(form.get('hazards', {}))}):")
    for code, h in form.get("hazards", {}).items():
        conf = h.get("provenance", {}).get("confidence", 0)
        print(f"  [{h['severity']:<8}] {h['name']} ({code}) {h['status']}/{h['origin']} conf={conf:.2f}")
        for ccode, c in h.get("controls", {}).items():
            print(f"      - {c['name']} ({ccode}, {c['type']}, {c['status']})")
    if form.get("ppe"):
        print(f"\nPPE: {', '.join(p['name'] for p in form['ppe'].values())}")
    em = form.get("emergency", {})
    print(f"\nEmergency: muster={fv(em.get('muster_point'))} | hospital={fv(em.get('nearest_hospital'))} | "
          f"first aider={fv(em.get('first_aider'))} | comms={fv(em.get('communications'))}")
    open_gaps = [g for g in gaps if g["status"] == "open"]
    print(f"\nGaps: {len(open_gaps)} open of {len(gaps)}")
    for g in sorted(open_gaps, key=lambda g: ("blocking", "warning", "info").index(g["severity"])):
        asked = " (asked)" if g.get("asked_at") else ""
        print(f"  [{g['severity']:<8}] {g['message']}{asked}")
    print("=" * 78)


# --- main ----------------------------------------------------------------------------------------


async def run(args: argparse.Namespace, script: dict[str, Any]) -> int:
    settings = get_settings()
    console = Console(args.verbose)
    async with httpx.AsyncClient(base_url=args.form_api, timeout=20.0) as api:
        token = await _token(api, args.user)
        session_id = await _prepare_session(api, script, token, args.session_id, console)

        tasks: list[asyncio.Task[None]] = []
        live: ClientConnection | None = None
        device_url = f"{args.gateway_ws.rstrip('/')}/ws/device/{session_id}?access_token={quote(token, safe='')}"
        async with connect(device_url, max_size=2**20) as ws:
            tasks.append(asyncio.create_task(_receive(ws, console)))
            tasks.append(asyncio.create_task(_pinger(ws)))
            if settings.provider("pubsub").value == "azure":  # live events come from Web PubSub, not the gateway
                neg = await api.get(f"{args.gateway_http.rstrip('/')}/api/sessions/{session_id}/negotiate",
                                    headers=_bearer(token))
                neg.raise_for_status()
                live = await connect(neg.json()["url"], subprotocols=[WPS_SUBPROTOCOL])  # type: ignore[list-item]
                tasks.append(asyncio.create_task(_receive(live, console, webpubsub=True)))

            if args.audio:
                if not await _stream_audio(ws, Path(args.audio), args.speed, console):
                    return 2
            else:
                await ws.send(json.dumps({"type": "start", "mode": "text", "device_id": "replay-tool"}))
                await asyncio.wait_for(console.ready.wait(), timeout=10)
                await _stream_text(ws, script, args.speed, console)

            ended_at = time.monotonic()
            await ws.send(json.dumps({"type": "end"}))
            console.out("end", "briefing ended; waiting for final extraction + verification")
            try:
                await asyncio.wait_for(_wait_review(api, session_id, token, console), timeout=args.timeout)
                console.out("review", f"draft ready for supervisor review in {time.monotonic() - ended_at:.1f}s")
            except TimeoutError:
                console.out("ERROR", f"session did not reach REVIEW within {args.timeout:.0f}s")
            for task in tasks:
                task.cancel()
            if live is not None:
                await live.close()

        resp = await api.get(f"/api/sessions/{session_id}", headers=_bearer(token))
        resp.raise_for_status()
        _print_summary(resp.json())
        return 0 if resp.json()["session"]["state"] == "REVIEW" else 1


async def _wait_review(api: httpx.AsyncClient, session_id: str, token: str, console: Console) -> None:
    """Wait for the REVIEW event, polling as a fallback in case a live event was missed."""
    while not console.review.is_set():
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(console.review.wait(), timeout=3.0)
        if console.review.is_set():
            return
        resp = await api.get(f"/api/sessions/{session_id}", headers=_bearer(token))
        if resp.is_success and resp.json()["session"]["state"] == "REVIEW":
            return


def main(argv: list[str] | None = None) -> int:
    s = get_settings()
    parser = argparse.ArgumentParser(prog="python -m services.gateway.tools.replay", description=__doc__.split("\n")[0])
    parser.add_argument("--script", required=True, help="briefing JSON (title, crew, lines)")
    parser.add_argument("--audio", help="mono PCM16 16 kHz WAV to stream in audio mode (azure STT only)")
    parser.add_argument("--session-id", help="use an existing session instead of creating one")
    parser.add_argument("--speed", type=float, default=1.0, help="playback speed multiplier (default 1 = real time)")
    parser.add_argument("--user", default="u-crew-1", help="user id streaming from the device (default u-crew-1)")
    parser.add_argument("--form-api", default=s.form_api_url)
    parser.add_argument("--gateway-ws", default=s.public_gateway_ws_url)
    parser.add_argument("--gateway-http", default=s.gateway_url)
    parser.add_argument("--timeout", type=float, default=120.0, help="seconds to wait for REVIEW after end")
    parser.add_argument("-v", "--verbose", action="store_true", help="print every event")
    args = parser.parse_args(argv)
    if args.speed <= 0:
        parser.error("--speed must be > 0")
    script = json.loads(Path(args.script).read_text(encoding="utf-8"))
    if not script.get("lines") and not args.audio:
        parser.error("script has no lines")
    try:
        return asyncio.run(run(args, script))
    except httpx.HTTPStatusError as exc:
        print(f"HTTP {exc.response.status_code} from {exc.request.url}: {exc.response.text[:300]}", file=sys.stderr)
        return 1
    except (OSError, ConnectionClosed) as exc:
        print(f"Connection failed: {exc}. Are the gateway, orchestrator and form API running?", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
