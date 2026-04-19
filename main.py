#!/usr/bin/env python3
"""
SwallowSense - Edge Impulse inference with
  * dual MPU-6050 readout via Bridge RPC
  * Modulino Vibro haptic alerts (escalating 50/80/110s)
  * Vapi AI SOS phone call at Tier 3
  * HTTP /status endpoint on port 7000 for live dashboard
"""

import json
import time
import threading
import urllib.request
import urllib.error
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer

from arduino.app_utils import App, Bridge
from edge_impulse_linux.runner import ImpulseRunner


# ===========================================================================
# Config
# ===========================================================================
MODEL_PATH        = "/app/python/model.eim"
INPUT_SIZE        = 600
WINDOW_SAMPLES    = 100
SAMPLE_RATE_HZ    = 100
INFERENCE_EVERY_S = 0.2
SWALLOW_THRESH    = 0.30

# Alert ladder: (idle_seconds, buzz_count)
ALERTS = [(50, 1), (80, 2), (110, 3)]

# SOS call configuration (Vapi via Vercel serverless)
SOS_ENABLED      = True
SOS_CALL_URL     = "https://swallow-dashboard.vercel.app/api/trigger-sos-call"
SOS_PHONE_NUMBER = "+17655329594"
SOS_CALL_LEVEL   = 3   # Fire call at alert level >= 3 (Tier 3 Critical)

# HTTP telemetry server
HTTP_PORT = 7000


# ===========================================================================
# Shared live state (read by HTTP server, written by main loop)
# ===========================================================================
_state_lock = threading.Lock()
_state = {
    "probs":          {"idle": 1.0, "swallow": 0.0, "cough": 0.0, "speech": 0.0},
    "throat_rms":     0.0,
    "sternum_rms":    0.0,
    "ratio":          0.0,
    "idle_s":         0,
    "alert_level":    0,
    "swallow_count":  0,
    "uptime_s":       0,
    "device_id":      "starkhacks-unoq-001",
    "model":          "swallowsense-v1",
}

def update_state(**kwargs):
    with _state_lock:
        _state.update(kwargs)

def snapshot_state():
    with _state_lock:
        return dict(_state)


# ===========================================================================
# HTTP /status server (runs in background thread)
# ===========================================================================
class StatusHandler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/status"):
            body = json.dumps(snapshot_state()).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/" or self.path.startswith("/health"):
            body = b'{"ok":true,"service":"swallowsense"}'
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def log_message(self, fmt, *args):
        # Silence access log noise
        return

def start_http_server():
    srv = HTTPServer(("0.0.0.0", HTTP_PORT), StatusHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True, name="http-status")
    t.start()
    print(f"[http] /status server listening on 0.0.0.0:{HTTP_PORT}", flush=True)


