#!/usr/bin/env python3
"""
ChYme — SwallowSense complete main.py

Everything in one file:
  • Edge Impulse inference on dual MPU-6050 at 5 Hz
  • Live telemetry push to Vercel dashboard (5 Hz)
  • Tier-based haptic alerts via Modulino Vibro
  • LED matrix state display (idle → tier1 → tier2 → tier3 → heart)
  • Vapi SOS phone call at Tier 3
  • Gemini + ElevenLabs voice alerts happen browser-side via Vercel
  • CSV training data recorder with browser UI at http://<ip>:7000/
  • **Model hot-swap** — upload a new .eim via the browser UI, no restart needed
  • Graceful fallback: works even if the .eim is missing (recorder-only mode)

Design rules:
  1. HTTP server starts ONCE per process (singleton flag)
  2. main() never returns; all errors caught and retried
  3. Recording + inference coexist — both tap the same 100 Hz sample stream
"""

import json
import os
import shutil
import time
import threading
import traceback
import urllib.parse
import urllib.request
import urllib.error
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer

from arduino.app_utils import App, Bridge

# Edge Impulse is optional — recorder still works without it
try:
    from edge_impulse_linux.runner import ImpulseRunner
    HAVE_EI = True
except ImportError:
    HAVE_EI = False
    ImpulseRunner = None


# ============================================================================
# CONFIG
# ============================================================================
MODEL_PATH        = "/app/python/model.eim"
MODEL_BACKUP      = "/app/python/model.eim.bak"
WINDOW_SAMPLES    = 100           # 100 samples @ ~77 Hz = ~1.3 s window
SAMPLE_RATE_HZ    = 100           # target — actual is ~77 Hz due to Bridge latency
INFERENCE_EVERY_S = 0.2           # 5 Hz inference
SWALLOW_THRESH    = 0.60
SWALLOW_COOLDOWN  = 3.0           # seconds before counting another swallow

# (idle_seconds_threshold, haptic_buzz_count)
ALERTS = [(50, 1), (80, 2), (110, 3)]
# Fast-test ladder (uncomment for 30-second demo):
# ALERTS = [(10, 1), (20, 2), (30, 3)]

# Vapi SOS
SOS_ENABLED      = True
SOS_CALL_URL     = "https://swallow-dashboard.vercel.app/api/trigger-sos-call"
SOS_PHONE_NUMBER = "+17655329594"
SOS_CALL_LEVEL   = 3                  # fire Vapi call at Tier 3

# Vercel telemetry relay
TELEMETRY_URL      = "https://swallow-dashboard.vercel.app/api/telemetry"
TELEMETRY_INTERVAL = 0.2              # 5 Hz push

# Local HTTP + recordings
HTTP_PORT      = 7000
RECORDINGS_DIR = "/app/recordings"
MAX_MODEL_SIZE = 50 * 1024 * 1024     # 50 MB cap on uploaded .eim

try:
    os.makedirs(RECORDINGS_DIR, exist_ok=True)
except Exception as e:
    print(f"[init] couldn't create {RECORDINGS_DIR}: {e}", flush=True)


# ============================================================================
# SHARED STATE (thread-safe)
# ============================================================================
_state_lock = threading.Lock()
_state = {
    "uptime_s":      0,
    "idle_s":        0,
    "alert_level":   0,
    "swallow_count": 0,
    "probs":         {"idle": 1.0, "swallow": 0.0, "cough": 0.0, "speech": 0.0},
    "throat_rms":    0.0,
    "sternum_rms":   0.0,
    "ratio":         0.0,
    "mpu_status":    0,              # 1=throat,2=sternum,3=both,0=none
    "model_loaded":  False,
    "model_labels":  [],
    "recording":     False,
}

def update_state(**kwargs):
    with _state_lock:
        _state.update(kwargs)

def snapshot_state():
    with _state_lock:
        snap = dict(_state)
        snap["probs"] = dict(snap["probs"])
        return snap


# ============================================================================
# RECORDER — tap into the live sample stream
# ============================================================================
_rec_lock       = threading.Lock()
_rec_active     = False
_rec_label      = "swallow"
_rec_buffer     = []
_rec_started_ms = 0
_rec_duration_s = 0
_rec_last_file  = None


def rec_start(label, duration_s):
    global _rec_active, _rec_label, _rec_buffer, _rec_started_ms, _rec_duration_s, _rec_last_file
    with _rec_lock:
        _rec_label      = (label or "swallow").strip() or "swallow"
        _rec_buffer     = []
        _rec_started_ms = int(time.time() * 1000)
        _rec_duration_s = max(0, int(duration_s or 0))
        _rec_last_file  = None
        _rec_active     = True
    update_state(recording=True)
    print(f"[rec] START label='{_rec_label}' duration={_rec_duration_s}s", flush=True)


