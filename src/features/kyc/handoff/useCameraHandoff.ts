'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ICE_SERVERS,
    iceGatheringComplete,
    newRoomId,
    putSdp,
    waitForSdp,
} from './signaling';
import { installCameraShim, uninstallCameraShim } from './cameraShim';

/**
 * The desktop half of the camera hand-off.
 *
 * Builds one WebRTC offer, publishes the URL a phone should open, waits for the
 * answer, and — once video arrives — installs the shim so every existing camera
 * screen picks it up untouched.
 *
 * ── One room per step, and why ──────────────────────────────────────────────
 * Each call to `start()` mints a fresh room id and a fresh RTCPeerConnection,
 * so face verification, ID front and ID back each get their own QR. That is not
 * bookkeeping: the room is write-once per role and self-destructs when the
 * answer is read, so a room CANNOT be reused for a second step even if we
 * wanted it to. It also means a QR photographed off the screen is spent the
 * moment its step completes.
 *
 * The camera the phone should open differs per step too, which is the other
 * reason the URL is rebuilt each time — a selfie wants the front camera and a
 * document wants the back one.
 */

export type HandoffFacing = 'user' | 'environment';

export type HandoffPhase =
    | 'idle'
    /** Building the offer and gathering ICE. Brief, but not instant. */
    | 'preparing'
    /** QR is on screen; nobody has scanned it yet. */
    | 'waiting'
    /** Answer received, media negotiating. */
    | 'connecting'
    /** Video is flowing and the shim is installed. */
    | 'live'
    | 'failed';

export function useCameraHandoff() {
    const [phase, setPhase] = useState<HandoffPhase>('idle');
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const pcRef = useRef<RTCPeerConnection | null>(null);
    /**
     * Carries AWS's guidance to the phone — "move closer", "hold still".
     *
     * ⚠️ Not a nicety. During the check the user is looking at their PHONE,
     * because that is where the camera is. Every instruction the check gives is
     * rendered on the computer, behind them. Without this they are told to move
     * closer by a screen they cannot see, and the check fails for reasons they
     * were never shown.
     *
     * Created on the OFFERER before `createOffer()`, which is what puts the
     * data channel's m-line in the SDP. Added afterwards it would need a second
     * negotiation, and the whole point of this signaling design is that there
     * is exactly one exchange.
     */
    const hintsRef = useRef<RTCDataChannel | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    /** Tear down everything, and always put the camera stack back. */
    const stop = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;

        hintsRef.current?.close();
        hintsRef.current = null;

        pcRef.current?.close();
        pcRef.current = null;

        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        // Unconditional: leaving the shim installed after a hand-off ends would
        // point every later camera request at a dead stream, and the screens
        // would show a frozen frame rather than an error anybody could act on.
        uninstallCameraShim();

        setPhase('idle');
        setUrl(null);
        setError(null);
    }, []);

    // Covers the case no explicit teardown can: the component unmounting mid
    // hand-off, which is what a navigation between steps does.
    useEffect(() => stop, [stop]);

    const start = useCallback(
        async (facing: HandoffFacing) => {
            stop();

            setPhase('preparing');
            setError(null);

            const room = newRoomId();
            const abort = new AbortController();
            abortRef.current = abort;

            try {
                const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
                pcRef.current = pc;

                // recvonly: this side never sends. The desktop has no camera —
                // that is the entire reason we are here — and asking for a
                // sendrecv transceiver would make the browser try to open one.
                pc.addTransceiver('video', { direction: 'recvonly' });

                // Before createOffer — see hintsRef.
                hintsRef.current = pc.createDataChannel('hints', {
                    // Guidance is only useful while it is true. A dropped hint
                    // is replaced by the next one a few hundred milliseconds
                    // later, so retransmitting a stale one is worse than losing
                    // it.
                    ordered: false,
                    maxRetransmits: 0,
                });

                const streamReady = new Promise<MediaStream>((resolve) => {
                    pc.ontrack = (e) => resolve(e.streams[0]);
                });

                await pc.setLocalDescription(await pc.createOffer());
                await iceGatheringComplete(pc);
                await putSdp(room, 'offer', pc.localDescription?.sdp ?? '');

                // Only now is there something to scan.
                setUrl(`${window.location.origin}/handoff/${room}?c=${facing}`);
                setPhase('waiting');

                const answer = await waitForSdp(room, 'answer', abort.signal);
                if (abort.signal.aborted) return;

                setPhase('connecting');
                await pc.setRemoteDescription({ type: 'answer', sdp: answer });

                const stream = await streamReady;
                if (abort.signal.aborted) return;

                streamRef.current = stream;
                installCameraShim(stream);
                setPhase('live');
                setUrl(null);

                // If the phone walks away, the shim is feeding a dead stream —
                // so the hand-off ends rather than leaving every camera screen
                // frozen on the last frame it received.
                pc.addEventListener('connectionstatechange', () => {
                    if (
                        pc.connectionState === 'failed' ||
                        pc.connectionState === 'disconnected' ||
                        pc.connectionState === 'closed'
                    ) {
                        stop();
                    }
                });
            } catch (err) {
                if ((err as Error)?.name === 'AbortError') return;
                console.error('[handoff] failed:', err);
                setError((err as Error)?.message ?? 'The hand-off could not be started.');
                setPhase('failed');
            }
        },
        [stop],
    );

    /**
     * Mirror one line of guidance to the phone. Silently does nothing before
     * the channel opens, which is most of the hand-off's life.
     */
    const sendHint = useCallback((text: string) => {
        const ch = hintsRef.current;
        if (ch?.readyState === 'open') ch.send(text);
    }, []);

    return { phase, url, error, start, stop, sendHint };
}
