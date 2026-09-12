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

The cure is hysteresis, which is how every real player behaves — and it is easy to get wrong in
the direction that deadlocks, so the details matter:

- Playback does not begin until **both** elements hold 0.35 s of buffered data, with a 4 s
  timeout so a source that never reports a healthy buffer still plays. Note what this gate does
  *not* do: it never pauses, it only withholds a start. `preload` is forced to `auto`, so a
  paused element does keep filling — that is what makes the gate safe. (Gating on `preload`'s
  default of `metadata` is the version that deadlocks: a paused element that has only fetched
  metadata never fetches another byte, so it can never become ready and playback never starts.)
  Starting both at the same content position at the same instant also removes the catch-up ramp:
  previously the audio began the moment it was asked while the video needed another 45 ms to
  decode, and the controller then ran the picture at up to 1.10× for a second and a half closing
  a gap it had created itself.
- A rebuffer resumes only once both sides hold **1.5 s**, and never sooner than 250 ms after it
  began. One clean hold instead of a stutter.
- A shortage is not starvation until it has lasted long enough to be sure. A seek drops
  `readyState` on both sides for a moment, so a shortage **with something seeking** gets 300 ms
  to settle. A shortage with nothing seeking is starvation from the first sample and gets 120 ms,
  no more — because that grace is not free: while it runs, the starved side's picture is frozen
  and the sound runs on, so every millisecond of it is a millisecond of gap to close afterwards.
- Coming out of a hold, that gap is closed by moving **the sound back to the picture**, never the
  picture forward to the sound. The instinct is the other way round, and it is wrong on a pipe
  that is already too thin: a forward video seek flushes the decoder, throws away the buffer the
  hold just spent 1.5 s accumulating, and walks straight back into the stall. Measured on a
  3.4 Mbit/s file down a 2.5 Mbit/s pipe, that was the difference between a p95 lock error of
  115 ms and 9 ms. The cost is a sub-120 ms replay of audio on each rebuffer, which is what a
  rebuffer sounds like anyway.
- The correction loop is switched off while either side is **starved**, not merely while it is
  being held. Traced under a thin pipe, correcting a starving video turned what should have been
  a buffering hold into the picture jumping forward a second at a time while the sound ran on
  regardless.

### Streams that do not end together

A separately sourced dub is very often a second or two off the length of the film it belongs to.
The pair used to end on whichever stream ran out first, so a 6:13 video stopped at 6:11: the last
of the picture was never shown, and because the sound is the master clock, the time display froze
there too.

The sound running out is a **demotion, not an ending**. `audioExhausted` is set, the picture plays
on to its own end in silence, and `master` falls back to the picture for the remainder so the
clock keeps moving. Seeking back into the film brings the track back into it. Everything about
syncing — readiness, the correction loop, starting, holding — is conditioned on `audioActive`
(there is a track and it has not run out) rather than on `hasExternalAudio`, because a track that
has ended is not something to wait for, start or measure against. Not least: calling `play()` on
an element that has ended restarts it from zero, which would drop the film back to its opening.

`npm run test:end` plays 70 s of picture against 68 s of sound and asserts all of it.

### A picture that is asked to play and does not

Every readiness check in the controller asks an element whether it *could* play. None of them
prove it *did*. Reported from a 108 MB 1080p H.264 file on Windows: two seconds of sound over a
frozen first frame, then the picture arriving late. The correction loop only notices once the gap
is seconds wide, and closing it then means seeking a decoder that is already struggling.

So the start is supervised by the only evidence that settles it — whether the picture's position
actually moved:

- If the sound is running and the picture has not moved for 200 ms (after any deliberate hold),
  the start is abandoned: both are paused and the **sound is moved back to where the picture
  actually got to**, so nothing is skipped and the retry starts them together.
- The retry is not a repeat of the same simultaneous start. It brings the picture up **alone** —
  it is muted whenever there is an external track, so this is silent — and lets the sound join it
  at the picture's position as soon as the position advances. The worst case becomes a picture
  that starts a fraction of a second before its sound, which is the right way round. The picture
  is never seeked here: it is the side that is struggling, and flushing its decoder is the last
  thing it needs.

Nothing here slows a healthy start — a healthy picture advances within a frame or two, and
`startAborts` in the sync readout stays 0. `npm run test:slow` delays the video element's own
`play()` by two seconds, which is exactly the shape of the fault: **2032 ms** of sound over a
frozen picture without the watchdog, **~290 ms** with it, recovering to within 7 ms.

### The first second

Two things have to be right before the first frame goes up, and each of them was wrong in a way
that showed as "out of sync at the start, then it settles".

