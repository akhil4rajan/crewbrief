# CrewBrief crew app (Expo / React Native)

The crew uses this app in the truck. They sign in, start a briefing, tap in, acknowledge the recording notice and record the briefing. The draft hazard form fills in live. When they finish, the app shows the read-only review and the supervisor's sign-off.

## Run

```bash
cd apps/mobile
npm install
npm run web        # http://localhost:8081 (react-native-web)
npm start          # Expo dev server; press i / a for iOS / Android
npm run typecheck && npm run lint
npx expo export --platform web   # static build in dist/
```

Start the backend from the repo root first. You need at least `python -m services.form_api`, `services.gateway` and `services.orchestrator`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | `http://localhost:8001` | Form API |
| `EXPO_PUBLIC_GATEWAY_URL` | `http://localhost:8000` | Gateway (`/ws/device/{id}`) |
| `EXPO_PUBLIC_AUTH_MODE` | `dev` | `dev` picks a seeded user; `entra` uses Entra ID with PKCE through expo-auth-session |
| `EXPO_PUBLIC_ENTRA_TENANT_ID` / `_CLIENT_ID` / `_SCOPES` | none | Only used in `entra` mode |

On a phone or emulator, `localhost` is the device itself, not your computer. Use your computer's LAN IP; the Android emulator uses `10.0.2.2`. The form API's `CORS_ORIGINS` must include the web origin.

Tokens are stored in expo-secure-store on native and in sessionStorage on web.

## Audio modes

- **Web, audio mode:** `getUserMedia` runs with echo cancellation, noise suppression and auto gain. An AudioWorklet (loaded from a Blob URL) downsamples to 16 kHz PCM16 mono. An energy VAD with pre-roll and hangover then makes sure only speech frames are sent.
- **Switch to text mode:** the app switches when the gateway replies `stt_unavailable_local` (local mode), or when the mic or AudioWorklet is unavailable. In text mode the browser's SpeechRecognition (`en-AU`, continuous) sends `transcript` messages tagged with the speaker chosen in the picker. A "Type instead" box is always shown in text mode.
- **Native (iOS/Android):** managed Expo (expo-audio) only records to compressed files and can't stream live PCM. Native builds therefore always use text mode:
  - **Development or production build:** speech is recognised on the device with `expo-speech-recognition` (its config plugin is included).
  - **Expo Go:** that module isn't available, so the crew types instead.
  - **Streaming audio on native:** needs a custom native module that implements `src/audio/AudioCapture.ts`.
- **Voice prompts:** prompts play `audio_b64` when it is present. Otherwise the app speaks the text with on-device TTS (expo-speech). On-device recognition is ignored while a prompt is playing.

## Offline behaviour

`src/realtime/DeviceSocket.ts` reconnects with exponential backoff and jitter, and resends `start` (and `pause`, if paused) on every connect. While disconnected, it queues outgoing messages and sends them in order once the gateway replies `ready`:

- **Text messages** are also persisted to AsyncStorage per session.
- **Audio** is kept in memory only, capped at 120 s, and the oldest audio is dropped first.

The pill at the top of the live screen shows the connection state and how many messages are queued. After a reconnect, the app fetches the session, draft and transcript again.

## Limitations

- Crew acknowledgement on the review screen uses `PATCH /draft` (`/crew/{id}/acknowledged`). The form API currently rejects crew edits once the draft is in REVIEW (403), so the app shows a message instead. A dedicated acknowledge endpoint is needed.
- The review screen polls every 5 s; it doesn't use the `/ws/live` subscription.