def rec_stop():
    global _rec_active, _rec_last_file
    with _rec_lock:
        _rec_active = False
        buf = list(_rec_buffer)
        label = _rec_label
    update_state(recording=False)
    if not buf:
        print("[rec] STOP — empty buffer, nothing saved", flush=True)
        return None
    ts = time.strftime("%Y%m%d_%H%M%S")
    filename = f"{label}.{ts}.csv"
    filepath = os.path.join(RECORDINGS_DIR, filename)
    try:
        with open(filepath, "w") as f:
            f.write("timestamp,t_ax,t_ay,t_az,s_ax,s_ay,s_az\n")
            for t, tax, tay, taz, sax, say, saz in buf:
                f.write(f"{t},{tax:.6f},{tay:.6f},{taz:.6f},"
                        f"{sax:.6f},{say:.6f},{saz:.6f}\n")
        _rec_last_file = filepath
        print(f"[rec] SAVED {filename} ({len(buf)} samples)", flush=True)
        return filepath
    except Exception as e:
        print(f"[rec] SAVE FAILED: {e}", flush=True)
        return None


def rec_add_sample(s):
    if not _rec_active:
        return
    with _rec_lock:
        if not _rec_active:
            return
        rel_ms = int(time.time() * 1000) - _rec_started_ms
        _rec_buffer.append((rel_ms,
                            s["t_ax"], s["t_ay"], s["t_az"],
                            s["s_ax"], s["s_ay"], s["s_az"]))
        if _rec_duration_s > 0 and rel_ms >= _rec_duration_s * 1000:
            need_stop = True
        else:
            need_stop = False
    if need_stop:
        rec_stop()


def rec_status():
    with _rec_lock:
        elapsed_ms = (int(time.time() * 1000) - _rec_started_ms) if _rec_active else 0
        return {
            "active":     _rec_active,
            "label":      _rec_label,
            "duration_s": _rec_duration_s,
            "samples":    len(_rec_buffer),
            "elapsed_ms": elapsed_ms,
            "last_file":  os.path.basename(_rec_last_file) if _rec_last_file else None,
        }


def rec_list():
    try:
        out = []
        for name in sorted(os.listdir(RECORDINGS_DIR), reverse=True):
            if not name.endswith(".csv"):
                continue
            st = os.stat(os.path.join(RECORDINGS_DIR, name))
            out.append({
                "name": name,
                "size_kb": round(st.st_size / 1024, 1),
                "mtime": int(st.st_mtime),
            })
        return out
    except Exception:
        return []


# ============================================================================
# MODEL HOT-SWAP
# ============================================================================
_model_lock         = threading.Lock()
_model_needs_reload = False


def model_info():
    info = {
        "path":      MODEL_PATH,
        "exists":    os.path.exists(MODEL_PATH),
        "loaded":    False,
        "labels":    [],
        "size_mb":   0,
    }
    try:
        if info["exists"]:
            info["size_mb"] = round(os.path.getsize(MODEL_PATH) / 1024 / 1024, 2)
    except Exception:
        pass
    with _state_lock:
        info["loaded"] = _state.get("model_loaded", False)
        info["labels"] = list(_state.get("model_labels", []))
    return info


def upload_model(raw_bytes):
    """Atomically swap in a new .eim file. Returns {ok, labels, size_mb} or {ok: False, error}."""
    global _model_needs_reload
    if not HAVE_EI:
        return {"ok": False, "error": "edge_impulse_linux not installed in container"}
    if len(raw_bytes) < 1000:
        return {"ok": False, "error": "File too small (not a valid .eim)"}
    if len(raw_bytes) > MAX_MODEL_SIZE:
        return {"ok": False, "error": f"File too large (> {MAX_MODEL_SIZE//1024//1024} MB)"}

    staging = "/tmp/model_staging.eim"
    try:
        with open(staging, "wb") as f:
            f.write(raw_bytes)
        os.chmod(staging, 0o755)
    except Exception as e:
        return {"ok": False, "error": f"Failed to write staging file: {e}"}

    try:
        test_runner = ImpulseRunner(staging)
        info = test_runner.init()
        labels = info["model_parameters"]["labels"]
        test_runner.stop()
    except Exception as e:
        try: os.remove(staging)
        except Exception: pass
        return {"ok": False, "error": f"Model validation failed: {e}"}

    try:
        if os.path.exists(MODEL_PATH):
            shutil.copy(MODEL_PATH, MODEL_BACKUP)
        shutil.move(staging, MODEL_PATH)
        os.chmod(MODEL_PATH, 0o755)
    except Exception as e:
        return {"ok": False, "error": f"Failed to swap model file: {e}"}

    with _model_lock:
        _model_needs_reload = True

    print(f"[model] UPLOADED new .eim ({len(raw_bytes)/1024/1024:.1f} MB) "
          f"labels={labels} — reload pending", flush=True)

    return {
        "ok": True,
        "labels": labels,
        "size_mb": round(len(raw_bytes) / 1024 / 1024, 2),
        "message": "Model uploaded and validated. Reload will take effect within 1 second.",
    }


