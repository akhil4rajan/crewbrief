# Demo script

Start everything locally: `make setup && make ingest && make dev`, then open http://localhost:3000.

CrewBrief is one app for the crew. Whoever starts a briefing is the crew lead: they record it, answer
CrewBrief's closing questions, then review, sign off and submit the form. Everyone else on the crew can
open the same briefing to read the form and tap **I've read the form**.

The briefing has three steps, shown at the top of the screen: **Record → Clarify → Review & submit**.

1. Sign in as **Sam Taylor**.
2. **New briefing** → pick a demo scenario (it fills in the title, task type and location) → **Continue**.
3. Read the recording notice to the crew → **Start recording**.
4. **Record.** Tap the big red button to listen with the microphone, or open **Demo** → pick a speed
   (2× reads well on camera) → **Play script**. CrewBrief never interrupts: the form fills in quietly on
   the side, and the voices it hears show as chips ("Speaker 1", or a name once someone introduces
   themselves). In local mode the microphone falls back to the browser's speech recognition, then to
   typing (**Type instead**). **Upload a recording instead** needs Azure AI Speech; locally it explains
   that it isn't available.
5. **End briefing.** CrewBrief checks the form for anything critical that wasn't covered.
   - Nothing critical missing: it goes straight to **Review & submit**.
   - Otherwise **Clarify** lists up to three questions and reads each one out once. Hold the button to
     answer out loud, or type the answer. Each question turns to **✓ Answered** as the form picks the
     answer up. Tap **Done** when finished; anything unanswered is left for review.
6. **Review & submit**, top to bottom:
   - **Needs your decision**: open gaps, with **Not applicable** / **Confirm present** for hazards that
     are typical for the job, and **Dismiss** (with a reason) for the rest.
   - **Hazards & controls**: sorted by severity. Controls the crew stated are shown; the hazard library's
     suggestions are folded away underneath.
   - **Job & emergency**, then **Crew & speakers**, where you can name each separated voice
     ("Speaker 2 is Priya").
   - **Transcript** opens on the right. Click any quote under a field to jump to that line.
   - **More** has the audit log, the AI draft vs final diff, **Resume briefing** and **Abandon**.
   - **Sign off** (blocking gaps must be settled, or overridden with a written reason), then **Submit**.

| Scenario | What it shows |
|---|---|
| LV service connection, Penrith | Live LV work with PPE only, then the crew states the isolation plan later in the briefing, so the critical gap usually closes before the end and it goes straight to review. Footy chat is ignored. |
| Pole replacement with crane, Scoresby | A well-run briefing: HV under access permit, crane near live LV with spotter and covers, traffic barriers, wind stop limit. Many hazards with evidence. |
| Storm restoration at night, Kiama | Conductors down at night with a tired crew. Critical gaps stay open, so **Clarify** asks about them. Type an answer such as "We'll pull the service fuses, test before touch and earth it", then **Done**. |

## Show the AI agents

- **While recording:** the "AI at work" strip under the steps shows the agent pipeline (Analyst → Hazard expert → Form filler → Verifier). The running agent is highlighted, with a one-line summary of what it just found.
- **After the briefing:** on the review page, open **More → How CrewBrief built this form**. It's a timeline of every agent run: what it did, which model and prompt version it used, and how long it took.
- **Real LLMs on camera:** put your Azure OpenAI endpoint and key in `.env.local` and set `LLM_PROVIDER=azure`. The timeline then shows "Azure OpenAI · <deployment>". Offline, the same agents run as rule-based stand-ins and are labelled "Rule-based (offline)".
