'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { parseCorreosCode, type CorreosCode } from '@/lib/scan/codes';

/**
 * The camera, the decode loop and the torch.
 *
 * THE SETTINGS HERE ARE THE OPERATOR'S, NOT MINE. They come from the scanner
 * component they wrote and checked against 61 real labels from Amazon, Shopify
 * and TikTok Shop: the back camera at 1920×1080, a long horizontal strip of the
 * frame rather than the whole thing, a decode every 120 ms, Code128 with
 * `tryHarder`, continuous focus, and the torch where the phone has one. None of
 * it is guesswork and none of it has been "improved".
 *
 * THREE THINGS ARE DIFFERENT, all from the design:
 *
 * 1. IT DOES NOT STOP. The original waits for "Scan next parcel" after each
 *    read. A warehouse works through a pile of three hundred with one hand, so
 *    the loop keeps running and the next read happens by itself.
 *
 * 2. THE SAME CODE WITHIN TWO SECONDS IS ONE PARCEL, not two reads. A label
 *    held still decodes eight times a second; without this, standing still
 *    would turn one parcel into sixteen "scanned twice" marks.
 *
 * 3. THE DECODER IS OURS. `zxing_reader.wasm` is about 950 KB and the package
 *    fetches it from jsDelivr by default — a third-party CDN in the request
 *    path of the one thing the warehouse needs to work. `prebuild` copies it
 *    into public/ and this points at it; see scripts/copy-zxing-wasm.mjs.
 */

/** Where `prebuild` puts the decoder. Served immutable; see next.config.mjs. */
const WASM_URL = '/zxing_reader.wasm';

/** The scan box, as a fraction of the camera frame. Long, for a 23-char code. */
export const SCAN_BOX = { x: 0.04, y: 0.36, w: 0.92, h: 0.28 } as const;

/** Time between decode attempts. */
const SCAN_INTERVAL_MS = 120;

/** The same code again inside this is one parcel held still. */
export const SAME_CODE_MS = 2_000;

export type ScannerStatus = 'starting' | 'scanning' | 'camera-error';

/** Browsers support these; TypeScript's DOM types do not list them yet. */
type ExtraCapabilities = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };

let decoderPrepared = false;

function prepareDecoder(): void {
  if (decoderPrepared) return;
  decoderPrepared = true;
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? WASM_URL : prefix + path),
    },
    // Start the download now, so the first parcel of the morning is not the
    // slow one.
    fireImmediately: true,
  }).catch(() => {
    decoderPrepared = false; // let the next mount try again
  });
}

export interface ScannerHandle {
  videoRef: React.RefObject<HTMLVideoElement>;
  status: ScannerStatus;
  cameraError: string;
  torchAvailable: boolean;
  torchOn: boolean;
  toggleTorch: () => void;
}

/**
 * `onCode` is called for every parcel read, at most once per two seconds per
 * code. It must not throw: a decode loop that dies takes the camera with it.
 */
export function useScanner(onCode: (code: CorreosCode) => void): ScannerHandle {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);
  const lastRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  // A ref, so a new `onCode` on every render does not restart the camera.
  const onCodeRef = useRef(onCode);
  useEffect(() => { onCodeRef.current = onCode; }, [onCode]);

  const [status, setStatus] = useState<ScannerStatus>('starting');
  const [cameraError, setCameraError] = useState('');
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const scanLoop = useCallback(async () => {
    if (!runningRef.current) return;
    const video = videoRef.current;

    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      const sx = Math.round(video.videoWidth * SCAN_BOX.x);
      const sy = Math.round(video.videoHeight * SCAN_BOX.y);
      const sw = Math.round(video.videoWidth * SCAN_BOX.w);
      const sh = Math.round(video.videoHeight * SCAN_BOX.h);

      const canvas = (canvasRef.current ??= document.createElement('canvas'));
      if (canvas.width !== sw) canvas.width = sw;
      if (canvas.height !== sh) canvas.height = sh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      if (ctx) {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
        try {
          const results = await readBarcodes(ctx.getImageData(0, 0, sw, sh), {
            formats: ['Code128'],
            tryHarder: true,
            maxNumberOfSymbols: 1,
          });

          for (const r of results) {
            const parsed = r.isValid ? parseCorreosCode(r.text) : null;
            if (!parsed) continue;

            const at = Date.now();
            // One parcel held still, not a second read.
            if (parsed.raw === lastRef.current.code && at - lastRef.current.at < SAME_CODE_MS) break;
            lastRef.current = { code: parsed.raw, at };
            onCodeRef.current(parsed);
            break;
          }
        } catch {
          /* the decoder is still loading, or that was a bad frame. Next one. */
        }
      }
    }

    // It keeps going, whatever it just read. That is the change the design asks
    // for: the warehouse never taps "scan next".
    if (runningRef.current) timerRef.current = setTimeout(scanLoop, SCAN_INTERVAL_MS);
  }, []);

  useEffect(() => {
    let cancelled = false;
    prepareDecoder();

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('This browser cannot open the camera. Use Chrome or Safari over HTTPS.');
        setStatus('camera-error');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];
        const caps = (track.getCapabilities?.() ?? {}) as ExtraCapabilities;
        if (caps.focusMode?.includes('continuous')) {
          await track
            .applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
            .catch(() => {});
        }
        setTorchAvailable(Boolean(caps.torch));

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }

        setStatus('scanning');
        runningRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(scanLoop, SCAN_INTERVAL_MS);
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        setCameraError(
          name === 'NotAllowedError'
            ? 'Camera permission was blocked. Allow camera access in the browser settings and reload.'
            : name === 'NotFoundError'
              ? 'No camera found on this device.'
              : 'Could not open the camera.',
        );
        setStatus('camera-error');
      }
    })();

    return () => {
      cancelled = true;
      runningRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [scanLoop]);

  const toggleTorch = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    track
      .applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      .then(() => setTorchOn(next))
      // iPhone Safari has no torch at all, and some Android cameras refuse it
      // once the stream is live. Hide the button rather than leave one that
      // does nothing.
      .catch(() => setTorchAvailable(false));
  }, [torchOn]);

  return { videoRef, status, cameraError, torchAvailable, torchOn, toggleTorch };
}
