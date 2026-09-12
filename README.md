# FrenFlix

A browser video player that plays a video file alongside a **separately-sourced audio
file**, kept in sync entirely client-side.

Sources: files from this machine, and Google Drive.

```bash
npm install
npm run dev
```

Drop a video, an audio file and a subtitle file onto the page. Matching names pair
automatically (`Movie.mp4` + `Movie.m4a` + `Movie.en.srt`); anything the matcher won't guess at
can be paired by hand. Drive files pair the same way, and the two can be mixed — a video from
Drive with a dub track from the desktop is a normal case.

Local files never leave the machine. Drive files come down from Drive and go no further.

## Stack

Vite · React 18 · JavaScript · Tailwind · React Router 6 · [media-chrome](https://media-chrome.mux.dev)

Deliberately the same stack as [WeFlix_v2](https://github.com/kweephyo-pmt/WeFlix_v2), so its
components can be lifted in later without a rewrite.

## The one abstraction that matters

`<frenflix-video>` (`src/media/frenflix-video-element.js`) is a custom element that presents a
video + audio **pair** behind the standard `HTMLMediaElement` interface — the same facade trick
`hls-video-element` and `dash-video-element` use. The controls layer only ever touches `play()`,
`currentTime`, `volume` and the standard media events.

Under it, `src/lib/sources.js` turns anything into an asset with a `resolveUrl()`. Adding Drive
changed that file and the file picker, and touched neither the player, the pairing, the
subtitles nor the sync engine.

---

# Sync

Three separate problems live here and they are worth keeping apart, because conflating them is
what made the first two versions wrong:

1. **Are the two files playing at the same speed?** (a control loop)
2. **Is the picture on screen showing the same moment as the sound in the room?** (a
   measurement problem, and the one that actually matters)
3. **Does the player start cleanly?** (a buffering problem, not a sync problem at all)

## Roles: audio leads, picture follows

**The audio is the master clock. The video follows it.**

[VLC's clock design](https://github.com/videolan/vlc/blob/master/doc/clock.md) makes the same
choice, for a perceptual rather than a technical reason: a few percent of speed change on audio
is a pitch and timbre artefact the ear catches instantly, while the same change on video is
invisible. The video element is muted whenever an external audio track is in use, so bending
*its* `playbackRate` is completely free. The audio runs at exactly 1.0, is never resampled and
is never seeked to chase the picture.

## Measuring the error properly

`currentTime` is not a clock. It is the "official playback position", updated at intervals the
browser chooses, so reading it gives a *lagging step function*. Comparing two elements by
reading `currentTime` on both measures mostly quantisation noise, tens of milliseconds of it.

- `MediaClock` models a position instead of sampling it. The true position only ever runs at or
  ahead of what `currentTime` reports, so the best estimate is the **upper envelope** of recent
  samples projected forward. A ±30 ms staircase becomes a line good to a few ms.
- [`requestVideoFrameCallback`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
  gives `mediaTime` — the timestamp of the frame *actually being displayed* — and
  `expectedDisplayTime`, when it will be on screen.

## The part that was wrong, and is the whole problem

Locking `video.mediaTime` to `audio.currentTime` aligns the two *decoders*. It does not align
what you see with what you hear, because `currentTime` describes audio handed to the output, not
audio that has come out of it. Everything after that hand-off — mixer buffer, device buffer, a
Bluetooth link — is dead time no element-to-element arithmetic can see.

Measured on an ordinary wired Windows machine in Chrome, that dead time is **64 ms**. On
Bluetooth it is routinely 150–300 ms.

The previous version tried to cover this by reading `outputLatency` off a fresh `AudioContext`.
Two things were wrong with that, and neither shows up until you measure it:

- `outputLatency` is **0** until a context has actually pushed audio, so the read fell through to
  `baseLatency` — the render quantum, ~10 ms, the same on every machine, and unrelated to the
  output path.
- It was then **added** to the video's position, pushing the picture *further ahead* of the
  sound. The correction has to go the other way: if the sound comes out late, the picture has to
  be held back.

> **If the sync ever seems to regress, check this first.** The measurement lives in
> `AudioTimeline.js`, but it only does anything if `SyncedMediaController` actually *uses* it —
> `controller.timeline`, `syncMode` and `syncStatus` are the wiring. A controller without them
> still plays, still locks the two decoders to each other, and is still wrong by a whole output
> path, which is exactly the symptom this was built to fix. `npm run test:sync` catches it
> immediately: it reads `controller.timeline` and fails loudly if the wiring is gone.

`src/media/AudioTimeline.js` replaces the guess with a measurement. The audio element is routed
through a Web Audio graph, and once it is, `AudioContext.getOutputTimestamp()` reports a matched
pair of (context time, `performance.now()`) for the sample *leaving the hardware*. The output
path stops being an unknown, and the question the loop asks becomes answerable exactly:

> what will be audible at the instant this frame is on screen?

Checked before relying on it: element `volume` and `muted` still apply through the tap (0.25
volume gives exactly 0.25 amplitude in the graph; muting gives silence), so the ordinary
controls keep working. The tap is only ever created after the context is confirmed *running*,
because a tapped element feeding a suspended graph is silent — a far worse failure than a coarse
clock. If Web Audio is unavailable or refuses the source, it falls back to modelling
`currentTime` and applying whatever `outputLatency` a bare context reports.

The compensation is applied in **media time**, so it scales with playback rate: 64 ms of output
path is 96 ms of content at 1.5×. Not doing that is why the old error grew with speed.

## Correcting it

| Error | Response |
|---|---|
| < 6 ms | nothing |
| 6–300 ms | bend the (muted) video's `playbackRate` |
| > 300 ms | seek the video |

The controller is **PI, not just P**. The two pipelines are separate clock domains that do not
run at exactly the same effective speed, and against a constant rate mismatch a purely
proportional controller settles at a standing offset rather than at zero. The integral term
accumulates that bias and holds it, so the loop learns the ratio between the clocks instead of
fighting it every frame. It is deliberately slow, and frozen while the proportional term is
saturated, so a long correction cannot wind it up.

The measured error is low-passed before it reaches the loop. `requestVideoFrameCallback`
quantises to the display refresh, and feeding that jitter straight into a loop with an integral
term is what made the old one ring between 1.06× and 0.998× for a second and a half after every
start.

There are **two sets of gains**, because holding a lock and landing a new one are different jobs:

|  | time constant | trim cap |
|---|---|---|
| holding | 1.2 s | 8% |
| acquiring (just after a deliberate change) | 0.35 s | 25% |

Traced, the gentle loop took ~2.4 s to walk an 80 ms step. A 50 ms nudge that takes two and a
half seconds to arrive cannot be judged by ear, which is the only way anyone judges it. Acquiring
lands the same step in about 0.4 s, on a muted picture, where it cannot be seen. It ends as soon
as the error is small again.

## The sync panel

Three modes, in `src/components/Player.jsx`:

- **Auto** — measures the output path and holds the picture back to match. The default.
- **Manual** — no automatic compensation; your delay is the whole offset, and the loop holds it.
  The escape hatch for hardware that misreports its own latency, so it has to genuinely not use
  that measurement — including in the *error* the loop is closing, not just in the initial
  positioning. Getting only half of that right leaves two modes that behave identically.
- **Off** — no correction at all. The two files run free. Diagnostic.

Measured, so the difference is real rather than a label:

| mode | A/V error | compensation applied | picture trim |
|---|---|---|---|
| auto | **−5.0 ms** | −70 ms | 0.33% |
| manual | +72.3 ms | 0 | 0.04% |
| off | +59.7 ms | 0 | 0.00% |

Manual lands on the output path exactly, which is the point: it hands you a 70 ms error to
correct by ear instead of correcting it for you. Off touches the picture's rate not at all.

Plus the audio delay itself (`j` / `k` in 50 ms steps, VLC's keys) and a live status chip:
**Locked ±3 ms**, *Correcting*, *Buffering*. An active syncer you cannot see is
indistinguishable from no syncer at all.

**The old readout was worse than useless and this is the reason it was rewritten.** It showed one
number and called it sync. That number was the loop's own tracking error — which the loop drives
to zero by construction — so it read a healthy 2 ms while the picture genuinely sat 82 ms ahead
of the sound, and it did not move when the delay control did. Offset and lock error are
different quantities and are now reported separately: what is applied, and how tightly the two
files are held together. The detail panel says so in as many words.

## Starting, and why it used to stutter

The old code started both elements the instant `play()` was called and then held them together
with a readiness gate: whenever either dropped below `HAVE_FUTURE_DATA` it paused both, and
every `canplay` started both again. `HAVE_FUTURE_DATA` is roughly one frame of lookahead, so on
a file that cannot be fed fast enough that gate resolves true, then false, then true, several
times a second — and each cycle stops and restarts the audio.

Driven under a throttled pipe, that measured **24 play and 22 pause events in twenty seconds,
with the audio advancing at 0.056×** through the worst of it. That is the "sounds like a broken
record" symptom, and it is self-sustaining: playing drains the buffer, and `HAVE_FUTURE_DATA` is
reached again long before there is enough to keep going.

Both halves are fixed:

- Playback does not begin until **both** elements hold 0.35 s of buffered data, with a 4 s
  timeout so a source that never reports a healthy buffer still plays. Starting them at the same
  content position at the same instant also removes the catch-up ramp: previously the audio began
  the moment it was asked while the video needed another 45 ms to decode, and the controller then
  ran the picture at up to 1.10× for a second and a half closing a gap it had created itself.
- A rebuffer resumes only once both sides hold **1.5 s**, never sooner than 250 ms after it
  began, and never on a shortage that has lasted less than 300 ms — an ordinary seek drops
  `readyState` for a moment and that is not starvation. One clean hold instead of a stutter.
- The correction loop is switched off while either side is starved. Traced under a thin pipe,
  correcting a starving video turned what should have been a buffering hold into the picture
  jumping forward a second at a time while the sound ran on regardless.

At the very start of a file there is a wrinkle: compensating the output path means the picture
has to sit *behind* the sound, and at position zero there is nowhere behind to sit. The audio is
nudged forward by that much instead, which costs a few tens of milliseconds of the opening and
starts perfectly locked.

---

# Measuring all of this

`test/` holds a harness that measures real A/V sync **without asking the player where it thinks
it is**. That independence is the point: the old code's own diagnostics were confidently wrong,
and any instrument that shares a clock with the thing it measures will agree with it.

- **Video position** — the test clip carries its frame number as a 16-bit black/white barcode.
  Reading one scan line off a canvas per presented frame gives the exact content time of the
  frame *on screen*, with no reference to `mediaTime` or `currentTime`.
- **Audio position** — the test track carries a 2 kHz Gaussian burst every 250 ms. An
  `AudioWorklet` finds each burst to the sample, and `getOutputTimestamp()` converts that to the
  wall-clock instant it is *heard*.

Interpolate the video's content time at the instant a burst is heard, subtract the burst's
content time, and the difference is what a viewer experiences. Both halves are measured; neither
is a proxy.

```bash
npm run test:media           # generate the timecoded clips (needs ffmpeg)
npm run test:sync            # every sync scenario
node test/harness.mjs steady delay modes --headed
npm run test:cache           # the Drive cache, driven against a local URL
node test/app-harness.mjs    # end to end through the real UI, H.264 + AAC
```

`app-harness.mjs` is the one that covers what a person touches: the drop zone, the name matcher,
the library card, the route, media-chrome's play button, the `j`/`k` keys, the mode buttons and
a teardown-and-rebuild of the player. 21 assertions, and it runs on MP4/AAC, which the sync
bench never sees because it runs on WebM/Opus.

**Calibrating the instrument.** `node test/harness.mjs calibrate` plays a *muxed* file — one
file, the browser doing its own A/V sync — through the identical probe. Whatever that reads is
the probe's own bias. It reads +48 ms at 1×, +96 ms at 1.5× and +134 ms at 2×, which is the Web
Audio tap's own output latency expressed in media time: the browser does not know the probe
added it, so it does not compensate. FrenFlix does know, and does.

### Results

Error = the picture's content time minus the sound's, at the moment each is delivered.
Positive means the picture is ahead. Zero is perfect.

| | before | after |
|---|---|---|
| steady state, 1× | **+82 ms** | **−3.4 ms** (p95 12 ms) |
| 1.5× | +123 ms | +12.5 ms |
| 2× | not measured | +24.5 ms |
| five seeks | +82 ms | −5.6 to +1.8 ms, worst excursion 23 ms |
| after 8 pause/play/seek cycles | — | −2.0 ms, worst 17 ms |

Perceptibility is around 45 ms for audio lag, so 1× playback is an order of magnitude inside it.
The residual at high rates is `currentTime`'s update quantum expressed in media time, and it
grows with rate for that reason.

**Does the delay control do what it says?** Set it, then measure independently:

| set to | measured |
|---|---|
| −200 ms | −202.5 ms |
| 0 | −4.0 ms |
| +80 ms | +79.1 ms |
| +200 ms | +202.7 ms |

**Startup.** Small local files: first picture 8 ms after the click, **0** pause/resume cycles,
**0** stutters, A/V −2.8 ms once running. A 3.4 Mbit/s video down a 2.5 Mbit/s pipe — a stream
that genuinely cannot keep up — went from **24 play / 22 pause with the audio at 0.056×** to
8 play / 6 pause with the audio at a flat 1.000× between holds: real buffering, not a stutter.

---

# Google Drive

## Why the file is copied first

The obvious design — point `<video src>` at Drive and let the browser stream it — cannot be made
to work from a page, and it is worth writing down why:

- `files.get?alt=media` needs `Authorization: Bearer …`. A media element sends no such header
  and offers no way to add one.
- Fetching it by hand runs into the other half: Drive's CORS response permits `Authorization`
  but **not `Range`**, so the preflight for a partial request fails and the browser cancels it.
  No ranged reads means no seeking and no streaming — a media element's entire access pattern.
- The old `drive.google.com/uc?export=download` style link does serve ranges to a media element,
  but only for publicly shared files, through an undocumented host that redirects via a
  virus-scan interstitial for large files. Not something to build on.

What is left is one plain unranged GET of the whole file, which CORS does allow. So the file is
pulled down once into the **origin private file system** and the player is handed an ordinary
local file — instant seeking, no network during playback, and the sync engine unchanged.

The copy outlives the tab. A title watched yesterday starts immediately today, which makes Drive
titles the only ones that survive a reload; a dropped local file leaves nothing behind but an
object URL, which dies with the page.

## How it is written

`src/lib/drive/cache.worker.js` runs in a worker for one specific reason: `createSyncAccessHandle`
is worker-only, and it is the only OPFS write path that writes **in place**. The main-thread
alternative, `createWritable`, is specified to be atomic, which Chrome implements by writing to a
swap file and renaming on close — for a film that means needing twice its size free and a
multi-gigabyte copy at the end.

A completed download leaves a zero-byte `.done` marker beside the data; without the marker the
file is treated as absent and fetched again. A failed one deletes what it wrote, because a
partial file that looks cached is worse than no file. Two checks stop a plausible-looking
non-file being cached forever: an HTML or JSON `content-type` is rejected outright (an expired
session or a consent interstitial comes back as a cheerful 200), and the finished size must match
what Drive said when the file was listed.

There is no resume. There are no ranged reads to resume with.

## Auth

Google Identity Services' token flow, in `src/lib/drive/auth.js`. The token lives in memory and
nowhere else: an OAuth access token in `localStorage` is a key to somebody's entire Drive sitting
on disk for any script on the origin to read. There is no refresh token — the implicit flow does
not issue one, and that is the trade for running with no server at all — but a silent re-request
covers it while the Google session is alive, which is what happens automatically as a token nears
expiry.

The scope is `drive.readonly`. Nothing in this app writes to Drive.

## Setup

Copy `.env.example` to `.env` and put a Google OAuth client ID in it. **Deploying? Read
[DEPLOY.md](DEPLOY.md)** — `.env` is gitignored so the value has to be set in the host too, and
Google has to be told the deployed origin before sign-in will work there. The app shows the same
steps in the Drive panel if it isn't configured. `drive.readonly` is a *restricted* scope, so a
publicly launched app would need Google's verification and a security assessment; an unverified
consent screen still works for up to 100 addresses listed as test users.

The file picker is hand-rolled rather than Google's Picker widget: the Picker needs a second
credential and its own script, and a chooser that matches the rest of the app is worth more here
than one that matches Drive. Selection spans folders, so the video, the dub track and the
subtitles can come from three different places in one pass.

## Pasted links

Browsing only reaches your own Drive, and a file someone shared with you is usually not in it.
So the Drive panel also takes links — `src/lib/drive/links.js` parses every shape Google hands
out (`/file/d/…`, `?id=…`, `/drive/folders/…`, `/drive/u/0/folders/…`, `folderview`, and a bare
id), and takes a whole pasted message at once, because the common case is a video link, a dub
track link and a subtitle link sent together. Each reference is resolved and reported
separately: one dead link out of four adds the other three and says which one failed.

Three things that otherwise turn into an unexplained "not found":

- **Resource keys.** A file shared by link before Google's 2021 security update needs a
  [resource key](https://developers.google.com/workspace/drive/api/guides/resource-keys), which
  rides in the URL as `?resourcekey=…`. Without it the API answers 404 while the same link opens
  fine in a browser. The key is parsed from the link and carried as
  `X-Goog-Drive-Resource-Keys: fileId/resourceKey` through the metadata lookup, the subtitle
  fetch **and** the download — the last one matters, because a lookup that succeeds followed by a
  download that 404s is the confusing failure. Listing asks for the `resourceKey` field too, so
  the children of a link-shared folder carry their own keys automatically.
- **Drive answers 404 for "no access" as well as "no such file"**, which is a strange thing to
  show someone holding a working link, so that error says both and points at the resource key.
- **A Docs/Sheets/Slides URL looks like a file link** but has no bytes behind it. It is
  recognised and named rather than attempted.

A folder link navigates there instead of failing — after a metadata lookup, so the breadcrumb
gets the folder's real name and an unreadable folder reports why rather than opening empty.

Bare ids are matched on shape, not just length: long, with an upper-case letter and a digit.
Length alone accepted `garbage-not-a-link-at-all`, which is sixteen legal base64url characters.

`npm run test:links` drives all of this through the real UI against a stubbed Drive.

---

# Subtitles

`src/lib/subtitles.js` parses SRT and WebVTT into our own cue list, rendered by an overlay inside
`<frenflix-video>`. Not a native `<track>`, for three reasons: the delay control has to shift
every cue live (`g` / `h`, VLC's keys), native cue styling is barely controllable, and the overlay
has to live inside the element that goes fullscreen or it vanishes there.

- Cues are timed against the **master clock** — the audio, when there is one — because dialogue
  is what they belong to.
- Subtitle files in the wild are frequently not UTF-8, and a mis-decode produces replacement
  characters rather than an error, so decoding is strict-then-fallback to Windows-1252.
- Cue text is escaped and then a whitelist of `<i> <b> <u>` is let back in. A `.srt` is an
  untrusted text file; it does not get to inject markup.
- Auto-paired by filename like audio, but **many-to-one** — a film often ships English, Hindi
  and forced tracks at once and all three belong in the menu. A subtitle dropped directly onto a
  watch page attaches to *that* title regardless of its name.
- `.ass`/`.ssa` parse as plain text; their styling and positioning are ignored, and the library
  says so rather than silently dropping it.

# Pairing

`src/lib/pairing.js` strips release noise (`1080p`, `x265`, `WEB-DL`, `[YTS.MX]`, `DDP5.1`,
language tags) and compares what's left with a Sørensen–Dice bigram score, gated on
season/episode markers so `S01E02` can never pair with `S01E05`. It pairs at ≥ 82% similarity
and hands back anything below that for manual pairing — **the matcher is allowed to give up, it
is not allowed to guess wrong.** Year handling is deliberate: a year is the most discriminating
token in a filename and is as likely to be inside brackets as outside, so it's extracted before
brackets are stripped. That one detail is what makes
`Dune.Part.Two.2024.2160p.WEB-DL.x265.mkv` pair with `Dune Part Two (2024) Hindi DDP5.1.eac3`.

# Keyboard

`space` play/pause · `←`/`→` seek 10s · `j`/`k` audio delay ∓50 ms · `g`/`h` subtitle delay ∓50 ms

media-chrome ships its own hotkeys on `<media-controller>`, live whenever focus is inside the
player — which it is the moment you click play. That caused two collisions: **space fired twice**,
once from media-chrome and once from the app's listener, so it paused and instantly unpaused; and
**media-chrome binds `j` and `k` to seek-back and play/pause** (YouTube's bindings), directly on
top of VLC's `j`/`k` for audio delay.

They are separated explicitly now: `hotkeys="noj nok"` on the controller, `j`/`k`/`g`/`h` owned by
the app, and the transport keys left to media-chrome whenever the event came from inside the
player — the app's listener only covers them when focus is elsewhere on the page.

# Audio tracks

A film often arrives with several dubs, so audio matching is **many-to-one**: every track whose
name matches attaches to the title, best match first, and index 0 is the default. The player
shows the list; switching is live.

Switching does not restart anything. `swapAudio` rebuilds only the audio element and pulls it
back onto the picture's clock, because the viewer is looking at the video and it must not
flicker or reload. Two details make that work:

- the new position is read from the **video**, not from `master` — `master` *is* the audio, and
  it is the thing being replaced, so reading position from it would read the new track's zero;
- the seek is confirmed *before* playback resumes. `_playBoth` pre-positions the video against
  `audio.currentTime`, so restarting with the new track still at 0 would yank the picture back
  to the beginning.

Measured on a swap mid-playback: the picture never rewinds and the pair re-locks to within a
few ms.

# Watch progress

Keyed on the **file**, not on the library entry — an entry only lives as long as the tab, so
resuming has to survive re-adding the same file tomorrow. Drive files key on their Drive id;
local files on name + size + last-modified, which is stable across re-adding and costs nothing,
where hashing a 4GB film would cost minutes. (`localKey` / `driveKey` in `lib/sources.js`.)

Position is written every 5s while playing, and on pause and `pagehide` — `pagehide` rather
than `unload`, which is unreliable and blocks the back/forward cache. The interval is what
actually catches a closed lid or a killed tab, which is how viewing usually ends.

Both thresholds scale with length, because fixed ones are wrong at the short end: "within 60
seconds of the end counts as finished" is sensible for a feature and absurd for a 70-second
clip, where it marks everything past ten seconds as watched. That is not hypothetical — it is
how this failed the first time it was tested.

# Playlists

An explicit queue wins; with no queue the library's own order **is** the playlist. That means
auto-advance works on a folder of episodes without anyone having to build a playlist first.
`nextAfter`/`prevBefore` in the library context are the whole mechanism.

# Poster art

Captured from the video itself — `lib/thumbnails.js` seeks 20% in, draws one frame to a canvas
and keeps the JPEG in IndexedDB. No API key, no network call, nothing told to anyone about what
you are watching, and it works for material no database has heard of, which is most of what
ends up in a folder like this.

Cards are **16:9, not 2:3**. A video frame cropped to portrait is a worse picture than the
frame, and pretending to have posters we do not have is how a library of home video ends up
looking broken.

One rule matters more than the rest: **never let a thumbnail trigger a download.**
`resolveUrl()` on an uncached Drive asset fetches the whole film, so a poster grid would quietly
pull gigabytes. Capture is gated on `asset.ready` — always true locally, true for a Drive file
only once it is already on disk.

# The interface

Ported from **[WeFlix_v2](https://github.com/kweephyo-pmt/WeFlix_v2)** by Phyo Min Thein, MIT —
full details and the licence text in [ATTRIBUTION.md](ATTRIBUTION.md). Its palette, Outfit face,
2:3 card grid, hero carousel, drag-scroll rows and collapsible icon rail are the parts that make
it read as that interface, so they are copied rather than approximated.

What could not be copied is the *data*. WeFlix_v2 is a TMDB discovery app: its cards carry a
score and a MOVIE/SERIES tag, its rail navigates genres, its detail page shows a synopsis and a
cast. A library of your own files has none of that. So the shapes are kept and refilled with the
things that actually distinguish one file here from another:

| Theirs | Here |
|---|---|
| TMDB score badge | runtime |
| MOVIE / SERIES badge | LOCAL / DRIVE |
| Genre rail | Continue · Queue · From Drive · Unpaired · Search |
| Watchlist | the queue |
| Synopsis and cast | filenames, tracks, warnings |
| Hover trailer from YouTube | *not ported* — see below |

Keeping the badge shapes and inventing scores to fill them would have been the worse kind of
faithful.

**Poster art is 2:3, from 16:9 frames.** Their grid is built around portrait posters and a
captured frame is landscape. Cropping 16:9 to 2:3 keeps about a third of the width and
decapitates roughly every other frame, so instead the frame is composited over a blurred,
brightened-down copy of itself — the trick media servers use when they have stills but no poster
art. `lib/thumbnails.js` renders both shapes from one decode: the 2:3 for cards, the frame as
shot for the hero and the watch page.

**The hover trailer is deliberately not ported.** Theirs fetches a YouTube trailer on an 800ms
hover. There is no trailer for a file on your disk, and the honest equivalent — playing the file
itself in the card — would make a Drive title start downloading because the poster grid touched
it. That rule (see *Poster art*) is worth more than the effect.

**One bug the port introduced, and how it showed up.** The hero's slide indicators and thumbnail
strip are `z-20` *inside* the banner, and `position: relative` with `z-index: auto` does not
create a stacking context — so they competed directly with the page content below, which is
pulled up under the banner. They won, and became an invisible lid over the first row's controls.
The fix is `isolate` on the banner root. It was found by a click in `test:phase45` that kept
being intercepted by an `<img>`, which is the kind of thing no amount of looking at the page
would have revealed.

**Navigation is a real `<a>`.** Their card is a `div` with `role="button"` and an onClick; ours
stretches an anchor across the poster with the action buttons above it in z-order. Middle-click,
open-in-new-tab and keyboard activation then work without being reimplemented, and a button
nested inside an anchor — which is invalid — is avoided.

**A phone gets a bottom bar.** The original's rail is `hidden md:flex` with nothing in its place,
which leaves small screens with no navigation at all.

# Known limits

- **Browser codec support is the real constraint.** `.mkv`, `.avi`, AC-3, E-AC-3 and DTS are not
  decodable in any browser — they're listed with a warning rather than hidden, since the file is
  often right there and only the container is wrong. MP4/WebM with AAC or Opus works.
- **A Drive file has to come down in full before it plays.** Drive gives browsers no ranged
  reads, so there is no way to stream it and no way to resume a failed transfer.
- The local-file library lives in memory: object URLs die on reload, so a refresh empties it.
  Persisting handles needs the File System Access API. Drive titles are cached on disk and do
  survive.
- Audio and subtitle delays reset per title and are not remembered between sessions.
- Four files are superseded by `src/components/ui/` and no longer imported anywhere —
  `components/PosterCard.jsx`, `PosterRow.jsx`, `Hero.jsx` and `LibraryGrid.jsx`. They are safe
  to delete; they are left in place only because this session cannot remove files.
- In the collapsed rail each item's box is as wide as the expanded state and clipped to 84px, so
  the centre of its hit area is off the visible bar. Clicking the icon works, which is what
  people do, but scripted clicks need to aim at the icon rather than the element centre.
- Controls are drawn over unknown video, so the control bar carries its own gradient scrim and
  every glyph a shadow. Without that they vanish on a white frame.
