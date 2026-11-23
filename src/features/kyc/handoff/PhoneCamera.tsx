'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { HandoffMessage, IdMirror, PhoneStage } from './useCameraHandoff';
import { motion } from 'motion/react';
import { buildOverlayPath } from '@/features/kyc/hooks/useDocumentScanner';
import { CornerBrackets } from '@/features/kyc/components/CornerBrackets';
import { warmUpLandmarker } from '@/features/kyc/hooks/useFaceLandmarker';
import { FaceMesh } from '@/features/kyc/components/FaceMesh';
import { LivenessVerdict } from '@/features/kyc/components/LivenessVerdict';
import { CAPTURE_LIVE_GLASS, GLASS_VARS } from '@/features/kyc/config/capture';
import '@/features/kyc/components/liveness.css';
import { MIRROR_CLASS } from '@/features/kyc/config/capture';
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
/*
 * The phone's video sender (2026-11-24). The link to the computer dropped 10–18 s
 * into a face check — the moment AWS starts uploading the recording from the
 * computer over the same Wi-Fi. The phone's video had no cap and normal priority,
 * which is the setup where it is the one squeezed out. Capped at a rate a face
 * check reads well at, marked high priority (and its packets too, where the
 * browser supports it), and still 'maintain-resolution': under pressure it drops
 * frames, never sharpness.
 */
