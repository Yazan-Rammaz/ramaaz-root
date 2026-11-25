'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ICE_SERVERS,
    iceGatheringComplete,
    newRoomId,
    putSdp,
    waitForSdp,
} from './signaling';
import { installCameraShim, uninstallCameraShim, endRelayedTrack } from './cameraShim';

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

/**
 * What travels over the data channel, in both directions of understanding.
 *
 * Shared with the phone page so the two ends cannot drift — this is the whole
 * protocol between them, and it is small on purpose.
 */
export type HandoffMessage =
    /** A line of the check's guidance, to show over the viewfinder. */
    | { type: 'hint'; text: string }
    /** Whether live video is still wanted. False = freeze and stop filming. */
    | { type: 'camera'; live: boolean }
    /**
     * Where the check is (2026-11-24): the phone is the screen the person looks at
     * during a hand-off, so it draws the same frame — mesh, checking, the verdict.
     */
    | { type: 'stage'; stage: PhoneStage }
    /** How full AWS's oval-match bar is, 0..1 (null: no bar on screen). */
    | { type: 'progress'; value: number | null }
    /** PHONE → computer: the person pressed retry on the phone. */
    | { type: 'retry' }
    /** The computer is finished with this camera: the phone closes it now (see stop). */
    | { type: 'end' }
    /** The ID scanner's screen, drawn on the phone (2026-11-24). */
    | { type: 'id'; id: IdMirror }
    /** The captured card while it is checked (sent once per capture, small). */
    | { type: 'idPreview'; src: string | null };

/**
 * What the ID scanner shows, for the phone to draw over its own picture.
 * `corners` are the card's, as fractions of the VIDEO (the same stream on both
 * ends), so each screen maps them onto its own frame.
 */
export type IdMirror = {
    state: 'idle' | 'aligning' | 'capturing' | 'processing' | 'success' | 'done';
    status: string;
    color: string;
    corners: [number, number][] | null;
    locked: boolean;
    /** The hold-steady bar, 0..1 (null: not shown). */
    hold: number | null;
    holdReady: boolean;
    side: 'front' | 'back';
    passport: boolean;
    /** Every side is captured: the phone may finish. */
    finished: boolean;
    /** Waiting to start, or the camera failed: the phone offers Retry. */
    canRetry: boolean;
};

/** The check's state, as the phone draws it. */
export type PhoneStage = 'live' | 'checking' | 'passed' | 'failed' | 'unavailable';

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


/*
 * `disconnected` is often a passing state, not an end: ICE's consent checks
 * arrive late while the computer is busy (AWS's detector, measured 2026-11-24)
 * and the link reports `disconnected` for a second before it recovers. Ending
 * the hand-off right then killed a working phone camera — the phone said
 * "session ended" and the computer's next attempt waited for ever on a camera
 * that was gone. So a drop is given this long to come back; `failed` and
 * `closed` still end it at once.
 */
const DROP_GRACE_MS = 8000;

/**
 * What the link looked like when it dropped, in the log (2026-11-24): how the two
 * are connected (direct on the Wi-Fi, or through the internet), the round trip,
 * the bandwidth the computer estimated, and how much video had arrived. A drop
 * then says whether it was congestion, a network change, or the phone going quiet.
 */
async function reportDrop(pc: RTCPeerConnection) {
    try {
        const stats = await pc.getStats();
        let pair: Record<string, unknown> | null = null;
        let video: Record<string, unknown> | null = null;
        const byId = new Map<string, Record<string, unknown>>();
        stats.forEach((r) => byId.set(r.id, r as Record<string, unknown>));
        stats.forEach((r) => {
            const s = r as Record<string, unknown>;
            if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') pair = s;
            if (s.type === 'inbound-rtp' && s.kind === 'video') video = s;
        });
        const p = pair as Record<string, unknown> | null;
        const v = video as Record<string, unknown> | null;
        const local = p ? byId.get(String(p.localCandidateId)) : undefined;
        const remote = p ? byId.get(String(p.remoteCandidateId)) : undefined;
        console.info('[handoff] link dropped', {
            state: pc.connectionState,
            route: local && remote ? `${local.candidateType}/${local.protocol} ↔ ${remote.candidateType}` : null,
            rttMs: typeof p?.currentRoundTripTime === 'number' ? Math.round(p.currentRoundTripTime * 1000) : null,
            inKbps: typeof p?.availableIncomingBitrate === 'number' ? Math.round(p.availableIncomingBitrate / 1000) : null,
            framesReceived: v?.framesReceived ?? null,
            framesDropped: v?.framesDropped ?? null,
            packetsLost: v?.packetsLost ?? null,
            bytesReceived: v?.bytesReceived ?? null,
        });
    } catch {
        /* nothing to report */
    }
}

