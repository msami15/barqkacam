/**
 * CameraConnection.ts
 *
 * Manages the control-channel TCP socket (port 8081) to the camera:
 *  - Opens the connection and performs the session handshake the official
 *    app performs before requesting video (confirmed necessary — the
 *    camera silently refuses the MJPEG stream on port 8080 without it).
 *  - Sends a heartbeat every 500ms to keep the session alive, matching the
 *    cadence observed in the capture.
 *  - Exposes capturePhoto() and toggleRecord(), which write straight to the
 *    SD card in the camera (not the phone).
 *
 * Timing note: in the captured session, the official app waited roughly
 * 1 second after opening this socket before it ever requested video on
 * port 8080. We replicate that delay before resolving connect() so the
 * camera has time to fully process the handshake first.
 */

import {Buffer} from 'buffer';
import TcpSocket from 'react-native-tcp-socket';
import {
  buildHeartbeat,
  buildCapturePhoto,
  buildToggleRecord,
  buildFrame,
  Context,
  GPSocketFrame,
  GPSocketFrameParser,
  isSuccessResponse,
} from './GPSocketProtocol';

export const CAMERA_HOST = '192.168.25.1';
export const CONTROL_PORT = 8081;
export const STREAM_PORT = 8080;
export const STREAM_PATH = '/?action=stream';

// Delay between finishing the handshake write and resolving connect(),
// matching the ~1s gap observed in the real capture before video was ever
// requested. Configurable so the Diagnostics screen can try other values.
export const POST_HANDSHAKE_DELAY_MS = 1000;

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

interface CameraConnectionEvents {
  onStatusChange?: (status: ConnectionStatus) => void;
  onRecordingChange?: (recording: boolean) => void;
  onPhotoCaptured?: () => void;
  onError?: (message: string) => void;
  /** Every parsed GPSOCKET frame, success or not — for the Diagnostics screen. */
  onFrame?: (frame: GPSocketFrame) => void;
  /** Every raw chunk received on the control socket, pre-parsing. */
  onRawData?: (chunk: Buffer) => void;
}

// Handshake sequence observed from the official app immediately after
// opening the socket, before the first heartbeat. cmdId 0x05 carries a
// 4-byte value that looks device/session specific in the capture; we send
// zeros, which the camera has accepted in testing. cmdIds 0x02, 0x08 and
// 0x04 (context SYSTEM) round out the session-open sequence.
//
// NOTE: unlike Snapshot/Record, this sequence was reconstructed from
// strings/heuristics rather than an isolated capture of the handshake
// alone — if video still won't start, this is the most likely place to
// experiment. Use the Diagnostics screen to try variations live.
export function buildHandshakeFrames(): Buffer[] {
  return [
    buildFrame(Context.SYSTEM, 0x05, Buffer.from([0x00, 0x00, 0x00, 0x00])),
    buildFrame(Context.SYSTEM, 0x02),
    buildFrame(Context.SYSTEM, 0x08, Buffer.from([0x00])),
    buildFrame(Context.SYSTEM, 0x04),
  ];
}

export class CameraConnection {
  private socket: any = null;
  private parser = new GPSocketFrameParser();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private events: CameraConnectionEvents;
  private status: ConnectionStatus = 'disconnected';
  private _isRecording = false;

  constructor(events: CameraConnectionEvents = {}) {
    this.events = events;
  }

  get isRecording() {
    return this._isRecording;
  }

  get currentStatus() {
    return this.status;
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.events.onStatusChange?.(status);
  }

  connect(
    host: string = CAMERA_HOST,
    port: number = CONTROL_PORT,
    postHandshakeDelayMs: number = POST_HANDSHAKE_DELAY_MS,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');
      this.parser.reset();

      const socket = TcpSocket.createConnection(
        {host, port, tls: false},
        () => {
          // Handshake first, THEN wait before declaring "connected" — the
          // video socket is opened by the caller immediately on resolve, and
          // the camera needs a moment to process the handshake first.
          const frames = buildHandshakeFrames();
          frames.forEach(frame => socket.write(frame));

          this.startHeartbeat();

          setTimeout(() => {
            this.setStatus('connected');
            resolve();
          }, postHandshakeDelayMs);
        },
      );

      socket.on('data', (data: string | Buffer) => {
        const buf =
          typeof data === 'string' ? Buffer.from(data, 'base64') : data;
        this.events.onRawData?.(buf);
        const frames = this.parser.push(buf);
        for (const frame of frames) {
          this.events.onFrame?.(frame);
          this.handleFrame(frame);
        }
      });

      socket.on('error', (err: Error) => {
        this.setStatus('error');
        this.events.onError?.(err.message ?? 'Unknown socket error');
        reject(err);
      });

      socket.on('close', () => {
        this.stopHeartbeat();
        this.setStatus('disconnected');
      });

      this.socket = socket;
    });
  }

  private handleFrame(frame: GPSocketFrame) {
    if (!isSuccessResponse(frame)) {
      return;
    }
    if (frame.context === Context.CAPTURE && frame.cmdId === 0x01) {
      this.events.onPhotoCaptured?.();
    }
    if (frame.context === Context.CAPTURE && frame.cmdId === 0x06) {
      this._isRecording = !this._isRecording;
      this.events.onRecordingChange?.(this._isRecording);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.socket?.write(buildHeartbeat());
    }, 500);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Tells the camera to save a photo to its own SD card. */
  capturePhoto() {
    if (this.status !== 'connected') {
      return;
    }
    this.socket?.write(buildCapturePhoto());
  }

  /** Toggles SD-card video recording on the camera. */
  toggleRecord() {
    if (this.status !== 'connected') {
      return;
    }
    this.socket?.write(buildToggleRecord());
  }

  /** Writes arbitrary bytes to the control socket — used by Diagnostics. */
  sendRaw(buf: Buffer) {
    this.socket?.write(buf);
  }

  disconnect() {
    this.stopHeartbeat();
    this.socket?.destroy();
    this.socket = null;
    this.setStatus('disconnected');
  }
}
