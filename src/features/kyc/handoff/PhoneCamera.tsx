'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import {
    ICE_SERVERS,
    iceGatheringComplete,
    putSdp,
    waitForSdp,
} from './signaling';

/**
 * The phone half. Opens the camera, answers the desktop's offer, streams.
 *
 * ── What this page deliberately is not ──────────────────────────────────────
 * It has no session, sets no cookie, reads no challenge and posts no image. It
 * cannot advance a sign-in, and nothing it does is trusted: it is a camera on
 * the end of a wire. Everything that judges a face or a document still happens
 * on the desktop, against the same backend, through the same checks.
 *
 * That is what lets the room carry no auth. Whoever holds the QR can offer a
 * camera to this step — and that camera's output then has to pass liveness and
 * match the enrolled face, exactly as the desktop's would.
 *
 * ── Camera only. No file picker. ────────────────────────────────────────────
 * `getUserMedia` and nothing else. An `<input type="file" capture>` looks like
 * the same thing and is not: on both iOS and Android it offers the photo
 * library beside the camera, which would let somebody submit a photograph of a
 * photograph. The whole point of capturing live is that they cannot.
 */
export function PhoneCamera({ room, facing }: { room: string; facing: 'user' | 'environment' }) {
    const [phase, setPhase] = useState<
        'starting' | 'waiting' | 'live' | 'ended' | 'failed'
    >('starting');
    const [error, setError] = useState<string | null>(null);
    /**
     * The check's current instruction, relayed from the computer.
     *
     * The user is looking at THIS screen — it is where the camera is — while
     * every "move closer" and "hold still" is rendered on the computer behind
     * them. Shown large and over the picture, because it is the only thing on
     * this screen they need to read.
     */
    const [hint, setHint] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const connect = useCallback(async () => {
        setPhase('starting');
        setError(null);

        const abort = new AbortController();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                // `ideal`, not `exact`: a tablet or a phone with an unusual
                // camera set should still work rather than throwing
                // OverconstrainedError and stranding the user here.
                video: {
                    facingMode: { ideal: facing },
                    width: { ideal: 1280 },
                    /**
                     * Shaped like the frame it will be shown in (350x400).
                     *
                     * ⚠️ This is what stops the desktop letterboxing or
                     * distorting the picture, and it has to be solved HERE. The
                     * frame keeps the video and the liveness oval in one box —
                     * the oval is drawn from the geometry the face-fit test uses
                     * — so the desktop cannot crop or scale one without breaking
                     * the other. Asking the phone for the right shape leaves it
                     * nothing to correct.
                     *
                     * Held portrait a phone delivers 9:16, far narrower than the
                     * frame, which is where the black bars came from.
                     *
                     * `ideal`: a camera that cannot produce this ratio still
                     * works, it just gives the nearest it has.
                     */
                    aspectRatio: { ideal: 350 / 400 },
                    frameRate: { ideal: 30, min: 15 },
                },
                audio: false,
            });

            streamRef.current = stream;
            if (videoRef.current) videoRef.current.srcObject = stream;

            const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            pcRef.current = pc;
            stream.getTracks().forEach((t) => pc.addTrack(t, stream));

            // The computer creates the channel, so this side receives it.
            pc.addEventListener('datachannel', (e) => {
                if (e.channel.label !== 'hints') return;
                e.channel.onmessage = (m) =>
                    setHint(typeof m.data === 'string' ? m.data : null);
            });

            setPhase('waiting');
            const offer = await waitForSdp(room, 'offer', abort.signal);

            await pc.setRemoteDescription({ type: 'offer', sdp: offer });
            await pc.setLocalDescription(await pc.createAnswer());
            await iceGatheringComplete(pc);
            await putSdp(room, 'answer', pc.localDescription?.sdp ?? '');

            pc.addEventListener('connectionstatechange', () => {
                if (pc.connectionState === 'connected') setPhase('live');

                // ⚠️ `closed` and `disconnected` matter as much as `failed`.
                //
                // The computer closes this peer connection whenever it gives up
                // on the check or starts a fresh hand-off — and a spent room
                // cannot be rescanned, so a NEW code is already on its screen.
                // Watching only `failed` left this phone saying "Connected"
                // beside a dead connection, which is the one thing it must
                // never do: the user stands there following instructions that
                // stopped arriving.
                if (
                    pc.connectionState === 'failed' ||
                    pc.connectionState === 'disconnected' ||
                    pc.connectionState === 'closed'
                ) {
                    setPhase('ended');
                }
            });
        } catch (err) {
            const name = (err as Error)?.name;
            console.error('[handoff/phone] failed:', err);
            setError(
                name === 'NotAllowedError'
                    ? 'Allow camera access to continue.'
                    : name === 'NotFoundError'
                      ? 'No camera found on this device.'
                      : ((err as Error)?.message ?? 'Could not start the camera.'),
            );
            setPhase('failed');
        }
    }, [room, facing]);

    useEffect(() => {
        void connect();
        return () => {
            pcRef.current?.close();
            streamRef.current?.getTracks().forEach((t) => t.stop());
        };
    }, [connect]);

    // Once live, the CHECK'S OWN guidance is the message — "move closer",
    // "hold still" — relayed from the computer over the data channel.
    //
    // It used to say "follow your computer", which was advice the user cannot
    // take: they are holding the phone up at their face, and the computer is
    // behind them. The instructions have to be here, because this is the screen
    // they are looking at. The fallback only shows in the gap before the first
    // hint arrives.
    const message =
        phase === 'starting'
            ? 'Starting the camera…'
            : phase === 'waiting'
              ? 'Connecting to your computer…'
              : phase === 'live'
                ? (hint ?? 'Connected — hold your phone at eye level.')
                : phase === 'ended'
                  ? 'This session has ended. Scan the new code on your computer.'
                  : (error ?? 'Something went wrong.');

    return (
        <main className="flex h-full flex-col items-center justify-center bg-black px-20">
            {/*
              The phone is a viewfinder, not a control surface. There is no
              capture button: the desktop decides when a frame is taken, because
              the desktop is what runs the check. A shutter here would imply the
              phone was deciding, and invite tapping it at the wrong moment.

              Mirrored for `user` only, matching every other selfie preview in
              this app — a back camera must never be mirrored, or text on a
              document reads backwards.
            */}
            <div className="relative">
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`h-400 w-350 rad-30 object-cover ${facing === 'user' ? '-scale-x-100' : ''}`}
                />

                {/* Over the picture, because it is what the user must read. */}
                {phase === 'live' && hint && (
                    <p
                        role="status"
                        className="fz-16 absolute inset-x-16 bottom-20 rad-12 bg-black/65 px-16 py-12 text-center leading-normal font-semibold text-white"
                    >
                        {hint}
                    </p>
                )}
            </div>

            <p className="fz-14 mt-24 max-w-360 text-center leading-normal font-medium text-white">
                {message}
            </p>

            {/*
              Only for a failure BEFORE the connection existed — a blocked
              camera, a room that never answered. Once a session has ended the
              room is spent and retrying it can only fail; the way forward is
              the new code the computer is already showing.
            */}
            {phase === 'failed' && (
                <button
                    type="button"
                    onClick={() => void connect()}
                    title="Try again"
                    aria-label="Try again"
                    className="mt-16 flex h-44 w-44 items-center justify-center rad-12 border border-white/40 text-white transition-colors hover:border-white"
                >
                    <Icon name="kyc/retry" size={20} mask />
                </button>
            )}
        </main>
    );
}
