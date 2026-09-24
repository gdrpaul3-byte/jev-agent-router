# Live comparison dashboard and recording

[Installation](INSTALL.en.md) · [한국어](DEMO.ko.md)

**Status:** the local dashboard and instructions are available; a screen-recorded live demo has not been published.

The dashboard shows a real **routing → local evidence retrieval → structured synthesis** comparison. It does not automate browser clicks on a third-party site. The browser only displays local progress; model calls run in the Node evaluator. A recording of this dashboard demonstrates the measured workflow, not a universal browser-use speedup.

## Prepare without paying

Complete the installation and private `.env` setup first. Then run:

```sh
node --use-system-ca -- benchmarks/complex-mission-eval.mjs --preflight
node --use-system-ca -- benchmarks/live-demo-server.mjs --run-id public-demo-01 --env-file .env --port 8786
```

Choose a new run ID each time, such as `public-demo-01`. Use lowercase letters, digits, or hyphens, at most 48 characters, and begin with a letter or digit. This example will write under `benchmarks/results/live-demo-public-demo-01/`. Existing reports are not overwritten.

Open [the local dashboard](http://127.0.0.1:8786/) in your browser. Starting the server alone does not start inference. Its HTTP surface only permits reads; page requests cannot launch the paid run. Keep `.env`, terminals containing secrets, account pages, and private task files outside the recording area.

## Start and record the actual run

1. Make the dashboard window visible at a readable size. Select that window in your screen recorder and confirm its preview is not blank.
2. Start recording before inference. In the server terminal, type `run` and press Enter. This starts a **paid** comparison with a $5 estimated reservation budget and an 80-POST cap.
3. Keep recording through completion or failure. The three arms run sequentially in a rotating order, not simultaneously. Counters update as workflow checkpoints are written.
4. Save the video with the generated `report.json` and `report.json.manifest.json`. Type `quit` to close the server after the evaluation completes.

For unattended use, adding `--run` to the server command starts the paid evaluator immediately. The server does not itself capture video. Use a recorder you control; do not describe a manually reconstructed dashboard replay as live inference footage. Closing the server during an active request can leave an uncertain attempt; it is not proof that the provider did not charge it.

## What the screen means

- **Fresh workflows:** two synthetic missions × base/changed evidence × three arms, producing 12 new final artifacts.
- **Exact replays:** six additional workflow records reusing an identical result. Their new call count and provider cost should be zero; their original inference was already charged.
- **Core vs strict quality:** core covers structure, selection, calculations, deadlines, and approval dependencies. Strict quality also requires the frozen citation sets. A fast incorrect result is not counted as a successful speedup.
- **Costs:** JEV input list-price estimates plus OpenRouter-reported credit charges. Host inference, funding fees, taxes, recording, and downstream tools are excluded. `null` means unknown, not free.
- **Caching:** changed evidence causes new synthesis. Prompt-cache tokens describe reused provider input, not a reused answer or free output generation. The first request is not guaranteed to have a cold provider cache.

The evaluator performs local analysis only. It does not send applications, publish content, contact people, or operate external websites. Final synthesis is Astra in all arms. The adaptive arm may choose a different routing provider only when its trusted conditions and observations support that choice.

## Publish a faithful record

Keep original timing, unsuccessful rows, and the frozen manifest. Label sped-up edits with their playback speed and provide an unedited 1× version when claiming wall-clock timing. Review any video and custom report for private information before publication. A repository containing synthetic fixtures does not make arbitrary user input safe to publish.

The existing [complex-mission report](../benchmarks/results/complex-missions-v1/RESULTS.md) is a completed measured run. It is separate from any newly recorded demo: do not present its costs or scores as measurements from a new video. A fresh recording must be linked to its own report.