const SEND_MAX_BITRATE = 1_500_000;
function tuneSender(sender: RTCRtpSender) {
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    params.degradationPreference = 'maintain-resolution';
    params.encodings = (params.encodings?.length ? params.encodings : [{}]).map((e) => ({
        ...e,
        maxBitrate: SEND_MAX_BITRATE,
        maxFramerate: 30,
        priority: 'high',
        networkPriority: 'high',
    })) as RTCRtpEncodingParameters[];
    void sender.setParameters(params).catch(() => {});
}

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
    /**
     * Whether the computer still wants live video.
     *
     * Goes false once the check has what it will judge. The viewfinder then
     * freezes on the captured frame and the camera stops transmitting — showing
     * a live picture of somebody waiting for a verdict is both pointless and,
     * with the phone held at their face, faintly unpleasant.
     */
    const [cameraLive, setCameraLive] = useState(true);
    /*
     * The face check, mirrored (2026-11-24). During a hand-off the person looks at
     * THIS screen, so it draws what the computer draws: the frame's corners, the
     * mesh, the hint, AWS's match bar — then checking, then green or red. The
     * computer still runs and judges the check; this only shows it.
     */
    const mirror = facing === 'user';
    /** The ID scanner's screen, relayed (ID hand-off only). */
    const [idState, setIdState] = useState<IdMirror | null>(null);
    const [idPreview, setIdPreview] = useState<string | null>(null);
    /** The picture's own size, to put the card's corners where they are on THIS frame. */
    const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
    const [stage, setStage] = useState<PhoneStage>('live');
    const [progress, setProgress] = useState<number | null>(null);
    const [snapshot, setSnapshot] = useState<string | null>(null);
    const snapshotRef = useRef<string | null>(null);
    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);
    /** Passed: the camera is off for good and the verdict stays; a closing link is not "ended". */
    const doneRef = useRef(false);
    const [done, setDone] = useState(false);
    const matchRef = useRef(0);
    const meshCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const channelRef = useRef<RTCDataChannel | null>(null);
    /** The glass: a softened second copy of the picture, masked to the face where the mesh finds it. */
    const glassRef = useRef<HTMLVideoElement | null>(null);
    const placeGlass = useCallback((b: { cx: number; cy: number; rx: number; ry: number }) => {
        const el = glassRef.current;
        if (!el) return;
        const pad = CAPTURE_LIVE_GLASS.ovalPad;
        // The copy carries the mirror itself, so it takes the raw (unmirrored) centre — as on the computer.
        el.style.setProperty('--live-glass-cx', b.cx.toFixed(4));
        el.style.setProperty('--live-glass-cy', b.cy.toFixed(4));
        el.style.setProperty('--live-glass-rx', (b.rx * pad).toFixed(4));
        el.style.setProperty('--live-glass-ry', (b.ry * pad).toFixed(4));
    }, []);
    const canvasRef = useRef<HTMLCanvasElement>(null);
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
            let videoSender: RTCRtpSender | null = null;
            stream.getTracks().forEach((t) => {
                // A face check needs every frame the same size: under a weak
                // link, drop frames rather than resolution. The computer redraws
                // at a constant size anyway; this keeps that picture sharp.
                if (t.kind === 'video') t.contentHint = 'detail';
                const sender = pc.addTrack(t, stream);
                if (t.kind === 'video') {
                    videoSender = sender;
                    tuneSender(sender);
                }
            });

            // The computer creates the channel, so this side receives it.
            pc.addEventListener('datachannel', (e) => {
                if (e.channel.label !== 'hints') return;
                channelRef.current = e.channel;
                e.channel.onmessage = (m) => {
                    if (typeof m.data !== 'string') return;
                    let msg: HandoffMessage;
                    try {
                        msg = JSON.parse(m.data) as HandoffMessage;
                    } catch {
                        return;
                    }
                    if (msg.type === 'hint') setHint(msg.text);
                    if (msg.type === 'camera') setCameraLive(msg.live);
                    if (msg.type === 'stage') setStage(msg.stage);
                    if (msg.type === 'id') setIdState(msg.id);
                    if (msg.type === 'idPreview') setIdPreview(msg.src);
                    if (msg.type === 'progress') {
                        setProgress(msg.value);
                        matchRef.current = msg.value ?? 0;
                    }
                };
            });

            setPhase('waiting');
            const offer = await waitForSdp(room, 'offer', abort.signal);

            await pc.setRemoteDescription({ type: 'offer', sdp: offer });
            await pc.setLocalDescription(await pc.createAnswer());
            await iceGatheringComplete(pc);
            await putSdp(room, 'answer', pc.localDescription?.sdp ?? '');

            let dropTimer: ReturnType<typeof setTimeout> | null = null;
            pc.addEventListener('connectionstatechange', () => {
                if (dropTimer) {
                    clearTimeout(dropTimer);
                    dropTimer = null;
                }
                if (pc.connectionState === 'connected') {
                    setPhase('live');
                    // Encodings exist for certain only once negotiated (Safari): set again.
                    if (videoSender) tuneSender(videoSender);
                }

                // ⚠️ `closed` and `disconnected` matter as much as `failed`.
                //
                // The computer closes this peer connection whenever it gives up
                // on the check or starts a fresh hand-off — and a spent room
                // cannot be rescanned, so a NEW code is already on its screen.
                // Watching only `failed` left this phone saying "Connected"
                // beside a dead connection, which is the one thing it must
                // never do: the user stands there following instructions that
                // stopped arriving.
                // A passing `disconnected` gets DROP_GRACE_MS to recover (see useCameraHandoff).
                const end = () => {
                    if (!doneRef.current) setPhase('ended');
                };
                if (pc.connectionState === 'failed' || pc.connectionState === 'closed') end();
                else if (pc.connectionState === 'disconnected') dropTimer = setTimeout(end, 8000);
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

    /**
     * Freeze on the last frame, or go live again.
     *
     * `enabled = false`, NOT `stop()`. Stopping a track is irreversible and
     * removing it from the sender would need a renegotiation — and the whole
     * signaling design here is a single exchange with no channel to renegotiate
     * over. A retry would then find a dead stream and no way to revive it.
     * Disabling transmits black and can be undone the instant the check re-arms.
     *
     * ⚠️ The hardware indicator light stays ON while disabled, because the
     * device is still open. That is worth knowing rather than claiming
     * otherwise: nothing is being sent, but the camera has not been released.
     */
    /*
     * The latest live frame, kept twice a second while filming (2026-11-24).
     *
     * The freeze below used to draw the frame at the moment the computer said
     * "stop filming" — but by then this render had already hidden the video, and
     * iOS Safari hands back BLACK for a hidden video: the checking state and the
     * verdict showed a black frame, and the verdict mesh found no face in it.
     * A copy taken while the picture is still on screen is always a real face.
     */
    const lastFrameRef = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => {
        if (!cameraLive || phase !== 'live') return;
        const keep = () => {
            const video = videoRef.current;
            if (!video?.videoWidth || video.readyState < 2) return;
            const c = lastFrameRef.current ?? document.createElement('canvas');
            lastFrameRef.current = c;
            if (c.width !== video.videoWidth) c.width = video.videoWidth;
            if (c.height !== video.videoHeight) c.height = video.videoHeight;
            c.getContext('2d')?.drawImage(video, 0, 0);
        };
        keep();
        const id = window.setInterval(keep, 500);
        return () => window.clearInterval(id);
    }, [cameraLive, phase]);

    useEffect(() => {
        const stream = streamRef.current;
        const canvas = canvasRef.current;
        const last = lastFrameRef.current;
        if (!stream) return;

        if (!cameraLive) {
            // The last frame kept while the picture was still showing (see above).
            if (canvas && last?.width) {
                canvas.width = last.width;
                canvas.height = last.height;
                canvas.getContext('2d')?.drawImage(last, 0, 0);
                // The same frame is the face the checking state and the verdict show.
                try {
                    setSnapshot(last.toDataURL('image/jpeg', 0.85));
                } catch {
                    /* the verdict shows its dark frame */
                }
            }
            stream.getVideoTracks().forEach((t) => (t.enabled = false));
        } else {
            stream.getVideoTracks().forEach((t) => (t.enabled = true));
        }
    }, [cameraLive]);

    // Leaving this page says so: the connection closes (and with it the channel the
    // computer watches) instead of the computer waiting out a silent link.
    useEffect(() => {
        const leave = () => {
            pcRef.current?.close();
            streamRef.current?.getTracks().forEach((t) => t.stop());
        };
        window.addEventListener('pagehide', leave);
        return () => window.removeEventListener('pagehide', leave);
    }, []);

    // The face the check judged, for the checking and verdict states.
    useEffect(() => {
        // Usually already taken when the camera froze (above); only if not.
        if (stage !== 'checking' || snapshotRef.current) return;
        const c = lastFrameRef.current;
        if (!c?.width) return;
        try {
            setSnapshot(c.toDataURL('image/jpeg', 0.85));
        } catch {
            /* no still: the verdict shows its dark frame */
        }
    }, [stage]);

    // Passed: the camera closes and the verdict stays — no frozen photo, no
    // "session ended" (the computer moves on and closes the link next).
    const [finished, setFinished] = useState(false);
    useEffect(() => {
        if (stage !== 'passed') return;
        doneRef.current = true;
        setDone(true);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        // The green verdict plays out, then this page is finished (2026-11-24): it
        // tries to close itself, and where the browser refuses (a tab opened from a
        // QR usually cannot be closed by its page) it leaves nothing but "Done" —
        // never the verdict's last frame standing on screen.
        const id = window.setTimeout(() => {
            setFinished(true);
            pcRef.current?.close();
            window.close();
        }, 2500);
        return () => window.clearTimeout(id);
    }, [stage]);
    // A new attempt: back to live.
    useEffect(() => {
        if (stage === 'live') setSnapshot(null);
    }, [stage]);

    // The mesh waited for its model, which only started loading once the picture
    // showed. Started at once on a face hand-off: it loads while this connects.
    useEffect(() => {
        if (mirror) void warmUpLandmarker();
    }, [mirror]);

    useEffect(() => {
        if (idState?.finished) setStage('passed');
    }, [idState?.finished]);

    const retryOnComputer = () => {
        const ch = channelRef.current;
        if (ch?.readyState === 'open') ch.send(JSON.stringify({ type: 'retry' } satisfies HandoffMessage));
    };

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

    if (finished) {
        return (
            <main className="flex h-full flex-col items-center justify-center gap-12 bg-white px-20 text-center">
                <p className="fz-16 font-medium text-[#1D1D1D]">Done</p>
                <p className="fz-12 text-[#707070]">
                    {mirror ? 'Your face was verified.' : 'Your ID was captured.'} You can close this page.
                </p>
            </main>
        );
    }

    return (
        <main className="flex h-full flex-col items-center justify-center bg-white px-20">
            {/*
              The phone is a viewfinder, not a control surface. There is no
              capture button: the desktop decides when a frame is taken, because
              the desktop is what runs the check. A shutter here would imply the
              phone was deciding, and invite tapping it at the wrong moment.

              Never mirrored, for either camera. The front view used to flip to
              match every other selfie preview in this app; none of them flip any
              more, so this follows. A back camera never could — text on a
              document would read backwards.
            */}
            <div className="relative h-400 w-350">
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    onLoadedMetadata={(e) => setVideoSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
                    onResize={(e) => setVideoSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
                    className={`h-400 w-350 rad-30 object-cover ${facing === 'user' ? MIRROR_CLASS : ''} ${cameraLive ? '' : 'invisible'}`}
                />

                {/*
                  The frozen frame, drawn the instant the computer said it had
                  what it needed. Mirrored exactly as the live view is, so the
                  picture does not flip at the moment it stops moving.
                */}
                <canvas
                    ref={canvasRef}
                    className={`absolute inset-0 h-400 w-350 rad-30 object-cover ${facing === 'user' ? MIRROR_CLASS : ''} ${cameraLive ? 'hidden' : ''}`}
                />

                {/* The ID scanner as the computer draws it (2026-11-24): the mask around the
                    card, the corners on it, the status, the hold bar, the laser while it is read. */}
                {!mirror && phase === 'live' && idState && <IdOverlay id={idState} video={videoSize} preview={idPreview} />}
                {!mirror && phase === 'live' && idState?.canRetry && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center">
                        <button
                            type="button"
                            onClick={retryOnComputer}
                            title="Try again"
                            aria-label="Try again"
                            className="flex h-56 w-56 items-center justify-center rad-16 border border-white/50 bg-black/40 text-white"
                        >
                            <Icon name="kyc/retry" size={26} mask />
                        </button>
                    </div>
                )}

                {/* The face check as the computer draws it — only for a face, and only once connected. */}
                {mirror && phase === 'live' && stage === 'live' && CAPTURE_LIVE_GLASS.enabled && (
                    // The glass, as on the computer (its "copy" pane): liveness.css shows
                    // it under `.rz-liveness[data-glass='copy']`.
                    <div className="rz-liveness pointer-events-none absolute inset-0 overflow-hidden rad-30" data-glass="copy">
                        <video
                            ref={(el) => {
                                glassRef.current = el;
                                if (el && streamRef.current && el.srcObject !== streamRef.current) {
                                    el.srcObject = streamRef.current;
                                    void el.play().catch(() => {});
                                }
                            }}
                            aria-hidden
                            playsInline
                            muted
                            className={`rz-live-glass rz-live-glass--copy ${MIRROR_CLASS}`}
                            style={GLASS_VARS}
                        />
                    </div>
                )}
                {mirror && phase === 'live' && stage === 'live' && (
                    // NOT mirrored here: the mesh canvas flips itself to match the picture
                    // (FaceMesh, CAPTURE_MIRROR). A second flip made it move against the face.
                    <div className="pointer-events-none absolute inset-0 overflow-hidden rad-30">
                        <FaceMesh videoRef={videoRef} canvasRef={meshCanvasRef} matchRef={matchRef} onBounds={placeGlass} />
                    </div>
                )}
                {mirror && phase === 'live' && stage === 'live' && (
                    <CornerBrackets color="#FFEB00" inset={22} className="z-2" />
                )}
                {mirror && phase === 'live' && stage === 'live' && progress !== null && (
                    // AWS's oval-match bar: blue fill on a light track, as on the computer.
                    <div className="absolute inset-x-24 bottom-12 z-3 h-8 overflow-hidden rounded-full bg-white/30">
                        <div className="h-full rounded-full bg-[#3066CC] transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
                    </div>
                )}
                {mirror && (stage === 'checking' || stage === 'passed' || stage === 'failed') && (
                    <div className="absolute inset-0 z-10 overflow-hidden rad-30">
                        <LivenessVerdict phase={stage} snapshot={snapshot} onRetry={retryOnComputer} />
                    </div>
                )}
                {mirror && stage === 'unavailable' && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-16 rad-30 bg-black/85 px-24">
                        <button
                            type="button"
                            onClick={retryOnComputer}
                            title="Try again"
                            aria-label="Try again"
                            className="flex h-40 w-40 items-center justify-center rad-12 border border-white/40 text-white"
                        >
                            <Icon name="kyc/retry" size={20} mask />
                        </button>
                    </div>
                )}

                {/*
                  ONE line of guidance, over the picture.

                  There were two — this and a paragraph under the frame — both
                  showing the same relayed hint, which read as the screen saying
                  everything twice. The overlay is the one that stays: it sits
                  where the user is already looking.

                  Statuses that are NOT guidance (connecting, ended, failed)
                  still print here, because there is nothing else on this screen
                  to carry them.
                */}
                {!done && (!mirror || stage === 'live') && (hint || phase !== 'live') && !(!mirror && idState) &&
                    (mirror && phase === 'live' ? (
                        // The computer's hint, exactly: a dark pill on ONE line, centred across
                        // the whole frame at its foot (it was positioned from the middle, so it
                        // had half the width and wrapped).
                        <div role="status" className="absolute inset-x-0 z-3 flex justify-center px-12" style={{ bottom: '1.875rem' }}>
                            <span
                                className="max-w-full overflow-hidden rounded-full bg-black/75 text-center fz-14 leading-none font-medium text-ellipsis whitespace-nowrap text-white"
                                style={{ padding: '0.625rem 1rem' }}
                            >
                                {message}
                            </span>
                        </div>
                    ) : (
                        <p
                            role="status"
                            className="fz-16 absolute inset-x-16 bottom-20 rad-12 bg-black/65 px-16 py-12 text-center leading-normal font-semibold text-white"
                        >
                            {message}
                        </p>
                    ))}
            </div>

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
                    className="mt-16 flex h-44 w-44 items-center justify-center rad-12 border border-[#5D5C5D]/40 text-[#1D1D1D] transition-colors hover:border-[#1D1D1D]"
                >
                    <Icon name="kyc/retry" size={20} mask />
                </button>
            )}
        </main>
    );
}