# ============================================================================
# VERCEL TELEMETRY + VAPI SOS CALL
# ============================================================================
_telemetry_ok_count  = 0
_telemetry_err_count = 0

def publish_telemetry_once():
    global _telemetry_ok_count, _telemetry_err_count
    try:
        payload = json.dumps(snapshot_state()).encode()
        req = urllib.request.Request(
            TELEMETRY_URL, data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            if resp.status == 200:
                _telemetry_ok_count += 1
                if _telemetry_ok_count % 150 == 1:
                    print(f"[telemetry] @ 5Hz (ok={_telemetry_ok_count}, "
                          f"err={_telemetry_err_count})", flush=True)
    except Exception as e:
        _telemetry_err_count += 1
        if _telemetry_err_count % 30 == 1:
            print(f"[telemetry] error: {e}", flush=True)


def telemetry_loop():
    while True:
        try:
            publish_telemetry_once()
        except Exception:
            pass
        time.sleep(TELEMETRY_INTERVAL)


def fire_sos_call():
    if not SOS_ENABLED:
        return
    try:
        payload = json.dumps({"phoneNumber": SOS_PHONE_NUMBER}).encode()
        req = urllib.request.Request(
            SOS_CALL_URL, data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"[sos] Vapi call triggered → status {resp.status}", flush=True)
    except Exception as e:
        print(f"[sos] call failed: {e}", flush=True)


# ============================================================================
# HTTP SERVER
# ============================================================================
RECORDER_HTML = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChYme Device Console</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:#0e1512;color:#e8efea;min-height:100vh;padding:24px}
  .wrap{max-width:760px;margin:0 auto}
  h1{margin:0 0 4px;font-size:26px;letter-spacing:-0.5px}
  .sub{color:#7a8c85;font-size:13px;margin-bottom:24px}
  .card{background:#182522;border:1px solid #2a3a36;border-radius:14px;
        padding:20px;margin-bottom:16px}
  h2{font-size:13px;margin:0 0 14px;color:#a2b6af;letter-spacing:0.08em;
     text-transform:uppercase;font-weight:700;display:flex;align-items:center;gap:8px}
  label{display:block;font-size:12px;color:#a2b6af;letter-spacing:0.08em;
        text-transform:uppercase;margin-bottom:8px;font-weight:600}
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
  .chip{padding:10px 16px;border-radius:999px;border:1px solid #2a3a36;
        background:#0e1512;color:#e8efea;cursor:pointer;font-size:14px;
        font-family:inherit;transition:all .15s}
  .chip:hover{border-color:#557d72}
  .chip.active{background:#557d72;border-color:#557d72;color:#fff}
  .big-btn{width:100%;padding:18px;border-radius:14px;border:none;font-size:17px;
           font-weight:700;cursor:pointer;font-family:inherit;background:#37a184;
           color:#fff;transition:all .15s;letter-spacing:0.02em}
  .big-btn:hover{background:#41b896}
  .big-btn:disabled{background:#2a3a36;cursor:not-allowed;color:#5a6f69}
  .big-btn.recording{background:#d64545;animation:pulse 1s infinite}
  .big-btn.secondary{background:#5a7dc7}
  .big-btn.secondary:hover{background:#6a8dd7}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.75}}
  .status{background:#0e1512;border-radius:10px;padding:14px 16px;
          font-family:ui-monospace,Consolas,monospace;font-size:13px;
          color:#a2b6af;margin-top:14px;border:1px solid #2a3a36}
  .status .row{display:flex;justify-content:space-between;padding:3px 0}
  .status .val{color:#e8efea;font-weight:600}
  .recordings{display:flex;flex-direction:column;gap:6px;max-height:360px;overflow-y:auto}
  .rec-item{display:flex;justify-content:space-between;align-items:center;
            padding:10px 14px;background:#0e1512;border-radius:8px;
            border:1px solid #2a3a36;font-size:13px;gap:10px}
  .rec-item a{color:#41b896;text-decoration:none;font-weight:600}
  .rec-name{font-family:ui-monospace,Consolas,monospace;font-size:12px}
  .rec-meta{color:#7a8c85;font-size:11px;font-family:ui-monospace,monospace}
  .empty{color:#5a6f69;text-align:center;padding:24px;font-size:13px}
  .progress-wrap{margin-top:12px;height:6px;background:#0e1512;border-radius:3px;
                 overflow:hidden;border:1px solid #2a3a36}
  .progress{height:100%;background:#37a184;width:0%;transition:width .15s}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .dot-ok{background:#37a184;box-shadow:0 0 0 3px rgba(55,161,132,0.2)}
  .dot-bad{background:#d64545;box-shadow:0 0 0 3px rgba(214,69,69,0.2)}
  .dot-warn{background:#e0a836}
  .label-badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;
               font-weight:700;letter-spacing:0.05em;text-transform:uppercase;margin-right:8px;
               min-width:62px;text-align:center}
  .label-swallow{background:rgba(85,125,114,0.25);color:#9ed4c1;border:1px solid #557d72}
  .label-idle   {background:rgba(122,140,133,0.2); color:#a2b6af;border:1px solid #4a5d57}
  .label-cough  {background:rgba(214,69,69,0.2);   color:#f09999;border:1px solid #8b3333}
  .label-speech {background:rgba(214,166,69,0.2);  color:#edc687;border:1px solid #8b6833}
  .label-other  {background:rgba(80,80,80,0.2);    color:#a0a0a0;border:1px solid #444}
  .counts{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:12px;
          border-bottom:1px solid #2a3a36}
  .count-pill{font-size:11px;color:#a2b6af;padding:4px 10px;background:#0e1512;
              border-radius:999px;border:1px solid #2a3a36;font-family:ui-monospace,monospace}
  .count-pill strong{color:#41b896;margin-right:4px}
  .banner{padding:12px 16px;border-radius:10px;margin-top:12px;font-size:13px;
          background:rgba(55,161,132,0.15);color:#9ed4c1;border:1px solid #37a184;display:none}
  .banner.err{background:rgba(214,69,69,0.15);color:#f09999;border-color:#d64545}
  .banner.show{display:block}
  .tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid #2a3a36}
  .tab{padding:10px 16px;cursor:pointer;color:#7a8c85;font-size:13px;
       border-bottom:2px solid transparent;font-weight:600}
  .tab.active{color:#e8efea;border-bottom-color:#37a184}
  .tab:hover{color:#e8efea}
  .page{display:none}
  .page.active{display:block}
</style></head>
<body><div class="wrap">

<h1>ChYme Device Console</h1>
<div class="sub">Local UI for your ChYme device. Training-data recorder, model upload, live status.</div>

<div class="tabs">
  <div class="tab active" data-page="record">Record</div>
  <div class="tab" data-page="model">Model</div>
  <div class="tab" data-page="status">Live status</div>
</div>

<!-- RECORD PAGE -->
<div class="page active" id="page-record">
  <div class="card">
    <label>Label</label>
    <div class="chips" id="labels">
      <button class="chip active" data-val="swallow">swallow</button>
      <button class="chip" data-val="idle">idle</button>
      <button class="chip" data-val="cough">cough</button>
      <button class="chip" data-val="speech">speech</button>
    </div>
    <label>Duration</label>
    <div class="chips" id="durations">
      <button class="chip" data-val="2">2s</button>
      <button class="chip active" data-val="5">5s</button>
      <button class="chip" data-val="10">10s</button>
      <button class="chip" data-val="30">30s</button>
      <button class="chip" data-val="0">manual stop</button>
    </div>
    <button id="record" class="big-btn">Start Recording</button>
    <div class="progress-wrap"><div id="progress" class="progress"></div></div>
    <div class="status">
      <div class="row"><span><span class="dot dot-ok"></span>Sensor stream</span><span class="val" id="s-stream">checking</span></div>
      <div class="row"><span>Status</span><span class="val" id="s-state">idle</span></div>
      <div class="row"><span>Samples captured</span><span class="val" id="s-samples">0</span></div>
      <div class="row"><span>Elapsed</span><span class="val" id="s-elapsed">0.00s</span></div>
      <div class="row"><span>Last saved</span><span class="val" id="s-last">-</span></div>
    </div>
  </div>
  <div class="card">
    <h2>Recordings on device</h2>
    <div class="recordings" id="recordings"><div class="empty">Loading...</div></div>
  </div>
</div>

<!-- MODEL PAGE -->
<div class="page" id="page-model">
  <div class="card">
    <h2>Current model</h2>
    <div class="status">
      <div class="row"><span>Status</span><span class="val" id="m-status">checking</span></div>
      <div class="row"><span>Labels</span><span class="val" id="m-labels">-</span></div>
      <div class="row"><span>File size</span><span class="val" id="m-size">-</span></div>
      <div class="row"><span>Path</span><span class="val" id="m-path">-</span></div>
    </div>
  </div>
  <div class="card">
    <h2>Upload new .eim</h2>
    <p style="color:#a2b6af;font-size:13px;margin:0 0 14px">
      Replace the running model with a new Edge Impulse deployment (Linux AARCH64 .eim file).
      The model is validated before swap. If it can't load, the current one stays.
      Hot-swap: no container restart required.
    </p>
    <input type="file" id="model-file" accept=".eim" style="display:none" onchange="uploadModel()">
    <button class="big-btn secondary" onclick="document.getElementById('model-file').click()">
      Choose .eim file to upload
    </button>
    <div id="upload-banner" class="banner"></div>
    <div class="progress-wrap" style="margin-top:12px"><div id="upload-progress" class="progress"></div></div>
  </div>
</div>

<!-- LIVE STATUS PAGE -->
<div class="page" id="page-status">
  <div class="card">
    <h2>Live inference</h2>
    <div class="status">
      <div class="row"><span>Top class</span><span class="val" id="l-top">-</span></div>
      <div class="row"><span>swallow</span><span class="val" id="l-swallow">-</span></div>
      <div class="row"><span>idle</span><span class="val" id="l-idle">-</span></div>
      <div class="row"><span>cough</span><span class="val" id="l-cough">-</span></div>
      <div class="row"><span>speech</span><span class="val" id="l-speech">-</span></div>
    </div>
  </div>
  <div class="card">
    <h2>Alert state</h2>
    <div class="status">
      <div class="row"><span>Idle seconds</span><span class="val" id="l-idle_s">-</span></div>
      <div class="row"><span>Alert level (0-3)</span><span class="val" id="l-tier">-</span></div>
      <div class="row"><span>Swallow count</span><span class="val" id="l-count">-</span></div>
      <div class="row"><span>Uptime</span><span class="val" id="l-uptime">-</span></div>
    </div>
  </div>
  <div class="card">
    <h2>Sensors</h2>
    <div class="status">
      <div class="row"><span>Throat MPU (0x68)</span><span class="val" id="l-throat">-</span></div>
      <div class="row"><span>Sternum MPU (0x69)</span><span class="val" id="l-sternum">-</span></div>
      <div class="row"><span>T/S ratio</span><span class="val" id="l-ratio">-</span></div>
      <div class="row"><span>Throat RMS (g)</span><span class="val" id="l-trms">-</span></div>
      <div class="row"><span>Sternum RMS (g)</span><span class="val" id="l-srms">-</span></div>
    </div>
  </div>
</div>

</div>
<script>
const $ = (id) => document.getElementById(id);
let selLabel = "swallow", selDuration = 5, isRecording = false;
let lastSampleCount = 0, lastSampleAt = 0;

document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('page-' + t.dataset.page).classList.add('active');
  };
});

function setupChips(groupId, cb) {
  document.querySelectorAll(`#${groupId} .chip`).forEach(btn => {
    btn.onclick = () => {
      if (isRecording) return;
      document.querySelectorAll(`#${groupId} .chip`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cb(btn.dataset.val);
    };
  });
}
setupChips('labels',    v => selLabel = v);
setupChips('durations', v => selDuration = Number(v));

$('record').onclick = async () => {
  if (!isRecording) {
    const r = await fetch('/record/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({label: selLabel, duration_s: selDuration}),
    });
    if (!r.ok) { alert('Start failed'); return; }
    isRecording = true;
    $('record').textContent = 'Stop Recording';
    $('record').classList.add('recording');
  } else {
    await fetch('/record/stop', {method: 'POST'});
    isRecording = false;
    $('record').textContent = 'Start Recording';
    $('record').classList.remove('recording');
    await refreshRecordings();
  }
};

async function refreshRecStatus() {
  try {
    const r = await fetch('/record/status');
    if (!r.ok) return;
    const d = await r.json();
    $('s-state').textContent   = d.active ? `recording "${d.label}"` : 'idle';
    $('s-samples').textContent = d.samples;
    $('s-elapsed').textContent = (d.elapsed_ms / 1000).toFixed(2) + 's';
    $('s-last').textContent    = d.last_file || '-';
    if (d.active) {
      if (d.samples > lastSampleCount) {
        $('s-stream').textContent = 'live (' + Math.round((d.samples-lastSampleCount)*5) + ' Hz)';
        $('s-stream').style.color = '#41b896';
        lastSampleCount = d.samples; lastSampleAt = Date.now();
      } else if (Date.now() - lastSampleAt > 1000) {
        $('s-stream').textContent = 'stalled'; $('s-stream').style.color = '#d64545';
      }
    } else {
      $('s-stream').textContent = 'ready'; $('s-stream').style.color = '#a2b6af';
      lastSampleCount = 0;
    }
    if (d.duration_s > 0 && d.active) {
      $('progress').style.width = Math.min(100, (d.elapsed_ms/(d.duration_s*1000))*100) + '%';
    } else {
      $('progress').style.width = isRecording ? '100%' : '0%';
    }
    if (!d.active && isRecording) {
      isRecording = false;
      $('record').textContent = 'Start Recording';
      $('record').classList.remove('recording');
      await refreshRecordings();
    }
  } catch {}
}

async function refreshRecordings() {
  try {
    const r = await fetch('/recordings');
    const list = await r.json();
    const el = $('recordings');
    if (list.length === 0) {
      el.innerHTML = '<div class="empty">No recordings yet.</div>'; return;
    }
    const extract = n => (n.match(/^([a-zA-Z]+)[._]/) || [,'other'])[1].toLowerCase();
    const counts = {};
    list.forEach(f => { const l = extract(f.name); counts[l] = (counts[l]||0)+1; });
    const pills = Object.entries(counts).sort((a,b)=>b[1]-a[1])
      .map(([l,c])=>`<span class="count-pill"><strong>${c}</strong>${l}</span>`).join('');
    const rows = list.map(f => {
      const label = extract(f.name);
      const klass = ['swallow','idle','cough','speech'].includes(label) ? label : 'other';
      return `<div class="rec-item">
        <div style="display:flex;align-items:center;flex:1;min-width:0">
          <span class="label-badge label-${klass}">${label}</span>
          <div style="min-width:0;overflow:hidden">
            <a href="/recordings/${encodeURIComponent(f.name)}" download class="rec-name">${f.name}</a>
            <div class="rec-meta">${f.size_kb} KB</div>
          </div>
        </div>
        <a href="/recordings/${encodeURIComponent(f.name)}" download>download</a>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="counts">${pills}</div>${rows}`;
  } catch {}
}

async function refreshModelInfo() {
  try {
    const r = await fetch('/model/info');
    const d = await r.json();
    $('m-status').textContent = d.loaded ? 'loaded and running inference'
                                         : d.exists ? 'file present, not loaded'
                                         : 'no model on device';
    $('m-status').style.color = d.loaded ? '#41b896' : d.exists ? '#e0a836' : '#d64545';
    $('m-labels').textContent = d.labels.length ? d.labels.join(', ') : '-';
    $('m-size').textContent   = d.size_mb ? d.size_mb + ' MB' : '-';
    $('m-path').textContent   = d.path;
  } catch {}
}

async function uploadModel() {
  const input = $('model-file');
  const file = input.files[0];
  if (!file) return;
  const banner = $('upload-banner');
  banner.className = 'banner show';
  banner.textContent = `Uploading ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)...`;
  $('upload-progress').style.width = '30%';

  try {
    const bytes = await file.arrayBuffer();
    $('upload-progress').style.width = '60%';
    const r = await fetch('/model/upload', {
      method: 'POST',
      headers: {'Content-Type': 'application/octet-stream'},
      body: bytes,
    });
    $('upload-progress').style.width = '100%';
    const data = await r.json();
    if (data.ok) {
      banner.className = 'banner show';
      banner.textContent = `OK - ${data.message}  Labels: ${data.labels.join(', ')}`;
      setTimeout(refreshModelInfo, 2000);
    } else {
      banner.className = 'banner err show';
      banner.textContent = `FAIL - ${data.error}`;
    }
  } catch (e) {
    banner.className = 'banner err show';
    banner.textContent = `Upload failed: ${e.message}`;
  }
  input.value = '';
  setTimeout(() => { $('upload-progress').style.width = '0%'; }, 2500);
}

async function refreshLiveStatus() {
  try {
    const r = await fetch('/status');
    const d = await r.json();
    const classes = ['swallow','idle','cough','speech'];
    const probs = d.probs || {};
    const top = classes.reduce((a,b) => (probs[b]||0) > (probs[a]||0) ? b : a, 'idle');
    $('l-top').textContent = top + ' (' + ((probs[top]||0)*100).toFixed(0) + '%)';
    classes.forEach(c => {
      const el = $('l-' + c); if (el) el.textContent = ((probs[c]||0)*100).toFixed(1) + '%';
    });
    $('l-idle_s').textContent = d.idle_s + 's';
    $('l-tier').textContent   = d.alert_level;
    $('l-count').textContent  = d.swallow_count;
    $('l-uptime').textContent = Math.floor(d.uptime_s/60) + 'm ' + (d.uptime_s%60) + 's';
    const mpu = d.mpu_status || 0;
    $('l-throat').textContent  = (mpu & 1) ? 'streaming' : 'not detected';
    $('l-throat').style.color  = (mpu & 1) ? '#41b896' : '#d64545';
    $('l-sternum').textContent = (mpu & 2) ? 'streaming' : 'not detected';
    $('l-sternum').style.color = (mpu & 2) ? '#41b896' : '#d64545';
    $('l-ratio').textContent   = (d.ratio || 0).toFixed(2);
    $('l-trms').textContent    = (d.throat_rms || 0).toFixed(3);
    $('l-srms').textContent    = (d.sternum_rms || 0).toFixed(3);
  } catch {}
}

setInterval(refreshRecStatus, 200);
setInterval(refreshLiveStatus, 300);
setInterval(refreshModelInfo, 3000);
refreshRecStatus(); refreshRecordings(); refreshModelInfo(); refreshLiveStatus();
</script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def _send_html(self, html):
        body = html.encode()
        self.send_response(200); self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def _send_file(self, path, ctype, dlname):
        try:
            with open(path, "rb") as f: data = f.read()
        except Exception:
            self.send_response(404); self._cors(); self.end_headers(); return
        self.send_response(200); self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{dlname}"')
        self.end_headers(); self.wfile.write(data)

    def _read_json(self):
        try:
            ln = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(ln) if ln > 0 else b""
            return json.loads(raw.decode()) if raw else {}
        except Exception:
            return {}

    def _read_bytes(self):
        ln = int(self.headers.get("Content-Length", "0"))
        if ln <= 0: return b""
        chunks = []
        remaining = ln
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk: break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/", "/record", "/record/"):
            return self._send_html(RECORDER_HTML)
        if p == "/status":
            return self._send_json(snapshot_state())
        if p == "/record/status":
            return self._send_json(rec_status())
        if p == "/recordings":
            return self._send_json(rec_list())
        if p == "/model/info":
            return self._send_json(model_info())
        if p.startswith("/recordings/"):
            fname = urllib.parse.unquote(p[len("/recordings/"):])
            safe = os.path.basename(fname)
            if safe != fname or ".." in fname:
                return self._send_json({"error":"bad filename"}, 400)
            fpath = os.path.join(RECORDINGS_DIR, safe)
            if not os.path.isfile(fpath):
                return self._send_json({"error":"not found"}, 404)
            return self._send_file(fpath, "text/csv", safe)
        self.send_response(404); self._cors(); self.end_headers()

    def do_POST(self):
        p = self.path.split("?")[0]
        if p == "/record/start":
            body = self._read_json()
            rec_start(str(body.get("label","swallow")), int(body.get("duration_s",5)))
            return self._send_json({"ok": True})
        if p == "/record/stop":
            path = rec_stop()
            return self._send_json({"ok": True,
                                    "saved": os.path.basename(path) if path else None})
        if p == "/model/upload":
            raw = self._read_bytes()
            result = upload_model(raw)
            return self._send_json(result, 200 if result.get("ok") else 400)
        self.send_response(404); self._cors(); self.end_headers()

    def log_message(self, *a, **kw): pass


class ReusableServer(HTTPServer):
    allow_reuse_address = True


_HTTP_STARTED = False
_TELEM_STARTED = False

def ensure_http_server():
    global _HTTP_STARTED
    if _HTTP_STARTED: return
    _HTTP_STARTED = True
    try:
        srv = ReusableServer(("0.0.0.0", HTTP_PORT), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True, name="http").start()
        print(f"[http] console at http://<device-ip>:{HTTP_PORT}/", flush=True)
    except Exception as e:
        print(f"[http] startup failed: {e}", flush=True)


def ensure_telemetry():
    global _TELEM_STARTED
    if _TELEM_STARTED: return
    _TELEM_STARTED = True
    threading.Thread(target=telemetry_loop, daemon=True, name="telemetry").start()
    print(f"[telemetry] publishing to {TELEMETRY_URL} @ {1/TELEMETRY_INTERVAL:.0f}Hz",
          flush=True)


# ============================================================================
# MPU + MODEL LIFECYCLE
# ============================================================================
def init_mpus_forever():
    print("[init] waiting for MPUs via Bridge...", flush=True)
    while True:
        try:
            r = Bridge.call("mpu_init")
            if r and r > 0:
                name = {1:"throat only", 2:"sternum only", 3:"both"}.get(r, "unknown")
                print(f"[init] mpu_init -> {r} ({name})", flush=True)
                update_state(mpu_status=r)
                return r
        except Exception as e:
            print(f"[init] Bridge not ready: {e}", flush=True)
        time.sleep(2)


def load_model_once():
    """Try to load .eim once. Returns runner or None."""
    if not HAVE_EI:
        print("[model] edge_impulse_linux not installed - recorder-only mode", flush=True)
        return None
    if not os.path.exists(MODEL_PATH):
        print(f"[model] {MODEL_PATH} not found - recorder-only mode until uploaded", flush=True)
        return None
    try:
        r = ImpulseRunner(MODEL_PATH)
        info = r.init()
        labels = info["model_parameters"]["labels"]
        print(f"[model] Loaded. Labels: {labels}", flush=True)
        update_state(model_loaded=True, model_labels=list(labels))
        return r
    except Exception as e:
        print(f"[model] failed to load: {e}", flush=True)
        update_state(model_loaded=False, model_labels=[])
        return None


def parse_mpu_line(line):
    """Sketch returns:  t_ax,t_ay,t_az,t_mag,s_ax,s_ay,s_az,s_mag,ratio"""
    try:
        p = line.split(",")
        if len(p) < 9: return None
        return {
            "t_ax": float(p[0]), "t_ay": float(p[1]), "t_az": float(p[2]),
            "t_mag": float(p[3]),
            "s_ax": float(p[4]), "s_ay": float(p[5]), "s_az": float(p[6]),
            "s_mag": float(p[7]),
            "ratio": float(p[8]),
        }
    except Exception:
        return None


def flatten_window(window):
    """Window is deque of sample dicts. Flatten to 6-axis interleaved floats for EI."""
    out = []
    for s in window:
        out.extend([s["t_ax"], s["t_ay"], s["t_az"],
                    s["s_ax"], s["s_ay"], s["s_az"]])
    return out


# ============================================================================
# MAIN INFERENCE LOOP
# ============================================================================
def inference_loop():
    global _model_needs_reload

    runner = load_model_once()
    window = deque(maxlen=WINDOW_SAMPLES)
    session_start  = time.time()
    last_swallow   = time.time()
    last_infer     = 0.0
    fired_level    = 0
    swallow_count  = 0
    heart_until    = 0.0

    mpu_err_count  = 0
    MPU_ERR_RESET  = 30

    period = 1.0 / SAMPLE_RATE_HZ
    next_t = time.monotonic()

    print("[loop] inference + sampling running", flush=True)

    while True:
        now = time.time()
        idle = int(now - last_swallow)

        with _model_lock:
            should_reload = _model_needs_reload
            _model_needs_reload = False
        if should_reload:
            print("[model] hot-swap: reloading runner...", flush=True)
            try:
                if runner is not None:
                    runner.stop()
            except Exception:
                pass
            runner = load_model_once()
            window.clear()

        try:
            line = Bridge.call("mpu_read")
            s = parse_mpu_line(line)
            if s is not None:
                window.append(s)
                rec_add_sample(s)
                mpu_err_count = 0
            else:
                mpu_err_count += 1
        except Exception as e:
            mpu_err_count += 1
            if mpu_err_count % 100 == 1:
                print(f"[loop] mpu_read err: {e}", flush=True)
        if mpu_err_count > MPU_ERR_RESET:
            print("[loop] too many MPU errors - re-initializing", flush=True)
            init_mpus_forever()
            mpu_err_count = 0

        latest_probs = dict(_state.get("probs", {}))
        if runner is not None and len(window) == WINDOW_SAMPLES and (now - last_infer) >= INFERENCE_EVERY_S:
            last_infer = now
            try:
                r = runner.classify(flatten_window(window))
                latest_probs = r["result"]["classification"]
                top = max(latest_probs.items(), key=lambda kv: kv[1])

                if (latest_probs.get("swallow", 0) >= SWALLOW_THRESH
                        and (now - last_swallow) >= SWALLOW_COOLDOWN):
                    swallow_count += 1
                    last_swallow = now
                    if fired_level > 0:
                        print("  >>> RECOVERY - alert cleared", flush=True)
                    fired_level = 0
                    print(f"  >>> SWALLOW (p={latest_probs['swallow']:.2f}, "
                          f"count={swallow_count})", flush=True)
                    try:
                        Bridge.call("matrix_show", 4)
                        heart_until = now + 2.0
                    except Exception: pass
            except Exception as e:
                if int(now) % 10 == 0:
                    print(f"[classify] err: {e}", flush=True)

        for i, (thresh_s, buzz_n) in enumerate(ALERTS):
            level = i + 1
            if idle >= thresh_s and fired_level < level:
                fired_level = level
                print(f"\n=== ALERT Tier {level} @ {idle}s ===", flush=True)
                try:
                    Bridge.call("matrix_show", level)
                except Exception as e:
                    print(f"  [matrix] err: {e}", flush=True)
                try:
                    result = Bridge.call("buzz", buzz_n)
                    print(f"  [buzz x{buzz_n}] -> {result}", flush=True)
                except Exception as e:
                    print(f"  [buzz] err: {e}", flush=True)
                if level >= SOS_CALL_LEVEL:
                    fire_sos_call()
                break

        if heart_until > 0 and now >= heart_until and fired_level == 0:
            heart_until = 0.0
            try: Bridge.call("matrix_show", 0)
            except Exception: pass

        if len(window) > 0:
            s = window[-1]
            update_state(
                uptime_s      = int(now - session_start),
                idle_s        = idle,
                alert_level   = fired_level,
                swallow_count = swallow_count,
                probs         = latest_probs,
                throat_rms    = s["t_mag"],
                sternum_rms   = s["s_mag"],
                ratio         = s["ratio"],
            )

        next_t += period
        delay = next_t - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            next_t = time.monotonic()


# ============================================================================
# ENTRY POINT
# ============================================================================
def main():
    ensure_http_server()
    ensure_telemetry()

    print(f"[boot] ChYme starting  ML={'enabled' if HAVE_EI else 'DISABLED (pip install missing)'}",
          flush=True)

    while True:
        try:
            init_mpus_forever()
            inference_loop()
        except Exception as e:
            print(f"[main] loop crashed: {e}", flush=True)
            traceback.print_exc()
            time.sleep(3)


if __name__ == "__main__":
    main()
