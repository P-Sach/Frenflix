/**
 * Generates test media where BOTH streams carry their own content timestamp,
 * recoverable from the decoded signal itself:
 *
 *  - video: frame number written as a 16-bit binary bar code across the frame
 *    (bit k = pixel column band k, white = 1). Reading the canvas gives the
 *    exact content time of the frame ON SCREEN, with no reference to
 *    `mediaTime` or `currentTime`.
 *  - audio: a 2 kHz Gaussian burst every 250 ms, peak at k*0.25 + 0.01 s.
 *    Detected through an AudioWorklet tap, so it gives the exact content time
 *    of the audio ACTUALLY BEING OUTPUT.
 *
 * Comparing those two is a measurement of real A/V sync that shares no
 * instrument with the controller under test.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'media');
mkdirSync(out, { recursive: true });

const DUR = 70;
const FPS = 30;
const BIT_W = 40;
const BITS = 16;

const ff = (args) => {
  process.stdout.write(`ffmpeg ${args.slice(-1)}\n`);
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
};

// bit k of the frame number N, as a vertical band BIT_W px wide
const lum = `if(gt(bitand(N\,pow(2\,floor(X/${BIT_W})))\,0)\,255\,0)`;
const vsrc = `color=c=black:s=${BITS * BIT_W}x360:r=${FPS}:d=${DUR},geq=lum='${lum}':cb=128:cr=128`;

// 2 kHz burst, Gaussian envelope centred 10 ms into each 250 ms period,
// plus a quiet 120 Hz bed so the encoder never sees pure silence.
const asrc = `aevalsrc='0.9*sin(2*PI*2000*t)*exp(-pow((mod(t\,0.25)-0.01)*300\,2))+0.03*sin(2*PI*120*t)':s=48000:d=${DUR}`;

if (!existsSync(join(out, 'video.webm'))) {
  ff(['-f', 'lavfi', '-i', vsrc, '-c:v', 'libvpx-vp9', '-crf', '18', '-b:v', '0',
      '-pix_fmt', 'yuv420p', '-g', '30', '-an', join(out, 'video.webm')]);
}
if (!existsSync(join(out, 'audio.webm'))) {
  ff(['-f', 'lavfi', '-i', asrc, '-c:a', 'libopus', '-b:a', '128k', '-vn', join(out, 'audio.webm')]);
}
// A realistic pair too: what people actually drop in.
if (!existsSync(join(out, 'video.mp4'))) {
  ff(['-f', 'lavfi', '-i', vsrc, '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-g', '30', '-an', join(out, 'video.mp4')]);
}
if (!existsSync(join(out, 'audio.m4a'))) {
  ff(['-f', 'lavfi', '-i', asrc, '-c:a', 'aac', '-b:a', '192k', '-vn', join(out, 'audio.m4a')]);
}
/**
 * Phase 4/5 fixtures: a title with two dub tracks and subtitles, plus a second
 * title so auto-advance has somewhere to go. Long enough (70s) that watch
 * progress has room to be meaningful, and VP8/Opus so a container's Chromium
 * — which ships without H.264 or AAC — can actually decode them.
 */
const PHASE_DUR = 70;
const clip = (name, src) => {
  if (existsSync(join(out, name))) return;
  ff(['-f', 'lavfi', '-i', `${src}=size=480x270:rate=25:duration=${PHASE_DUR}`,
      '-c:v', 'libvpx', '-b:v', '400k', '-an', join(out, name)]);
};
const tone = (name, hz) => {
  if (existsSync(join(out, name))) return;
  ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${PHASE_DUR}`,
      '-c:a', 'libopus', '-b:a', '48k', join(out, name)]);
};

clip('Phase Test (2024) 1080p WEB-DL.webm', 'testsrc');
clip('Second Film (2023) 1080p WEB-DL.webm', 'smptebars');
tone('Phase.Test.2024.Hindi.DDP5.1.opus', 440);
tone('Phase.Test.2024.English.AAC.opus', 880);
if (!existsSync(join(out, 'Phase Test (2024).en.srt'))) {
  writeFileSync(join(out, 'Phase Test (2024).en.srt'),
    '1\n00:00:02,000 --> 00:00:06,000\nPhase four cue\n\n2\n00:00:10,000 --> 00:00:14,000\nSecond cue\n');
}

console.log('media ready in', out);