/*
 * The ID scanner's screen on the phone — the same pieces the computer draws
 * (IDCaptureScreen): the dark mask with the card cut out, the four corners that
 * move onto the card, their colour, the status line, the hold-steady bar, and the
 * captured card with the blue laser while it is read.
 */
const FRAME_W = 350;
const FRAME_H = 400;

function IdOverlay({ id, video, preview }: { id: IdMirror; video: { w: number; h: number } | null; preview: string | null }) {
    // The card's corners on THIS frame: the picture fills it like object-cover.
    const pts =
        id.corners && video?.w
            ? (() => {
                  const scale = Math.max(FRAME_W / video.w, FRAME_H / video.h);
                  const ox = (FRAME_W - video.w * scale) / 2;
                  const oy = (FRAME_H - video.h * scale) / 2;
                  return id.corners.map(([x, y]) => [x * video.w * scale + ox, y * video.h * scale + oy] as const);
              })()
            : null;
    const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`;
    /*
     * The brackets, exactly as IDCaptureScreen places them: 18 × 18, 3 px, radius 10.
     * Not locked: 20 in from each edge of the frame. Locked: each one's outer corner
     * ON the card's corner (top-left at it; top-right ending at it; and so on).
     */
    const inset = 20;
    const size = 18;
    const at = (i: number): [number, number] => {
        const p = id.locked && pts ? pts[i] : null;
        if (!p) {
            return [
                [inset, inset],
                [FRAME_W - inset - size, inset],
                [FRAME_W - inset - size, FRAME_H - inset - size],
                [inset, FRAME_H - inset - size],
            ][i] as [number, number];
        }
        const x = i === 1 || i === 2 ? p[0] - size : p[0];
        const y = i >= 2 ? p[1] - size : p[1];
        return [Math.max(inset, x), Math.max(inset, y)];
    };
    const corner = (i: number) => {
        const [x, y] = at(i);
        return (
            <div
                key={i}
                className="absolute h-18 w-18"
                style={{
                    left: pct(x, FRAME_W),
                    top: pct(y, FRAME_H),
                    borderColor: id.color,
                    borderStyle: 'solid',
                    borderWidth: 0,
                    ...(i === 0 ? { borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 } : {}),
                    ...(i === 1 ? { borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 } : {}),
                    ...(i === 2 ? { borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 } : {}),
                    ...(i === 3 ? { borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 } : {}),
                    transition: 'top 0.25s ease, left 0.25s ease, border-color 0.5s ease',
                }}
            />
        );
    };
    return (
        <div className="pointer-events-none absolute inset-0 z-5 overflow-hidden rad-30" dir="ltr">
            {pts && (
                <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${FRAME_W} ${FRAME_H}`} preserveAspectRatio="none" aria-hidden>
                    <path
                        d={buildOverlayPath(
                            {
                                topLeft: { x: pts[0][0], y: pts[0][1] },
                                topRight: { x: pts[1][0], y: pts[1][1] },
                                bottomRight: { x: pts[2][0], y: pts[2][1] },
                                bottomLeft: { x: pts[3][0], y: pts[3][1] },
                            },
                            FRAME_W,
                            FRAME_H,
                        )}
                        fill="rgba(0, 0, 0, 0.85)"
                        fillRule="evenodd"
                    />
                </svg>
            )}
            <div className="absolute inset-0">
                {[0, 1, 2, 3].map(corner)}
            </div>
            {id.hold !== null && (
                <div className="absolute inset-x-0 bottom-0 h-0.75 overflow-hidden bg-black/20">
                    <div
                        className="h-full transition-all duration-150"
                        style={{ width: `${Math.round(id.hold * 100)}%`, backgroundColor: id.holdReady ? '#22C55E' : '#F59E0B' }}
                    />
                </div>
            )}
            {(id.state === 'processing' || preview) && preview && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 backdrop-blur-sm">
                    <div className="relative w-11/12 overflow-hidden rounded-xl border border-white/20 shadow-2xl">
                        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from the computer */}
                        <img src={preview} alt="" className="h-auto w-full object-contain" />
                        <motion.div
                            className="pointer-events-none absolute start-0 end-0 z-20"
                            style={{
                                height: '3px',
                                background: 'linear-gradient(90deg, transparent 0%, rgba(122,168,255,0.95) 50%, transparent 100%)',
                                boxShadow: '0 0 14px 3px rgba(122,168,255,0.7)',
                            }}
                            animate={{ top: ['0%', '100%', '0%'] }}
                            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                        />
                    </div>
                </div>
            )}
            {id.state !== 'idle' && id.state !== 'done' && id.status && (
                <div className="absolute start-16 end-16 bottom-16 z-20 text-center">
                    <p className="rounded-lg bg-black/50 px-12 py-8 text-xs text-white">{id.status}</p>
                </div>
            )}
        </div>
    );
}
