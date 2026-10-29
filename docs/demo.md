# Demo script

Start everything locally: `make setup && make ingest && make dev`, then open http://localhost:3000.

For each scenario (all tested end to end):

1. Landing page → **I'm on the crew** → **Sam Taylor**.
2. **Start a new briefing** → pick a demo scenario → **Start briefing →**.
3. **Tap in everyone** → **Acknowledge** the recording notice → **Start briefing**.
4. Pick a speed (2× reads well on camera) → **Play demo script**. Watch the hazards, emergency plan and transcript fill in live; CrewBrief speaks its question in the prompt card.
5. **End briefing** → crew review → **I've read the form**.
6. **Supervisor view ↗** (or Sign out → **Alex Morgan**) → open the briefing → review evidence and gaps → **Sign off** (override blocking gaps with a justification) → **Submit**.

| Scenario | What it shows |
|---|---|
| LV service connection, Penrith | Live LV with PPE only → CrewBrief asks about isolation → the crew answers → the gap closes ("✓ Answered"). Footy chat is ignored. |
| Pole replacement with crane, Scoresby | A well-run briefing: HV under access permit, crane near live LV with spotter and covers, traffic barriers, wind stop limit. Many hazards with evidence. |
| Storm restoration at night, Kiama | Conductors down at night, a fatigued crew: fatigue and night-work hazards, gaps the supervisor must resolve before sign-off. |
