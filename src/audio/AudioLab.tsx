import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import * as Moq from "@kixelated/moq";

import "./AudioLab.css";
import { ensureConnection, AUDIO_TRACK } from "../multiplayer/moqConnection";
import { AudioCapture } from "../multiplayer/audio/capture";
import { AudioPlayback, type PlaybackStats } from "../multiplayer/audio/playback";
import { decodePacket, encodePacket } from "../multiplayer/audio/packets";

type CaptureMode = "none" | "mic" | "tone";

type RemoteStats = {
  path: string;
  status: "active" | "retry" | "closed";
  bufferedAhead: number;
  framesDecoded: number;
  underruns: number;
  lastPacketAt: number;
  resets: number;
};

type LogEntry = {
  level: "info" | "warn" | "error";
  message: string;
  at: number;
};

type CaptureDebug = {
  framesSent: number;
  lastSampleRate: number;
  lastLevel: number;
  subscribers: number;
  lastFrameAt: number;
  lastFrameCount: number;
  lastFrameDurationMs: number;
};

const AUDIO_PREFIX = Moq.Path.from("innpub", "audio-lab");
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5000;
const RETRY_JITTER = 0.4;
const MAX_RETRIES = 10;

export function AudioLab() {
  const [status, setStatus] = useState("Connecting to relay…");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("none");
  const [toneFrequency, setToneFrequency] = useState(440);
  const [toneAmplitude, setToneAmplitude] = useState(0.05);
  const [uiTick, setUiTick] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [playbackEnabled, setPlaybackEnabled] = useState(false);

  const playbackRef = useRef(new AudioPlayback());
  const captureRef = useRef<AudioCapture | null>(null);
  const broadcastRef = useRef<Moq.Broadcast | null>(null);
  const connectionRef = useRef<Moq.Connection.Established | null>(null);
  const localPathRef = useRef<Moq.Path.Valid | null>(null);
  const announcementAbortRef = useRef<() => void>(() => {});
  const audioSubscribersRef = useRef(new Set<Moq.Track>());
  const remoteStatsRef = useRef(new Map<string, RemoteStats>());
  const retryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const retryAttemptsRef = useRef(new Map<string, number>());
  const resetCountersRef = useRef(new Map<string, number>());
  const captureStatsRef = useRef<CaptureDebug>({
    framesSent: 0,
    lastSampleRate: 0,
    lastLevel: 0,
    subscribers: 0,
    lastFrameAt: 0,
    lastFrameCount: 0,
    lastFrameDurationMs: 0,
  });

  const resumePlayback = async () => {
    await playbackRef.current.resume();
  };

  const writeLog = (level: LogEntry["level"], message: string) => {
    setLogs(prev => [...prev.slice(-100), { level, message, at: Date.now() }]);
  };

  const forceUiTick = () => setUiTick(Date.now());

  useEffect(() => {
    const id = setInterval(forceUiTick, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (typeof SharedArrayBuffer === "undefined") {
      writeLog(
        "error",
        "SharedArrayBuffer is not available. Ensure the server sends COOP/COEP headers so the audio pipeline can initialize.",
      );
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    playbackRef.current.setEnabled(false);
    setPlaybackEnabled(false);

    (async () => {
      try {
        const connection = await ensureConnection();
        if (disposed) {
          return;
        }
        connectionRef.current = connection;
        setStatus(`Connected to ${connection.url.href ?? connection.url}`);
        writeLog("info", "Connected to relay");

        const suffix = Moq.Path.from(`${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}#${Math.random().toString(36).slice(2, 8)}`);
        const publishPath = Moq.Path.join(AUDIO_PREFIX, suffix);
        localPathRef.current = publishPath;

        const broadcast = new Moq.Broadcast();
        broadcastRef.current = broadcast;
        connection.publish(publishPath, broadcast);
        writeLog("info", `Publishing audio at ${publishPath}`);

        handleBroadcastRequests(broadcast);
        startAnnouncementLoop(connection, publishPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Failed to connect: ${message}`);
        writeLog("error", `Failed to connect: ${message}`);
      }
    })();

    return () => {
      disposed = true;
      announcementAbortRef.current();
      void stopCaptureInternal();
      playbackRef.current.shutdown();
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
      broadcastRef.current?.close();
      audioSubscribersRef.current.clear();
      remoteStatsRef.current.clear();
      connectionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (captureMode === "none") {
      void stopCaptureInternal();
      return;
    }
    startCaptureInternal(captureMode).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      writeLog("error", `Capture failed: ${message}`);
      setCaptureMode("none");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureMode]);

  useEffect(() => {
    void captureRef.current?.setSyntheticTone({
      enabled: captureMode === "tone",
      frequency: toneFrequency,
      amplitude: toneAmplitude,
    });
  }, [captureMode, toneFrequency, toneAmplitude]);

  const remoteList = useMemo(() => {
    return Array.from(remoteStatsRef.current.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [uiTick]);

  const resetList = useMemo(() => Array.from(resetCountersRef.current.entries()).sort(), [uiTick]);

  const captureStats = captureStatsRef.current;

  const handleBroadcastRequests = (broadcast: Moq.Broadcast) => {
    (async () => {
      for (;;) {
        const request = await broadcast.requested();
        if (!request) break;
        if (request.track.name === AUDIO_TRACK) {
          const track = request.track;
          audioSubscribersRef.current.add(track);
          writeLog("info", "Remote subscribed to local audio");
          track.closed
            .catch(() => undefined)
            .finally(() => {
              audioSubscribersRef.current.delete(track);
              writeLog("info", "Remote unsubscribed from local audio");
              forceUiTick();
            });
        } else {
          request.track.close(new Error(`Unsupported track ${request.track.name}`));
        }
      }
    })().catch(error => {
      writeLog("warn", `Publish loop ended: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const startAnnouncementLoop = (connection: Moq.Connection.Established, localPath: Moq.Path.Valid) => {
    let aborted = false;
    const iterator = connection.announced(AUDIO_PREFIX);

    const run = async () => {
      try {
        for (;;) {
          if (aborted) break;
          const entry = await iterator.next();
          if (!entry) break;
          if (aborted) break;
          if (entry.path === localPath) continue;
          if (entry.active) {
            subscribeToRemote(entry.path, 0);
          } else {
            unsubscribeRemote(entry.path, "inactive");
          }
        }
      } catch (error) {
        writeLog("warn", `Announcement loop failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!aborted) {
          setTimeout(run, 1000);
        }
      }
    };

    run();
    announcementAbortRef.current = () => {
      aborted = true;
    };
  };

  const subscribeToRemote = (path: Moq.Path.Valid, attempt: number) => {
    if (attempt >= MAX_RETRIES) {
      writeLog("warn", `Giving up on ${path} after ${attempt} attempts`);
      retryAttemptsRef.current.delete(path);
      retryTimersRef.current.delete(path);
      remoteStatsRef.current.set(path, {
        path,
        status: "closed",
        bufferedAhead: 0,
        framesDecoded: 0,
        underruns: 0,
        lastPacketAt: 0,
        resets: aggregateResets(path),
      });
      forceUiTick();
      return;
    }

    const connection = connectionRef.current;
    if (!connection) {
      return;
    }

    retryAttemptsRef.current.set(path, attempt);

    try {
      const broadcast = connection.consume(path);
      const track = broadcast.subscribe(AUDIO_TRACK, -1);
      clearResetCounters(path, AUDIO_TRACK);
      updateRemoteStatus(path, "active");

      track.closed
        .catch(() => undefined)
        .finally(() => {
          audioPlaybackClose(path);
          retryTimersRef.current.delete(path);
          retryAttemptsRef.current.delete(path);
          updateRemoteStatus(path, "closed");
          forceUiTick();
        });

      (async () => {
        if (playbackEnabled) {
          try {
            await resumePlayback();
          } catch (error) {
            writeLog("warn", `Playback unlock failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        for (;;) {
          const frame = await track.readFrame();
          if (!frame) break;
          const packet = decodePacket(frame);
          if (!packet) {
            incrementResetCounter(path, `${AUDIO_TRACK}:decode`);
            continue;
          }
          await playbackRef.current.enqueue(path, packet);
          const stats = playbackRef.current.getStats(path);
          if (stats) {
            remoteStatsRef.current.set(path, mapPlaybackStats(path, stats));
            forceUiTick();
          }
        }
      })().catch(error => {
        handleSubscribeError(path, attempt, error, () => subscribeToRemote(path, attempt + 1));
      });
    } catch (error) {
      handleSubscribeError(path, attempt, error, () => subscribeToRemote(path, attempt + 1));
    }
  };

  const handleSubscribeError = (
    path: Moq.Path.Valid,
    attempt: number,
    error: unknown,
    retryFn: () => void,
  ) => {
    if (isResetStreamError(error)) {
      incrementResetCounter(path, AUDIO_TRACK);
    } else {
      writeLog("warn", `Subscribe error for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    audioPlaybackClose(path);
    scheduleRetry(path, attempt, retryFn);
  };

  const scheduleRetry = (path: Moq.Path.Valid, attempt: number, retryFn: () => void) => {
    const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
    const jitter = base * RETRY_JITTER * (Math.random() * 2 - 1);
    const delay = Math.max(RETRY_BASE_MS, Math.min(RETRY_MAX_MS, base + jitter));
    const timer = setTimeout(() => {
      retryTimersRef.current.delete(path);
      retryFn();
    }, delay);
    retryTimersRef.current.set(path, timer);
    updateRemoteStatus(path, "retry");
    forceUiTick();
  };

  const unsubscribeRemote = (path: Moq.Path.Valid, reason: string) => {
    const timer = retryTimersRef.current.get(path);
    if (timer) {
      clearTimeout(timer);
      retryTimersRef.current.delete(path);
    }
    retryAttemptsRef.current.delete(path);
    audioPlaybackClose(path);
    remoteStatsRef.current.delete(path);
    writeLog("info", `Remote ${path} left (${reason})`);
    forceUiTick();
  };

  const audioPlaybackClose = (path: string) => {
    playbackRef.current.close(path);
  };

  const startCaptureInternal = async (mode: CaptureMode) => {
    await stopCaptureInternal();
    const capture = new AudioCapture({
      onSamples: handleCapturedSamples,
      onLevel: level => {
        captureStatsRef.current.lastLevel = level;
      },
    });
    captureRef.current = capture;
    await capture.setSyntheticTone({
      enabled: mode === "tone",
      frequency: toneFrequency,
      amplitude: toneAmplitude,
    });
    await capture.start();
    writeLog("info", `Capture started (${mode})`);
  };

  const stopCaptureInternal = async () => {
    const capture = captureRef.current;
    captureRef.current = null;
    if (capture) {
      await capture.stop();
    }
  };

  const handleCapturedSamples = (channels: Float32Array[], sampleRate: number) => {
    const frameCount = channels.length > 0 ? channels[0]?.length ?? 0 : 0;
    const stats = captureStatsRef.current;
    if (frameCount > 0) {
      stats.framesSent += frameCount;
    }
    stats.lastSampleRate = sampleRate;
    stats.subscribers = audioSubscribersRef.current.size;
    stats.lastFrameAt = Date.now();
    stats.lastFrameCount = frameCount;
    stats.lastFrameDurationMs = sampleRate > 0 ? (frameCount / sampleRate) * 1000 : 0;

    const packet = encodePacket(channels, sampleRate);
    if (!packet) {
      return;
    }

    for (const track of [...audioSubscribersRef.current]) {
      try {
        track.writeFrame(packet.buffer);
      } catch (error) {
        audioSubscribersRef.current.delete(track);
        writeLog("warn", `Failed to write audio frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const incrementResetCounter = (path: string, track: string) => {
    const key = `${path}:${track}`;
    const count = (resetCountersRef.current.get(key) ?? 0) + 1;
    resetCountersRef.current.set(key, count);
    updateRemoteStatus(path, "retry");
  };

  const clearResetCounters = (path: string, track: string) => {
    const keys: string[] = [];
    resetCountersRef.current.forEach((_, key) => {
      if (key.startsWith(path) && key.includes(track)) {
        keys.push(key);
      }
    });
    keys.forEach(key => resetCountersRef.current.delete(key));
  };

  const aggregateResets = (path: string) => {
    let total = 0;
    resetCountersRef.current.forEach((value, key) => {
      if (key.startsWith(path)) {
        total += value;
      }
    });
    return total;
  };

  const updateRemoteStatus = (path: string, status: RemoteStats["status"]) => {
    const stats = remoteStatsRef.current.get(path);
    if (stats) {
      stats.status = status;
      stats.resets = aggregateResets(path);
      remoteStatsRef.current.set(path, stats);
    } else {
      remoteStatsRef.current.set(path, {
        path,
        status,
        bufferedAhead: 0,
        framesDecoded: 0,
        underruns: 0,
        lastPacketAt: 0,
        resets: aggregateResets(path),
      });
    }
    forceUiTick();
  };

  const mapPlaybackStats = (path: string, stats: PlaybackStats): RemoteStats => {
    return {
      path,
      status: "active",
      bufferedAhead: stats.bufferedAhead,
      framesDecoded: stats.framesDecoded,
      underruns: stats.underruns,
      lastPacketAt: Date.now(),
      resets: aggregateResets(path),
    };
  };

  const renderStatus = () => (
    <div className="status-line">
      {status}
      {!playbackEnabled ? " · Playback locked (click Enable Playback)" : null}
    </div>
  );

  const renderControls = () => (
    <div className="controls">
      <div className="control-card">
        <h2>Capture</h2>
        <div className="button-row">
          <button
            type="button"
            className={captureMode === "mic" ? "is-active" : ""}
            onClick={() => setCaptureMode(prev => (prev === "mic" ? "none" : "mic"))}
          >
            {captureMode === "mic" ? "Stop Mic" : "Use Mic"}
          </button>
          <button
            type="button"
            className={captureMode === "tone" ? "is-active" : ""}
            onClick={() => setCaptureMode(prev => (prev === "tone" ? "none" : "tone"))}
          >
            {captureMode === "tone" ? "Stop Tone" : "Tone"}
          </button>
        </div>
        <div className="field-grid">
          <label>
            <span>Frequency (Hz)</span>
            <input
              type="number"
              min={50}
              max={4000}
              value={toneFrequency}
              onChange={event => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) {
                  const clamped = Math.min(4000, Math.max(50, value));
                  setToneFrequency(clamped);
                }
              }}
            />
          </label>
          <label>
            <span>Amplitude</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={toneAmplitude}
              onChange={event => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) {
                  const clamped = Math.min(1, Math.max(0, value));
                  setToneAmplitude(clamped);
                }
              }}
            />
          </label>
        </div>
      </div>
      <div className="control-card">
        <h2>Playback</h2>
        <div className="button-row">
          <button
            type="button"
            className={playbackEnabled ? "is-active" : ""}
            onClick={() => {
              if (playbackEnabled) {
                playbackRef.current.setEnabled(false);
                setPlaybackEnabled(false);
              } else {
                resumePlayback()
                  .then(() => {
                    playbackRef.current.setEnabled(true);
                    setPlaybackEnabled(true);
                  })
                  .catch(error => {
                    writeLog("warn", `Playback unlock failed: ${error instanceof Error ? error.message : String(error)}`);
                  });
              }
              forceUiTick();
            }}
          >
            {playbackEnabled ? "Disable Playback" : "Enable Playback"}
          </button>
          <button
            type="button"
            onClick={() => {
              playbackRef.current.shutdown();
              playbackRef.current.setEnabled(false);
              setPlaybackEnabled(false);
              forceUiTick();
            }}
          >
            Reset Audio
          </button>
        </div>
      </div>
    </div>
  );

  const renderRemoteTable = () => (
    <table className="remote-table">
      <thead>
        <tr>
          <th>Remote Path</th>
          <th>Status</th>
          <th>Buffered (s)</th>
          <th>Frames</th>
          <th>Underruns</th>
          <th>Last Packet</th>
          <th>Resets</th>
        </tr>
      </thead>
      <tbody>
        {remoteList.length === 0 ? (
          <tr>
            <td colSpan={7}>No remote publishers.</td>
          </tr>
        ) : (
          remoteList.map(remote => (
            <tr key={remote.path}>
              <td>{remote.path}</td>
              <td>{remote.status}</td>
              <td>{remote.bufferedAhead.toFixed(3)}</td>
              <td>{remote.framesDecoded.toLocaleString()}</td>
              <td>{remote.underruns}</td>
              <td>{remote.lastPacketAt ? `${((Date.now() - remote.lastPacketAt) / 1000).toFixed(1)} s ago` : "–"}</td>
              <td>{remote.resets}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );

  const renderDebugPanel = () => (
    <div className="debug-panel">
      <div className="debug-grid">
        <div className="debug-item">
          <span>Subscribers</span>
          <span>{audioSubscribersRef.current.size}</span>
        </div>
        <div className="debug-item">
          <span>Capture Frame</span>
          <span>
            {captureStats.lastFrameCount} samples · {captureStats.lastFrameDurationMs.toFixed(2)} ms
          </span>
        </div>
        <div className="debug-item">
          <span>Capture Level</span>
          <span>{captureStats.lastLevel.toFixed(4)}</span>
        </div>
        <div className="debug-item">
          <span>Tone</span>
          <span>
            {captureMode === "tone" ? "On" : "Off"} · {toneFrequency} Hz · {toneAmplitude.toFixed(2)}
          </span>
        </div>
        <div className="debug-item">
          <span>Playback</span>
          <span>{playbackEnabled ? "Enabled" : "Disabled"}</span>
        </div>
      </div>
      {resetList.length > 0 ? (
        <div className="debug-item">
          <span>Resets</span>
          <span>{resetList.map(([key, value]) => `${key}(${value})`).join(", ")}</span>
        </div>
      ) : null}
      <div className="log-output">
        {logs.slice(-100).map((entry, index) => (
          <div
            key={`${entry.at}-${index}`}
            className={entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : undefined}
          >
            [{new Date(entry.at).toLocaleTimeString()}] {entry.message}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="audio-lab">
      <div className="nav-bar">
        <Link href="/">← Back to InnPub</Link>
        <span>Relay Audio Diagnostics</span>
      </div>
      <h1>Audio Lab</h1>
      {renderStatus()}
      {renderControls()}
      {renderRemoteTable()}
      {renderDebugPanel()}
    </div>
  );
}

function isResetStreamError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (typeof error === "string") {
    return error.includes("RESET_STREAM");
  }
  if (error instanceof Error) {
    return error.message.includes("RESET_STREAM");
  }
  return false;
}
