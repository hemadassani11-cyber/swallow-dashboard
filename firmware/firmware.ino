// ============================================================================
// ChYme — SwallowSense MCU firmware (final)
// ----------------------------------------------------------------------------
// Hardware:
//   - Dual MPU-6050 accelerometers on Wire (I2C): throat 0x68, sternum 0x69
//   - Modulino Vibro haptic motor on Wire1 (Qwiic)
//   - Built-in 12x8 LED matrix
//
// Bridge RPCs exposed to Python:
//   mpu_init()           -> int  (1=throat, 2=sternum, 3=both, 0=none)
//   mpu_read()           -> "t_ax,t_ay,t_az,t_mag,s_ax,s_ay,s_az,s_mag,ratio"
//   buzz(count)          -> bool (count 1-5; 3+ triggers sustained SOS pattern)
//   matrix_show(state)   -> bool (0=idle, 1=tier1, 2=tier2, 3=tier3, 4=swallow)
// ============================================================================

#include <Wire.h>
#include <Arduino_RouterBridge.h>
#include <Modulino.h>
#include "ArduinoGraphics.h"
#include "Arduino_LED_Matrix.h"

#define THROAT_ADDR  0x68
#define STERNUM_ADDR 0x69

ModulinoVibro vibro;
ArduinoLEDMatrix matrix;

bool throat_ok  = false;
bool sternum_ok = false;
bool vibro_ok   = false;

// ---------------------------------------------------------------------------
// LED matrix frames (12 cols x 8 rows, row-major)
// ---------------------------------------------------------------------------

// IDLE — two dots echoing the ChYme logo
uint8_t FRAME_IDLE[8][12] = {
  {0,0,0,0,0,0,0,0,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,0,0,0,0,0,0,0,0},
  {0,0,0,0,0,0,0,0,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,0,0,0,0,0,0,0,0},
};

// SWALLOW — heart (success feedback)
uint8_t FRAME_SWALLOW[8][12] = {
  {0,0,1,1,0,0,0,0,1,1,0,0},
  {0,1,1,1,1,0,0,1,1,1,1,0},
  {1,1,1,1,1,1,1,1,1,1,1,1},
  {1,1,1,1,1,1,1,1,1,1,1,1},
  {0,1,1,1,1,1,1,1,1,1,1,0},
  {0,0,1,1,1,1,1,1,1,1,0,0},
  {0,0,0,1,1,1,1,1,1,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
};

// TIER 1 — small diamond (watch)
uint8_t FRAME_TIER1[8][12] = {
  {0,0,0,0,0,0,0,0,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,1,1,1,1,0,0,0,0},
  {0,0,0,1,1,1,1,1,1,0,0,0},
  {0,0,0,1,1,1,1,1,1,0,0,0},
  {0,0,0,0,1,1,1,1,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,0,0,0,0,0,0,0,0},
};

// TIER 2 — warning triangle with "!"
uint8_t FRAME_TIER2[8][12] = {
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,1,1,1,1,0,0,0,0},
  {0,0,0,1,1,0,0,1,1,0,0,0},
  {0,0,1,1,0,1,1,0,1,1,0,0},
  {0,1,1,0,0,1,1,0,0,1,1,0},
  {0,1,1,1,1,1,1,1,1,1,1,0},
  {1,1,1,1,1,0,0,1,1,1,1,1},
  {0,0,0,0,0,0,0,0,0,0,0,0},
};

// TIER 3 — big X (SOS / critical)
uint8_t FRAME_TIER3[8][12] = {
  {1,1,0,0,0,0,0,0,0,0,1,1},
  {1,1,1,0,0,0,0,0,0,1,1,1},
  {0,1,1,1,0,0,0,0,1,1,1,0},
  {0,0,1,1,1,0,0,1,1,1,0,0},
  {0,0,0,1,1,1,1,1,1,0,0,0},
  {0,0,1,1,1,0,0,1,1,1,0,0},
  {0,1,1,1,0,0,0,0,1,1,1,0},
  {1,1,1,0,0,0,0,0,0,1,1,1},
};

void show_frame(int state) {
  switch (state) {
    case 0: matrix.renderBitmap(FRAME_IDLE,    8, 12); break;
    case 1: matrix.renderBitmap(FRAME_TIER1,   8, 12); break;
    case 2: matrix.renderBitmap(FRAME_TIER2,   8, 12); break;
    case 3: matrix.renderBitmap(FRAME_TIER3,   8, 12); break;
    case 4: matrix.renderBitmap(FRAME_SWALLOW, 8, 12); break;
    default: matrix.renderBitmap(FRAME_IDLE,   8, 12); break;
  }
}

