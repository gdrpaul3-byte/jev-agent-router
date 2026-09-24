# Recorded browser pilot: Astra vs JEV + Astra

[한국어](BROWSER-DEMO.ko.md)

## Align the measured task starts

Use `--task-clock` for a new comparison in which both panels start at the measured task's zero: after shared browser preparation and before the first model inference. The task ends after final fact extraction and validation. Both panels retain all inference and waiting time at 1× speed. The new pair's outcomes and API costs belong in its [separate results](../benchmarks/results/browser-task-aligned-20260924/RESULTS.md), with a [task-start-aligned comparison video](../benchmarks/results/browser-task-aligned-20260924/comparison/comparison.mp4). The earlier pilot's numbers below are not measurements of the new pair.

This mode records raw JPEG frames and their browser presentation timestamps in `task-clock/manifest.json`, linked by hash from the run report. Playwright defines the callback timestamp as milliseconds since the Unix epoch at browser presentation. [Playwright screencast reference](https://playwright.dev/docs/api/class-screencast#screencast-start-option-on-frame).

The task renderer verifies the manifest, selected JPEG hashes, task boundaries and clock consistency. At each 40 ms output step, it uses the latest browser frame presented at or before that task time. The result is a **25 fps sample-and-hold presentation**, not proof that the browser supplied 25 fresh frames every second. Frame timing has 40 ms quantization; the clip end rounds up by less than 40 ms. Preparation and cleanup are excluded from this task-only presentation but retained in the original recording and raw capture evidence. Each task timer stops at its measured completion; the shorter panel holds its final frame, and the composition adds a two-second tail after the longer clip.

Record a fresh preflight and both paid arms using the `--task-clock` commands below. Then render each successful run into a new directory:

```sh
node -- benchmarks/render-task-clock-video.mjs "<run-directory>" "<new-output-directory>"
```

This writes `task.mp4` and `alignment.json`. Run `inspect-browser-video.mjs` on that `task.mp4` into another new directory, and visually inspect the resulting video and contact sheet. For each `astra/` and `jev/` publication folder, retain the matching run report, inspected `video.mp4` and `media.json`; add the generated alignment metadata as `media.taskAlignment`. Keep its manifest hash and measured duration unchanged. A replay-only clip must not receive task-alignment metadata. Then compose the reviewed pair:

```sh
node -- benchmarks/render-browser-comparison.mjs --root benchmarks/results/browser-task-aligned-20260924 --output-dir "<new-comparison-directory>" --font "<path-to-Korean-font>"
```

`ffmpeg`, `ffprobe` and an installed font with Korean glyphs are required for rendering and inspection. These file-only steps make no model calls; recording new benchmark arms incurs new API costs, reported separately from the earlier pilot. Keep original recordings, raw capture manifests and failed attempts for audit.

## Earlier pilot: original recordings

**Historical result: both measured tasks passed; all video frames were decoded and sampled frames were visually reviewed.** In the earlier one-run-per-arm pilot, task time was 26.69 seconds for Astra and 12.71 seconds for JEV + Astra. See its [bilingual results and evidence](../benchmarks/results/browser-playwright-20260924/RESULTS.md).

### Watch the earlier clips together

[Play the side-by-side comparison](../benchmarks/results/browser-playwright-20260924/comparison/comparison.mp4): **NO JEV — Astra** on the left and **WITH JEV — JEV + Astra** on the right. The complete original clips start together at replay zero and run at 1× speed. The moving counters show **video replay time**, while the measured task times are separate fixed labels. The exact task-start frame offsets are unknown, so this edit does not align task starts.

Each counter stops when its original clip ends, and that panel holds its last frame with an end label. After the longer clip ends, both panels remain visible for a two-second presentation tail. The resulting video is 33.96 seconds long; the original clips remain unchanged. This file-only edit makes no new API calls.

To reproduce the composition from the repository root, install `ffmpeg` and `ffprobe` on `PATH`, choose an installed font with Korean glyphs, and replace the quoted placeholders below. The output directory must not already exist.

```sh
node -- benchmarks/render-browser-comparison.mjs --root benchmarks/results/browser-playwright-20260924 --output-dir "<new-output-dir>" --font "<path-to-Korean-font>"
```

The renderer verifies source hashes and frame counts, then writes the combined MP4, a poster, a review sheet and edit metadata. Inspect the rendered video and review sheet before publishing another composition.

## Scope and comparison

This pilot opens a **new, visible Chrome window through Playwright**, using a fresh browser context for each arm and a 1600 × 900 viewport. Playwright `recordVideo` records the actual browser viewport. It does not attach to the user's original Chrome tab or use the native CUA backend from the earlier diagnostics.

The public target is the [Hwaseong Medi-Science University website](https://www.hsmu.ac.kr/web/main/index.do). One Astra arm and one JEV arm completed. This is a two-run pilot, not the previous ABBA proposal and not a statistically established benchmark.

| Component | Astra arm | JEV arm |
|---|---|---|
| Next allowed action and observed target | Astra through OpenRouter | JEV through TypeSafe |
| Final fact extraction | Astra through OpenRouter | Astra through OpenRouter |
| Browser execution | Headed Chrome, fresh Playwright context | Headed Chrome, fresh Playwright context |
| Viewport | 1600 × 900 | 1600 × 900 |
| Task, action choices, checks and limits | Same frozen protocol | Same frozen protocol |

This is a real LLM baseline under the same bounded choices. It does not compare unrestricted host-agent reasoning, existing personal browser profiles, bot connectivity or form submissions.

## Five actions and three independently checked facts

The host allows these five clicks, in order:

1. Open the `H` menu.
2. Visit `총장 인사말` (president's greeting).
3. Open the `총장 인사말` breadcrumb/sub-navigation button.
4. Visit `총장 프로필` (president's profile).
5. Visit `오시는 길` (directions).

The model selects from supplied action IDs and currently observed targets. The host checks fresh page evidence and URL/heading visit order. It does not infer success from confidence alone.

The greeting and profile bodies are images. Their checks establish **page visits only**, not reading or understanding those images. Final extraction uses the browser-observed text on the directions page and checks these frozen expected values:

| Field | Expected value in this protocol |
|---|---|
| Bus from Seoul Station | `5101` |
| Main university phone | `031-369-9100~1` |
| Shuttle boarding fare | `무료` |

The values are local validation labels, not hints supplied to the extractor. The site may change; inspect and version a changed protocol before another measured comparison rather than relaxing checks after seeing results.

A successful ordinary path is expected to use **7 API requests per arm**: five action decisions, one completion decision, and one final extraction. This is an expectation, not a guaranteed request count. Every actual attempted request, including failure or a permitted replan, remains in the report.

## Record new task-clock runs from the repository root

Use Node.js 24+, the installed Chrome channel and the dependencies described in [installation](INSTALL.en.md). Keep keys in the private `.env`; the Astra arm requires OpenRouter and the JEV arm also requires TypeSafe. The commands below start the isolated browser; they do not reuse an existing personal tab.

After installing the repository's pinned optional `playwright-core` dependency, install its video encoder:

```sh
npx playwright-core install ffmpeg
```

This supplies Playwright's recording encoder; Chrome is already installed separately. The later file-inspection command also needs separately available **ffmpeg and ffprobe executables**. Installing Playwright's encoder alone does not establish that both inspection commands are available on `PATH`.

Create a new preflight directory and inspect its report:

```sh
node --use-system-ca -- benchmarks/record-hsmu-playwright.mjs --preflight --task-clock --output-dir benchmarks/results/browser-task-clock-preflight
```

Then run each arm against that same preflight report, using a **new output directory for every attempt**:

```sh
node --use-system-ca -- benchmarks/record-hsmu-playwright.mjs --arm astra --task-clock --env-file .env --preflight-report benchmarks/results/browser-task-clock-preflight/report.json --output-dir benchmarks/results/browser-task-clock-astra-1
node --use-system-ca -- benchmarks/record-hsmu-playwright.mjs --arm jev --task-clock --env-file .env --preflight-report benchmarks/results/browser-task-clock-preflight/report.json --output-dir benchmarks/results/browser-task-clock-jev-1
```

The CLI freezes the source hashes and protocol in the preflight evidence and uses that evidence for the paid run. The preflight and both arms must all use `--task-clock`; an earlier preflight without this option is not interchangeable. Keep the exact configuration and source version with the results. Restart the CLI when code changes; do not compare a fresh module with an old persistent-runtime closure.

The default limits are **$2 expected-cost budget and 10 requests per arm**. The request limit bounds attempted POSTs; the cost guard is not a provider-enforced prepaid balance cap. The live arms incur API costs. Stop and retain an unsuccessful attempt rather than resetting its state or silently retrying until it passes.

## Timing, recording and cache conditions

The measured end-to-end **task** interval includes browser observation, model decisions, clicks, completion checks and final fact extraction/validation. Browser process/context setup, initial homepage navigation and cleanup are excluded from that task interval but reported separately. Compare the same interval in both arms.

Fresh contexts initially exposed four promotional popups over the menu. The shared host preparation closes only freshly observed `X` links, with a limit of eight closes, before the task timer starts. These closes are recorded and make no model/API requests. Both arms use the same preparation. After each task click, the host waits for `DOMContentLoaded` before taking the next fresh observation, avoiding an interim empty page body; it does not repeat the click.

Keep the full viewport recording, including recorded initialization/initial navigation and the real post-task tail, at **1× speed**. Browser process startup can precede the first recorded frame; use setup timings for that part. Do not trim waiting, insert page sequences or replace missing frames. Video duration and task duration differ because the recording includes surrounding work.

Fresh contexts avoid sharing one arm's browser-context state with the next. This is not proof that OS, network, site or provider caches were cold. LLM `cacheMode: "off"` requests no explicit prompt-cache breakpoint; it does **not** guarantee zero provider cache tokens. Preserve reported cache usage, and distinguish it from browser caching or exact-result replay.

## Inspect every real video before publication

Use the actual source video path recorded by the CLI, then a **new inspection directory**:

```sh
node -- benchmarks/inspect-browser-video.mjs path/to/recorded-video.webm benchmarks/results/browser-pilot-astra-1-review
```

`path/to/recorded-video.webm` is the recorded output file, not a new recording source. Repeat with the other arm's actual source. This file-only tool requires ffmpeg/ffprobe, decodes every frame, checks luminance/black intervals and sampled frame differences, and creates a contact sheet, poster and `media.json`. It emits `video.mp4` at 1× only when its pixel checks pass. Existing output directories are not reused.

Inspect the contact sheet and actual playback manually. Pixel variation alone proves neither correct work nor privacy. Verify the expected pages and task outcome against the run report, and check for account information, unrelated content or private paths. Preserve failures and original recordings locally; publish only reviewed video and sanitized evidence. Do not publish `.env`, credentials, raw personal-browser snapshots or private manifests.

## Earlier pilot's measured results

| Arm | Navigation + 3 facts | Task interval | Setup/navigation/cleanup | Actual requests | OpenRouter credits | JEV estimate | Reviewed video |
|---|---|---|---|---|---|---|---|
| Astra + Astra | Pass: 5 clicks, 3 facts | 26.690936 s | Setup 8.364917 s; cleanup 2.806045 s | 7 | $0.14240000 | Not applicable | [Video](../benchmarks/results/browser-playwright-20260924/astra/video.mp4) |
| JEV + Astra | Pass: 5 clicks, 3 facts | 12.711078 s | Setup 10.041860 s; cleanup 2.216533 s | 7 | $0.01683000 | $0.00118461 | [Video](../benchmarks/results/browser-playwright-20260924/jev/video.mp4) |

The observed task-time ratio was **2.10×**, and the JEV arm's combined accounted API cost was **87.35% lower** ($0.01801461 versus $0.1424). These describe this pair only. Including setup and cleanup, total process times were **37.861897 s / 24.969471 s** (1.52×). The pair cost **$0.16041461 across 14 POSTs**; including the earlier diagnostics, this browser investigation accounted for **$1.009991966 across 37 POSTs**. These totals do not include unrelated earlier product experiments.

Both reports preserve comparison hash `6c2d6b775d88e9492906f96d1e41b6043019657b534ed6b9a5bbdcff64a654c1`. Initial navigation and the four popup closes are included in setup. Browser navigation plus decisions took 23.210010 s / 9.889564 s; final extraction took 3.474656 s / 2.815943 s. Minor differences between summed substeps and the outer task interval are host validation/measurement overhead. The original browser-run verification passed **778 offline tests**; that does not expand the live pilot's scope.

Video QA decoded **799 frames / 31.96 seconds** for Astra and **487 frames / 19.48 seconds** for JEV, both at 1600 × 900. All frames passed the nonblack luminance check, no black intervals were detected, and each five-frame sample contained five distinct images. Sampled frames were visually reviewed, including a denser JEV navigation storyboard; they showed the public site without accounts, keys or unrelated applications. This does not claim that a reviewer watched every frame. Both videos preserve the entire recorded stream at 1× with no cuts, including visible loading, popup preparation and waits. The first encoded frame's offset is unknown: report offsets are estimates, video duration is not the task timer, and no exact task-time overlay is inferred from them.

Include both arms and any failed attempt. Report OpenRouter's provider-reported account-credit cost separately from JEV's token-based list-price estimate. Include final extraction and failed requests; unknown usage/cost stays unknown. A combined amount is not a verified card charge and excludes host inference/subscriptions, top-up fees, tax and local compute/network costs. Rehearsal, preflight and diagnosis expenses must be separately retained.

One run per arm supports a demonstration of this task, not a general speedup or universal cost-saving claim. The task, route and expected facts were authored by this project, and the allowed route was known in advance. This is not an independent benchmark, proof of image understanding, production Claude integration, or recovery of the original personal browser connection. Task reports and video visibility/privacy checks remain separate evidence.

## Current preflight and capture diagnostics

The first free five-click preflight of this new backend failed before the observation-transport fix and made **zero paid API calls**. Diagnosis found that the HSMU page had replaced `window.Map` with a non-native function: `get` existed but `set` did not. On that page, Playwright transport of returned objects/arrays produced `undefined`, while a JSON-string return crossed the boundary correctly.

DOM/heading capture now returns JSON text and applies bounded parsing plus strict validation in the host. The focused checks, including regressions that failed before the fix, passed **52 tests**. Those tests verify the observed data-transport fix; the successful measured tasks have separate reports above.

The browser-native recording from the diagnostic was **11.6 seconds / 290 frames**, and its actual contact sheet was checked for visible content. Recording the browser viewport replaces the unreliable desktop `gdigrab` capture. This diagnostic is capture evidence, not a successful task result, and it does not repair or verify the original personal-tab/CUA connection.

The later **fourth free preflight succeeded**: all five clicks and all three destination URL/heading checks passed with **zero API calls**. Its full recording contained **432 frames / 17.28 seconds**, with no detected black interval, and the actual contact sheet was visually checked. This full navigation preflight is separate from the earlier 11.6-second capture diagnostic. Four free preflights, including the earlier failures, are preserved as `preflight-1` through `preflight-4` in the results directory; they made no paid API calls. The two successful paid arms use the same frozen source/protocol hash and have their own reports.

## Earlier diagnostics remain separate

The earlier six native-CUA diagnostic attempts made **23 POSTs** and accounted for **$0.849577356** across OpenRouter credits and JEV estimates. One Astra attempt passed the task; no JEV attempt completed successfully, and the comparison video was invalid because the capture was black. These attempts are not successful comparison results.

They also span a cross-realm JSON parser fix and a configuration issue: an old persistent-runtime closure retained an effective five-second observation deadline despite later intended configuration changes. The new source-hashed CLI runs in a fresh process to make the actual loaded code/configuration reviewable. Preserve the earlier reports and expenses separately; do not merge their times, substitute their clips or hide their failures in the new pilot.
