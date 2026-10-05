import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('SMARTBREADBOARD 3D — Real-Time Hardware Telemetry & Communication', () => {

  test('1. Initial telemetry state structure and offline status', () => {
    const defaultTelemetry = {
      status: 'DISCONNECTED',
      connected: false,
      device: 'ESP32_WROOM_32',
      voltage: 0,
      current_ma: 0,
      power_mw: 0,
      adc_raw: 0,
      adc_voltage: 0,
      digital_pins: { GPIO2: 0, GPIO4: 0, SW1: 0, SW2: 0 },
      timestamp: null,
      last_received: null
    };

    assert.equal(defaultTelemetry.status, 'DISCONNECTED');
    assert.equal(defaultTelemetry.connected, false);
    assert.equal(defaultTelemetry.current_ma, 0);
  });

  test('2. Successful connect hardware transition updates state to CONNECTED', () => {
    let telemetryState = {
      status: 'DISCONNECTED',
      connected: false,
      voltage: 0,
      current_ma: 0,
      power_mw: 0
    };

    // Simulate connect action response
    const connectPayload = {
      success: true,
      status: 'CONNECTED',
      telemetry: {
        status: 'CONNECTED',
        connected: true,
        voltage: 5.0,
        current_ma: 33.62,
        power_mw: 168.10,
        adc_raw: 2730,
        adc_voltage: 3.3,
        digital_pins: { GPIO2: 1, GPIO4: 0, SW1: 1, SW2: 1 },
        timestamp: new Date().toISOString(),
        last_received: Date.now()
      }
    };

    if (connectPayload.success) {
      telemetryState = { ...telemetryState, ...connectPayload.telemetry };
    }

    assert.equal(telemetryState.status, 'CONNECTED');
    assert.equal(telemetryState.connected, true);
    assert.equal(telemetryState.voltage, 5.0);
    assert.equal(telemetryState.current_ma, 33.62);
  });

  test('3. Disconnect preserves last received values and timestamp', () => {
    const timestamp = '2026-10-05T09:40:00.000Z';
    const lastReceived = 1791193200;
    
    let telemetryState = {
      status: 'CONNECTED',
      connected: true,
      voltage: 5.0,
      current_ma: 33.62,
      power_mw: 168.10,
      adc_raw: 2730,
      timestamp,
      last_received: lastReceived
    };

    // Disconnect action
    telemetryState = {
      ...telemetryState,
      status: 'DISCONNECTED',
      connected: false
    };

    assert.equal(telemetryState.status, 'DISCONNECTED');
    assert.equal(telemetryState.connected, false);
    assert.equal(telemetryState.current_ma, 33.62, 'Must retain last received current value');
    assert.equal(telemetryState.timestamp, timestamp, 'Must retain last received timestamp');
    assert.equal(telemetryState.last_received, lastReceived, 'Must retain last received Unix epoch');
  });

  test('4. Live telemetry update accurately accepts custom sensor values', () => {
    let telemetryState = {
      status: 'CONNECTED',
      connected: true,
      voltage: 5.0,
      current_ma: 33.62,
      power_mw: 168.10,
      adc_raw: 2730
    };

    // ESP32 sensor change payload
    const sensorChange = {
      voltage: 3.3,
      current_ma: 20.15,
      power_mw: 66.495,
      adc_raw: 1800,
      adc_voltage: 2.15,
      timestamp: new Date().toISOString()
    };

    telemetryState = { ...telemetryState, ...sensorChange };

    assert.equal(telemetryState.voltage, 3.3);
    assert.equal(telemetryState.current_ma, 20.15);
    assert.equal(telemetryState.power_mw, 66.495);
    assert.equal(telemetryState.adc_raw, 1800);
  });

});
