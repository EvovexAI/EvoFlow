# EvoFlow KWS sidecar

Wake-word process: Node + `sherpa-onnx` Keyword Spotter, fed 16 kHz PCM from the Tauri WebView mic.

```bash
cd evopanel/kws-sidecar
npm install
```

Protocol: JSONL on stdin/stdout (`init` / `pcm` / `hit` / `pause` / `resume` / `stop`).  
Models: `../public/kws` (ONNX + `keywords.txt`).
