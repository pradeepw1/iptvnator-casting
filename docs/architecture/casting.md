# Casting (Google Cast and Roku)

The desktop app casts the current stream to a receiver on the local network:
a Google Cast device (Chromecast, Google TV) or a Roku player or TV. Electron
does not ship Chrome's Cast sender API (`chrome.cast`), so the main process
speaks the Cast V2 protocol itself; Roku devices are driven through Roku's
External Control Protocol (ECP). The renderer drives both over the same IPC and
sees one device list. The PWA has no casting.

## Flow

```text
app-player-controls ── Cast button / device menu / status card
        │ input transform withCasting()
        ▼
PlayerCastController (provided by WebPlayerViewComponent via providePlayerCast)
        │ window.electron.cast*  (supportsCasting capability)
        ▼
cast.events.ts ── CastController ── mDNS discovery (_googlecast._tcp)
                         │
                         ▼
                 CastReceiverSession ── TLS :8009 ── Default Media Receiver
```

1. Opening the cast menu runs an mDNS query for `_googlecast._tcp.local` on
   every IPv4 interface for about 2.5 seconds. Audio-only receivers (no video
   bit in the `ca` TXT record) are skipped.
2. Picking a device launches Google's Default Media Receiver (`CC1AD845`) and
   sends `LOAD` with the stream URL, title and poster. VOD resumes at the local
   position; live streams use `streamType: LIVE`.
3. While a session is active, the shared controls show and drive the TV:
   play/pause, seek (VOD only) and volume go to the receiver; local-only menus
   (tracks, quality, speed, aspect, recording, PiP, stream info) are hidden;
   the local engine is kept paused; a status card covers the picture.
4. Switching channel or episode inside the same player view sends the new
   stream to the TV. A view that opens while another view is casting adopts the
   session without replacing what the TV plays.
5. Leaving the player keeps the TV playing. Stopping from the card or the menu
   stops the receiver app. App quit only drops the connection.

## Contracts

- **Shared types and IPC** — `libs/shared/interfaces/src/lib/cast.interface.ts`.
  `CastBridgeApi` methods are optional on `ElectronBridgeApi`; renderer code
  checks `RuntimeCapabilitiesService.supportsCasting`.
- **Device identity** — the renderer refers to devices by the id the backend
  returned from its latest discovery. It never supplies a host or port, so it
  cannot make the main process open a connection to an arbitrary address.
- **Media validation** — the backend accepts only absolute `http(s)` URLs whose
  host is not loopback (the TV would resolve it to itself). DRM, `blob:` and
  `file:` sources are not offered by the renderer either.
- **No logging of URLs** — provider stream URLs embed credentials.
- **TLS** — receivers present certificates from Google's device CA, which Node
  does not trust, so the certificate is not verified. The receiver only gets a
  URL it fetches itself; device authentication (`deviceauth`) is not used.
- **One session** — the main process owns at most one receiver session. Casting
  to the same device replaces its media; casting to another device stops the
  previous one.
- **Controls contract** — `PlayerController` is unchanged. `withCasting()` is an
  input transform on `app-player-controls` that wraps the engine controller only
  under a host that provides `PlayerCastController`; every other host gets its
  controller back unchanged.
- **macOS** — `NSLocalNetworkUsageDescription` and `NSBonjourServices`
  (`_googlecast._tcp`) in `electron-builder.json` let macOS ask for Local
  Network access the first time the menu searches.

## Roku

Roku devices do not speak Google Cast. The main process finds them by SSDP
(`M-SEARCH`, `ST: roku:ecp`) on every IPv4 interface, at the same time as the
Google Cast mDNS search, and names each from `GET /query/device-info`
(`user-device-name`). An answer whose `LOCATION` names another host than its
sender falls back to the sender's address and port 8060, so a forged reply
cannot steer the main process elsewhere.

- **Play.** `POST /input/15985?t=v&u=<url>&videoName=…&videoFormat=…&k=<poster>`
  opens the URL in the built-in "Play on Roku" channel. `videoFormat` comes
  from the content type or path (`hls`, `dash`, `mp4`, `mov`, `mkv`) and is
  omitted when unknown; extensionless live URLs are sent as `hls`.
- **Progress.** `GET /query/media-player` is polled every second. `play`,
  `pause` and the buffering states map onto the session; `stop`, `close`,
  `none` or another channel taking over end it once playback was seen, or
  after a 20-second start-up grace. Five unanswered polls in a row (the TV was
  switched off or left the network) end it as `connection-lost`.
- **Controls.** ECP has no absolute seek or volume, so a Roku session reports
  `canSeek: false` and `canSetVolume: false` and the shared controls hide both
  while casting to it. Play and pause send the toggling `Play` key only when
  the state differs; stop sends `Home`.
- **Access.** Roku's Settings → System → Advanced system settings → Control by
  mobile apps → Network access must be **Default**. In **Limited** mode the
  device answers 403: a refused play becomes the `control-blocked` error,
  whose message names that setting. A device that plays but refuses status
  queries keeps an optimistic playing/paused state without progress.
- **Formats.** Roku's native player needs no CORS, so the web-video list drops
  the CORS warning when a Roku is picked. Headers, cookies and raw MPEG-TS still
  cannot be passed.

## Limits

The Default Media Receiver fetches the stream itself, so:

- HLS (`.m3u8`) and MP4 play. Raw MPEG-TS (common for Xtream live URLs without
  an extension) does not; extensionless live URLs are sent as HLS.