# ===========================================================================
# SOS call
# ===========================================================================
def fire_sos_call():
    if not SOS_ENABLED:
        print("  [SOS disabled in config]", flush=True)
        return
    print(f"  [SOS] dialing {SOS_PHONE_NUMBER} via Vapi...", flush=True)
    try:
        payload = json.dumps({"phoneNumber": SOS_PHONE_NUMBER}).encode()
        req = urllib.request.Request(
            SOS_CALL_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            body = resp.read().decode()
            print(f"  [SOS] OK — Vapi responded {resp.status}", flush=True)
            print(f"  [SOS] {body[:160]}", flush=True)
    except urllib.error.HTTPError as e:
        detail = e.read().decode() if hasattr(e, "read") else ""
        print(f"  [SOS] HTTP {e.code}: {detail[:180]}", flush=True)
    except Exception as e:
        print(f"  [SOS] ERROR: {e}", flush=True)


# ===========================================================================
# MCU helpers
# ===========================================================================
def parse_line(line):
    """Parse '9-field CSV' from mpu_read RPC."""
    if not line:
        return None
    parts = line.split(",")
    if len(parts) != 9:
        return None
    try:
        return {
            "raw": [
                float(parts[0]), float(parts[1]), float(parts[2]),
                float(parts[4]), float(parts[5]), float(parts[6]),
            ],
            "t_mag": float(parts[3]),
            "s_mag": float(parts[7]),
            "ratio": float(parts[8]),
        }
    except ValueError:
        return None

def flatten(window):
    out = []
    for s in window:
        out.extend(s["raw"])
    return out

def try_buzz(n):
    try:
        Bridge.call("buzz", n)
        print(f"  [buzz x{n}]", flush=True)
    except Exception as e:
        print(f"  [buzz err: {e}]", flush=True)


# ===========================================================================
# Main loop
# ===========================================================================
def main():
    print("SwallowSense booting...", flush=True)

    # Start HTTP server immediately (even if ML init fails, dashboard still connects)
    try:
        start_http_server()
    except Exception as e:
        print(f"[http] failed to start: {e}", flush=True)

    # Load ML model
    print("Loading Edge Impulse model...", flush=True)
    runner = ImpulseRunner(MODEL_PATH)
    info = runner.init()
    labels = info["model_parameters"]["labels"]
    print(f"Model loaded. Labels: {labels}", flush=True)

    # Init MCU sensors
    time.sleep(1.5)
    try:
        status = Bridge.call("mpu_init")
        print(f"mpu_init -> {status} (1=throat, 2=sternum, 3=both)", flush=True)
    except Exception as e:
        print(f"mpu_init failed: {e}", flush=True)
        return

    # State
    window        = deque(maxlen=WINDOW_SAMPLES)
    session_start = time.time()
    last_swallow  = time.time()
    last_infer    = 0.0
    fired_level   = 0
    swallow_count = 0

    period = 1.0 / SAMPLE_RATE_HZ
    next_t = time.monotonic()

    latest_probs  = {"idle": 1.0, "swallow": 0.0, "cough": 0.0, "speech": 0.0}
    latest_t_mag  = 0.0
    latest_s_mag  = 0.0
    latest_ratio  = 0.0

    print("Main loop running.", flush=True)

    while True:
        # --- 1. Sample sensor ---
        try:
            line = Bridge.call("mpu_read")
            sample = parse_line(line)
            if sample is not None:
                window.append(sample)
                latest_t_mag = sample["t_mag"]
                latest_s_mag = sample["s_mag"]
                latest_ratio = sample["ratio"]
        except Exception as e:
            print(f"mpu_read err: {e}", flush=True)
            time.sleep(0.1)
            continue

        now = time.time()
        idle = now - last_swallow

        # --- 2. Run inference at 5 Hz ---
        if len(window) == WINDOW_SAMPLES and (now - last_infer) >= INFERENCE_EVERY_S:
            last_infer = now
            try:
                r = runner.classify(flatten(window))
                probs = r["result"]["classification"]
                latest_probs = probs

                top = max(probs.items(), key=lambda x: x[1])
                print(
                    f"  {top[0]}:{top[1]:.2f}  "
                    f"swallow:{probs.get('swallow',0):.2f}  "
                    f"idle={int(idle)}s",
                    flush=True
                )

                if probs.get("swallow", 0) >= SWALLOW_THRESH:
                    swallow_count += 1
                    last_swallow = now
                    if fired_level > 0:
                        print("  >>> RECOVERY — alert cleared", flush=True)
                    fired_level = 0
                    print("  >>> SWALLOW DETECTED", flush=True)
            except Exception as e:
                print(f"classify err: {e}", flush=True)

        # --- 3. Fire escalating alerts ---
        for i, (thresh_s, buzz_n) in enumerate(ALERTS):
            level = i + 1
            if idle >= thresh_s and fired_level < level:
                fired_level = level
                print(f"\n=== ALERT Tier {level} @ {int(idle)}s ===", flush=True)
                try_buzz(buzz_n)
                if level >= SOS_CALL_LEVEL:
                    fire_sos_call()
                break

        # --- 4. Publish state to HTTP endpoint ---
        update_state(
            probs         = latest_probs,
            throat_rms    = round(latest_t_mag, 4),
            sternum_rms   = round(latest_s_mag, 4),
            ratio         = round(latest_ratio, 2),
            idle_s        = int(idle),
            alert_level   = fired_level,
            swallow_count = swallow_count,
            uptime_s      = int(now - session_start),
        )

        # --- 5. Pace loop to SAMPLE_RATE_HZ ---
        next_t += period
        sleep_for = next_t - time.monotonic()
        if sleep_for > 0:
            time.sleep(sleep_for)
        else:
            next_t = time.monotonic()


App.run(main)