// ---------------------------------------------------------------------------
// MPU helpers
// ---------------------------------------------------------------------------
bool mpu_present(uint8_t addr) {
  Wire.beginTransmission(addr);
  return (Wire.endTransmission() == 0);
}

void mpu_write(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg); Wire.write(val);
  Wire.endTransmission();
}

void mpu_wake(uint8_t addr) {
  mpu_write(addr, 0x6B, 0x00);   // wake from sleep
  mpu_write(addr, 0x1C, 0x00);   // ±2g range
}

bool mpu_read_accel(uint8_t addr, float *ax, float *ay, float *az) {
  Wire.beginTransmission(addr);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  Wire.requestFrom(addr, (uint8_t)6);
  if (Wire.available() < 6) return false;
  int16_t rx = (Wire.read() << 8) | Wire.read();
  int16_t ry = (Wire.read() << 8) | Wire.read();
  int16_t rz = (Wire.read() << 8) | Wire.read();
  *ax = rx / 16384.0f;
  *ay = ry / 16384.0f;
  *az = rz / 16384.0f;
  return true;
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------
int rpc_mpu_init() {
  Wire.begin();
  Wire.setClock(400000);
  throat_ok  = mpu_present(THROAT_ADDR);
  sternum_ok = mpu_present(STERNUM_ADDR);
  if (throat_ok)  mpu_wake(THROAT_ADDR);
  if (sternum_ok) mpu_wake(STERNUM_ADDR);
  Serial.print("rpc_mpu_init: throat="); Serial.print(throat_ok);
  Serial.print(" sternum="); Serial.println(sternum_ok);
  return (throat_ok ? 1 : 0) | (sternum_ok ? 2 : 0);
}

String rpc_mpu_read() {
  float t_ax=0,t_ay=0,t_az=0, s_ax=0,s_ay=0,s_az=0;
  if (throat_ok)  mpu_read_accel(THROAT_ADDR,  &t_ax,&t_ay,&t_az);
  if (sternum_ok) mpu_read_accel(STERNUM_ADDR, &s_ax,&s_ay,&s_az);
  float t_mag = sqrt(t_ax*t_ax + t_ay*t_ay + t_az*t_az);
  float s_mag = sqrt(s_ax*s_ax + s_ay*s_ay + s_az*s_az);
  float ratio = (s_mag > 0.01f) ? (t_mag / s_mag) : 0.0f;

  char buf[160];
  snprintf(buf, sizeof(buf),
           "%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.2f",
           t_ax,t_ay,t_az,t_mag,
           s_ax,s_ay,s_az,s_mag,
           ratio);
  return String(buf);
}

bool rpc_buzz(int count) {
  if (!vibro_ok) return false;
  if (count < 1) count = 1;
  if (count > 5) count = 5;

  // Tier 3+: sustained SOS pattern, two 1.5s pulses with 300ms gap
  if (count >= 3) {
    vibro.on(1500, true);
    delay(300);
    vibro.on(1500, true);
    return true;
  }
  // Tier 1/2: short sharp pulses
  for (int i = 0; i < count; i++) {
    vibro.on(500, true);
    if (i < count - 1) delay(250);
  }
  return true;
}

bool rpc_matrix_show(int state) {
  show_frame(state);
  return true;
}

// ---------------------------------------------------------------------------
// Setup / loop
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);

  // LED matrix splash: scroll "ChYme"
  matrix.begin();
  matrix.beginDraw();
  matrix.stroke(0xFFFFFFFF);
  matrix.textScrollSpeed(70);
  matrix.textFont(Font_5x7);
  matrix.beginText(0, 1, 0xFFFFFF);
  matrix.println("  ChYme  ");
  matrix.endText(SCROLL_LEFT);
  matrix.endDraw();

  // After splash, show idle icon
  show_frame(0);

  // Modulino on Wire1 (Qwiic)
  Modulino.begin();
  vibro_ok = vibro.begin();

  // Bridge RPCs
  Bridge.begin();
  Bridge.provide("mpu_init",    rpc_mpu_init);
  Bridge.provide("mpu_read",    rpc_mpu_read);
  Bridge.provide("buzz",        rpc_buzz);
  Bridge.provide("matrix_show", rpc_matrix_show);

  Serial.print("SwallowSense MCU ready. Vibro=");
  Serial.println(vibro_ok ? "OK" : "NOT FOUND");
}

void loop() {
  // Bridge services RPC calls automatically
}