- Streams that need a custom User-Agent, Referer, Origin or other headers may
  fail; the menu warns when the playlist defines them.
- The stream server must send CORS headers for HLS segments.

A local relay in the main process (adding headers and CORS, remuxing TS to HLS)
or a custom receiver app would lift these limits; neither exists yet.

## Cast a web video

The header's Cast button opens a dialog where a web page or stream link can be
pasted. The main process finds the videos behind it and the dialog lists them,
main video first and ads folded away; the picked source is cast like any other
media.

1. **Direct links.** A link whose path names a stream (`.m3u8`, `.mpd`,
   `.mp4`, `.webm`, …) and whose server does not answer with HTML is probed as
   is. `…/File:Clip.webm` pages therefore still get scanned.
2. **Page scan** (`web-video-page-scanner.ts`). The page loads in an isolated
   offscreen view (see the
   [Electron security contract](./electron-security.md#web-video-scan-view)) with
   a 1280×720 emulated viewport; device emulation is applied at `dom-ready`
   because an unattached view otherwise lays out at 0×0. Every response with a
   media type or media path is recorded with the frame that requested it.
   Segments (`.ts`, `.m4s`, numbered fMP4/WebM chunks, init segments, byte
   ranges) are cancelled. Each frame then reports its `<video>` elements and
   video metadata tags and asks its videos to play, muted. If nothing has
   streamed 1.5 seconds after load, the element under the player's centre is
   clicked once. The scan stops 3.5 seconds after the last finding (never
   sooner than 2.5 seconds after load) or after 15 seconds.
3. **Candidates** (`web-video-candidates.ts`). Requests, element sources and
   metadata tags merge into at most 20 distinct streams; an adaptive stream is
   matched to the largest video in its frame because MSE players only expose a
   `blob:` URL.
4. **Probe** (`web-video-probe.ts`). Each stream is fetched the way a receiver
   would: no cookies, no Referer, a Chromecast user agent. HLS master playlists
   give quality and one variant gives length and live state; DASH manifests
   give duration, height and DRM. The result is the stream's castability:
   `likely`, `needs-headers` (401/403/410/451), `no-cors` (manifest without
   CORS), `drm`, or `unknown`. Variant playlists are folded into their master.
5. **Ads** (`web-video-ad-classifier.ts`). A score from weighted signals: a
   known video ad host (+5), a stream inside an ad-network frame (+4), ad path
   tokens or VAST/Ad Manager query parameters (+3), a clip of 45 seconds or
   less (+2), a muted looping element (+2); and against: the page's main
   player (-2), page metadata (-2), several renditions (-2), live (-3), long
   form of three minutes or 30 MB and more (-3). A score of 3 or more is an ad.
   No weak hint alone makes an ad. Ads stitched into an HLS stream (cue or
   interstitial tags) cannot be separated and are flagged on the stream.
6. **Ranking.** Videos first by score, castability, height and length; ads
   last. The dialog preselects the first video, never an ad.

YouTube links are refused with a pointer to YouTube's own cast button: its
players hand out split, short-lived audio and video URLs a receiver cannot
play. DRM-protected streams are listed but marked as unplayable; nothing tries
to work around DRM.

## File map

| Path | Role |
| --- | --- |
| `apps/electron-backend/src/app/services/cast/cast-message.codec.ts` | `CastMessage` protobuf and length-prefixed framing |
| `apps/electron-backend/src/app/services/cast/cast-connection.ts` | TLS channel, virtual connections, heartbeat, request/response by `requestId` |
| `apps/electron-backend/src/app/services/cast/mdns.codec.ts`, `cast-discovery.ts` | mDNS query and response parsing |
| `apps/electron-backend/src/app/services/cast/cast-media-payload.ts` | URL validation, MIME inference, `LOAD` payload |
| `apps/electron-backend/src/app/services/cast/cast-receiver-session.ts` | Launch, load, status tracking and commands for one receiver |
| `apps/electron-backend/src/app/services/cast/cast-controller.ts`, `events/cast.events.ts` | Device cache, single session, IPC handlers |
| `apps/electron-backend/src/app/api/cast-bridge.ts` | Preload half of the bridge |
| `libs/ui/playback/src/lib/cast/` | Renderer controller, media resolution, controls wrapper, device menu, status card |
| `apps/electron-backend/src/app/services/cast/roku/` | SSDP discovery, ECP client, Roku session |
| `apps/electron-backend/src/app/services/cast/receiver-discovery.ts` | Both discoveries, protocol dispatch |
| `apps/electron-backend/src/app/services/web-video/` | Page scan, candidates, probe, manifests, ad classifier, finder |
| `apps/electron-backend/src/app/events/web-video.events.ts` | One scan at a time, cancellation |
| `libs/ui/playback/src/lib/cast/web-video/` | Dialog, launcher, list presentation |

## Validation

- `pnpm nx test electron-backend --testPathPatterns='services/(cast|web-video)/'`
- `pnpm nx test ui-playback` (cast specs live in `src/lib/cast/` and
  `player-controls.component.cast.spec.ts`)
- Manual: a Chromecast or Google TV on the same network as the desktop app.
  There is no Electron E2E for casting because CI has no receiver.
- The page scan needs real Electron. Load it from a script run with the
  Electron binary, serve fixture pages from a local server and route fake
  hostnames to it with the `host-resolver-rules` switch, for example
  `MAP *.doubleclick.net 127.0.0.1:PORT`, to exercise ad frames, popups,
  navigation and loopback blocking without the network.