export function useCameraHandoff({ onPhoneRetry }: { onPhoneRetry?: () => void } = {}) {
    // Read through a ref: the channel handler is set once, the callback changes.
    const retryRef = useRef(onPhoneRetry);
    useEffect(() => {
        retryRef.current = onPhoneRetry;
    }, [onPhoneRetry]);
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

        // Say so before closing (2026-11-25). Closing alone, the phone only learnt it
        // when the link timed out — up to ~30 s of its camera still filming after face
        // reverify ended on a failure or a cancel. Best effort; the channel's close,
        // just below, tells the phone too.
        if (hintsRef.current?.readyState === 'open') {
            try {
                hintsRef.current.send(JSON.stringify({ type: 'end' } satisfies HandoffMessage));
            } catch {
                /* closing anyway */
            }
        }
        hintsRef.current?.close();
        hintsRef.current = null;

        pcRef.current?.close();
        pcRef.current = null;

        streamRef.current?.getTracks().forEach(endRelayedTrack);
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
                // The phone closed its page (or its browser): the channel closes within
                // a moment, long before the connection admits it is gone — and in the
                // meantime every camera screen was fed black ("Too dark — find more
                // light"). The hand-off ends now, which opens a new QR (2026-11-24).
                // This hand-off's own channel: a LATER one replaces it in hintsRef.
                const channel = hintsRef.current;
                channel.addEventListener('message', (m) => {
                    try {
                        const msg = JSON.parse(String(m.data)) as HandoffMessage;
                        if (msg.type === 'retry') retryRef.current?.();
                    } catch {
                        /* not ours */
                    }
                });
                channel.addEventListener('close', () => {
                    // Only while it is still THE hand-off. Starting a new code closes the
                    // old channel, and its close arrives after the new one has begun: ending
                    // "the hand-off" then killed the NEW one, and the frame went black
                    // (the retry under the QR, 2026-11-24).
                    if (hintsRef.current !== channel) return;
                    stop();
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
                // The same when the phone's video track itself ends (its camera
                // closed) while the connection lingers.
                stream.getVideoTracks().forEach((t) => t.addEventListener('ended', stop));
                let dropTimer: ReturnType<typeof setTimeout> | null = null;
                pc.addEventListener('connectionstatechange', () => {
                    if (dropTimer) {
                        clearTimeout(dropTimer);
                        dropTimer = null;
                    }
                    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') void reportDrop(pc);
                    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') stop();
                    else if (pc.connectionState === 'disconnected') dropTimer = setTimeout(stop, DROP_GRACE_MS);
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
     * Send one message to the phone. Silently does nothing before the channel
     * opens, which is most of the hand-off's life.
     *
     * JSON rather than bare text: the channel carries two kinds of message now
     * — the check's guidance, and whether live video is still wanted — and a
     * plain string cannot say which it is.
     */
    const post = useCallback((msg: HandoffMessage) => {
        const ch = hintsRef.current;
        if (ch?.readyState === 'open') ch.send(JSON.stringify(msg));
    }, []);

    const sendHint = useCallback(
        (text: string) => post({ type: 'hint', text }),
        [post],
    );

    /**
     * Tell the phone whether its camera is still wanted.
     *
     * Sent when the check stops needing live video — it has what it is going to
     * judge, and the phone should stop filming and show what was captured
     * rather than a live picture of somebody waiting.
     */
    const sendCameraLive = useCallback(
        (live: boolean) => post({ type: 'camera', live }),
        [post],
    );

    const sendStage = useCallback((stage: PhoneStage) => post({ type: 'stage', stage }), [post]);
    const sendProgress = useCallback((value: number | null) => post({ type: 'progress', value }), [post]);
    const sendId = useCallback((id: IdMirror) => post({ type: 'id', id }), [post]);
    const sendIdPreview = useCallback((src: string | null) => post({ type: 'idPreview', src }), [post]);

    return { phase, url, error, start, stop, sendHint, sendCameraLive, sendStage, sendProgress, sendId, sendIdPreview };
}