**There is nowhere behind position zero.** Compensating the output path means the picture has to
sit *behind* the sound — at a wired 41 ms of output path, the frame that belongs with the first
sound is the frame 41 ms before the first frame, and there isn't one. Expressed as a seek, that
target is negative, it gets clamped to zero, and the picture starts a whole output path ahead of
the sound while the rate loop claws it back over the following second. Measured: **+31 ms audible
error a third of a second in, still +14 ms a second in**, and the controller's own per-frame
figure sitting at +28 to +46 ms for the first 430 ms.

The fix is to stop expressing it as a position. What cannot be done with a seek can be done with
time: the audio starts, the first frame is *held still* for exactly the deficit, and the picture
is released already locked. Nothing is skipped and nothing is visible — the opening frame sits
there 41 ms longer than it otherwise would. Corrected, the same measurement reads flat from the
first frame, matching a start from the middle of the file. `npm run test:startup` measures
exactly this and prints both cases side by side, because this correction has now gone missing
once and nothing was watching.

**The output path is unknown at the instant it is needed.** `outputLatency` reads 0 until the
context has pushed audio, and `getOutputTimestamp()` has nothing to report from a context that
was resumed a moment ago — so the very first `play()` of a session compensated by zero however
good the measurement became later. But the length of the output path is a property of the
machine and the device, not of the playback run: the same laptop reads the same figure every
time. So it is remembered (`localStorage`, `frenflix.outputPath`) and the next session's first
pre-position is made against a real number. On a machine that has never played anything, `arm()`
waits up to 160 ms for the clock to become readable before starting — a running context renders
silence, so a usable timestamp normally arrives within a few render quanta. The sync readout
says `remembered` rather than `measured` while the figure is last visit's.

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
npm run test:startup         # the first second, from the top of a file and from the middle
npm run test:pending         # play pressed before the file has finished downloading
npm run test:end             # 70s of picture against 68s of sound
npm run test:slow            # a picture whose decoder takes two seconds to move
npm run test:links           # every Drive URL shape, and pairing across Drive files
npm run test:phase45         # tracks, subtitles, queue and progress through the real UI
node test/app-harness.mjs    # end to end through the real UI, H.264 + AAC
```

Every one of those small harnesses exists because a real person hit the bug it covers, and each
was verified to **fail with its fix removed** — checked, not assumed. That is the bar for adding
one: a harness that passes both ways guards nothing. `phase45-harness.mjs` had been checking that
the hero's Resume label was present and stopped one step short of clicking it, which is how a
Play/Resume button that did nothing at all reached a user; it clicks it now.

`app-harness.mjs` is the one that covers what a person touches: the drop zone, the name matcher,
the library card, the route, media-chrome's play button, the `j`/`k` keys, the mode buttons and
a teardown-and-rebuild of the player. 21 assertions, and it runs on MP4/AAC, which the sync
bench never sees because it runs on WebM/Opus.

**Calibrating the instrument.** `node test/harness.mjs calibrate` plays a *muxed* file — one
file, the browser doing its own A/V sync — through the identical probe. Whatever that reads is
the reference: the probe's own tap latency *plus* the output path the browser does not
compensate, which are the same quantity seen twice. A paired scenario reading near zero is
therefore correct — it is not "zero minus the bias" — and the calibration figure is what says how
much better than the browser's own sync that is. On this container it reads +34 ms at 1× while
the paired steady state reads +7 ms.

`test/media/muxed.webm` is generated by `npm run test:media` by stream-copying the other two
fixtures, so its timecodes are bit-identical to theirs. It used to be absent, `calibrate` printed
"no data", and every absolute figure the bench produced carried an unknown offset — which is how
a set of uncalibrated readings got trusted once already. If that line says "no data", stop and
generate the fixture before reading anything else. It reads +48 ms at 1×, +96 ms at 1.5× and +134 ms at 2×, which is the Web
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

That last figure is now asserted rather than admired: `npm run test:startup` throttles the pipe
to 320 KB/s and fails above 12 stop/starts in twenty seconds. With the hysteresis thresholds
zeroed it reads 17 play / 16 pause and 9 sub-half-speed intervals; with them, 4 play / 3 pause
and none. This regressed once — the behaviour described above was documented here while the code
had gone back to a bare `readyState` gate — and the bench printed the churn all along without
anything failing on it.

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

**The wait has to be visible.** On a feature film that first copy is minutes, and a player
sitting on its loading spinner for four minutes does not look like a download — it looks broken.
So the watch page shows `DriveProgress`: which file, how far along, how fast, how long is left,
and the reason it is happening at all. It was dropped from the page during the UI port and the
result was reported, exactly as predicted, as an infinite loading loop.

A play press made during that wait is honoured rather than discarded. The controller clears its
play intent whenever the source changes — it has to, since the new source may be a different
film — so `<frenflix-video>` carries the intent across, and playback begins the moment the copy
lands. Without that the press was swallowed *and* the controls layer was left believing playback
had started, with nothing ever telling it otherwise: a spinner that never cleared. That is what
`npm run test:pending` holds in place.

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
