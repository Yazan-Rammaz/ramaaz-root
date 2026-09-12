'use client';

import {
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type CSSProperties,
    type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { CustomQRCode } from '@/components/ui/CustomQR';
import { useCameraHandoff, type HandoffFacing } from './useCameraHandoff';
import { detectCameraTrouble, isHandheldDevice, type CameraTrouble } from './cameraShim';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/** A device does not stop being a phone, so there is nothing to subscribe to. */
const NEVER_CHANGES = () => () => {};

/**
 * "Checking…Checking…" → "Checking…".
 *
 * A guard, not the fix — the selector above is. Amplify renders its hints twice
 * for assistive tech, and reading the wrong node concatenates both copies; if
 * their markup shifts again this keeps the phone readable rather than silently
 * echoing.
 *
 * Only collapses an EXACT doubling, so a hint that genuinely repeats a word
 * survives untouched.
 */
function collapseRepeat(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    const half = Math.floor(t.length / 2);
    if (half < 2) return t;
    const a = t.slice(0, half).trim();
    const b = t.slice(half).trim();
    return a && a === b ? a : t;
}

/**
 * The desktop's offer of a phone camera, and the only new thing on screen.
 *
 * ── Additive by design ──────────────────────────────────────────────────────
 * Mount this next to a capture step and nothing else changes. It does not wrap,
 * replace or configure the capture screens — when the phone connects it
 * installs the `getUserMedia` shim and those screens pick up the stream on
 * their own, still believing they opened a local camera.
 *
 * ── Offered early, not after a fight ────────────────────────────────────────
 * `detectCameraTrouble()` runs on mount rather than after N failed attempts.
 * The commonest reason to need this is a DENIED permission, and a denial is
 * remembered per origin: the browser will not prompt again, so retrying is
 * something the user can do forever without it ever working. Waiting for
 * repeated failures would just be watching somebody fail.
 */
export function CameraHandoffPanel({
    facing,
    onLive,
    frameRef,
    style,
    cameraLive = true,
}: {
    /** 'user' for the face step, 'environment' for a document. */
    facing: HandoffFacing;
    /**
     * Fired once, when the phone's video starts flowing.
     *
     * ⚠️ Load-bearing. Installing the shim does NOT redirect a camera that has
     * already been opened — or already failed to open, which is the whole
     * reason somebody is here. The capture screen has to ASK for a camera again
     * to receive the phone's, so the host re-arms itself here: a new AWS
     * liveness attempt, or another `startCamera()`. Without it the QR connects,
     * the panel goes green, and the frame stays exactly as dead as it was.
     */
    onLive?: () => void;
    /**
     * Whether the host still wants live video.
     *
     * Goes false the moment the check stops filming — it has what it will
     * judge. The phone is told, so it freezes on the captured frame and stops
     * transmitting instead of showing a live picture of somebody waiting for a
     * verdict. Back to true if the check re-arms for another attempt.
     *
     * Defaults to true so a host that does not care never freezes the phone.
     */
    cameraLive?: boolean;
    /**
     * The camera frame this hand-off belongs to.
     *
     * ⚠️ This component mounts OUTSIDE that frame and portals its overlay back
     * in, which looks roundabout until you try the obvious thing.
     *
     * The frame is `overflow-hidden` (it has a 30px radius to clip the video
     * to). Mount the whole panel inside it and the trigger link — which belongs
     * BELOW the frame, not over the picture — is positioned outside the frame's
     * box and clipped away. It rendered, it just could not be seen, which is
     * exactly the "Camera blocked — use your phone doesn't appear" report.
     *
     * So: the text sits in normal flow under the frame where nothing clips it,
     * and the QR overlay is portalled into the frame where it needs to cover
     * the camera. One component, one piece of state, two places on screen.
     */
    frameRef: RefObject<HTMLElement | null>;
    /**
     * Optional override for the control's position.
     *
     * It pins itself to the top-end corner of the nearest positioned ancestor,
     * which in the sign-in flow is the auth shell — so the default is the
     * corner of the PAGE, opposite the brand mark. A host with a different
     * frame of reference can move it; most should not need to.
     */
    style?: CSSProperties;
}) {
    const { phase, url, error, start, stop, sendHint, sendCameraLive } = useCameraHandoff();

    /**
     * The frame element, resolved AFTER mount.
     *
     * A portal needs a real DOM node, and `frameRef.current` is null on the
     * first render — so reading it during render would decide "no frame" once
     * and never revisit it, which is exactly what `react-hooks/refs` is warning
     * about. Copying it into state on mount gives the re-render that makes the
     * portal appear.
     */
    const [frameEl, setFrameEl] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setFrameEl(frameRef.current);
    }, [frameRef]);
    const [trouble, setTrouble] = useState<CameraTrouble | null>(null);
    /**
     * Whether this is a phone or tablet, and so should not be offered a
     * hand-off at all.
     *
     * `useSyncExternalStore` rather than state-in-an-effect: the value reads
     * `navigator`, which does not exist on the server, and this is the API
     * built for exactly that — a client-only value read without a hydration
     * mismatch and without writing state on mount.
     *
     * The server snapshot is `true` (assume handheld, render nothing), so the
     * offer APPEARS on desktop a moment after hydration rather than flashing on
     * every phone and vanishing. Late is better than wrong.
     *
     * Never subscribes: a device does not stop being a phone.
     */
    const handheld = useSyncExternalStore(NEVER_CHANGES, isHandheldDevice, () => true);

    useEffect(() => {
        void detectCameraTrouble().then(setTrouble);
    }, []);

    /**
     * Mirror the check's guidance to the phone while the hand-off is live.
     *
     * ⚠️ Without this the hand-off is close to unusable for the face step. AWS
     * renders "move closer", "hold still", "centre your face" on the COMPUTER —
     * and during the check the user is looking at their phone, because that is
     * where the camera is. They get corrected by a screen behind them.
     *
     * ⚠️ It watches the FRAME, not the hint node, and that is the fix rather
     * than a detail. Looking the hint up once — `querySelector` then bail if
     * null — could never work here: going live REMOUNTS the AWS widget (that is
     * what `onLive` is for), so at the instant this effect runs the hint node
     * does not exist yet. It bailed every time and no hint was ever sent.
     *
     * The frame outlives the widget inside it, so observing that catches the
     * node appearing and every later change to it.
     *
     * Amplify exposes no hook for the current hint, so this reads the DOM —
     * making it the most brittle thing in the hand-off. It fails SILENTLY: no
     * node, no hints, and the video still works.
     */
    useEffect(() => {
        if (phase !== 'live' || !frameEl) return;

        let last = '';
        const push = () => {
            // `__text` is the TEXT; `.amplify-liveness-hint` is the container
            // around it. Reading the container concatenated the visible label
            // with the aria-live copy beside it, so every hint arrived on the
            // phone doubled — "Checking…Checking…". Fall back to the container
            // only if Amplify ever drops the inner class.
            const node =
                frameEl.querySelector('.amplify-liveness-hint__text') ??
                frameEl.querySelector('.amplify-liveness-hint');

            const text = collapseRepeat((node?.textContent ?? '').trim());
            if (text && text !== last) {
                last = text;
                sendHint(text);
            }
        };

        push();
        const observer = new MutationObserver(push);
        observer.observe(frameEl, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        return () => observer.disconnect();
    }, [phase, sendHint, frameEl]);

    // Pass the host's camera state along whenever it changes — and once when
    // the connection opens, so a phone that joins mid-check is not left filming.
    useEffect(() => {
        if (phase !== 'live') return;
        sendCameraLive(cameraLive);
    }, [phase, cameraLive, sendCameraLive]);

    // Once per transition into `live`, never on a re-render. Re-arming twice
    // would open a second AWS liveness session — billed, and single-use.
    const announced = useRef(false);
    useEffect(() => {
        if (phase === 'live' && !announced.current) {
            announced.current = true;
            onLive?.();
        }
        if (phase === 'idle') announced.current = false;
    }, [phase, onLive]);

    // ── Not offered on a phone or tablet ────────────────────────────────────
    //
    // The whole feature is "borrow a camera from a device that has one". On a
    // handheld the camera is already here, so the offer is at best noise and at
    // worst a QR code asking to be scanned by the device displaying it.
    //
    // ⚠️ Once a hand-off is RUNNING this must not tear it down. `eligible` is
    // fixed for the life of the page, so it cannot flip mid-session, but the
    // phase check keeps the guard honest if that ever stops being true.
    if (handheld && phase === 'idle') return null;

    // ── The control, pinned top-right of the page ───────────────────────────
    //
    // An icon with a `title`, not an underlined sentence competing with the
    // capture UI for attention. It shows the camera you would move TO — a phone
    // while you are on this computer's camera, a monitor while you are on the
    // phone's — so the glyph states the outcome rather than the current state.
    //
    // ⚠️ ONE EXCEPTION, and it is the important one. When the camera is
    // genuinely unusable — no device, or a permission this origin can no longer
    // prompt for — the label comes back alongside the icon.
    //
    // An icon with a hover tooltip is a fine affordance for an optional extra.
    // It is a poor one for the only way forward, and that is exactly what this
    // becomes for somebody whose camera is blocked: they are stuck, and the
    // single thing that can unstick them would be an unlabelled glyph in a
    // corner they have no reason to look at. So in that case it says what it is.
    const stuck = trouble === 'no-camera' || trouble === 'denied';

    const control =
        phase === 'live'
            ? {
                  icon: 'kyc/camera_desktop',
                  title: "Switch back to this computer's camera",
                  onClick: stop,
                  label: null as string | null,
              }
            : phase === 'idle'
              ? {
                    icon: 'kyc/camera_phone',
                    title: "Use your phone's camera",
                    onClick: () => void start(facing),
                    label:
                        trouble === 'no-camera'
                            ? 'No camera here — use your phone'
                            : trouble === 'denied'
                              ? 'Camera blocked — use your phone'
                              : null,
                }
              : null;

    // ── The overlay, portalled INTO the frame ───────────────────────────────
    //
    // Only while there is something to show. Once the phone is connected this
    // is null and the frame shows the phone's camera, drawn by the capture
    // screen exactly as it draws a local one.
    const overlayNeeded =
        phase === 'preparing' ||
        phase === 'waiting' ||
        phase === 'connecting' ||
        phase === 'failed';

    const overlay =
        overlayNeeded && frameEl
            ? createPortal(
                  <div
                      className="absolute inset-0 z-30 flex flex-col items-center justify-center rad-30 border border-[#5D5C5D]/40 bg-white p-24"
                  >
                      {phase === 'preparing' && (
                          <p className="fz-12 leading-none font-medium text-[#707070]">
                              Preparing…
                          </p>
                      )}

                      {phase === 'waiting' && (
                          <>
                              {/*
                                Drawn synchronously from the URL, so no async
                                step can leave the PREVIOUS step's code on
                                screen while the next one encodes — each step
                                mints a new room, and a stale code is a live one
                                for a room already spent.
                              */}
                              <CustomQRCode value={url ?? ''} size={200} />
                              <p
                                  className="fz-12 max-w-300 text-center leading-none font-medium text-[#1D1D1D]"
                                  style={{ marginTop: rem(16) }}
                              >
                                  Scan with your phone.
                              </p>
                              <button
                                  type="button"
                                  onClick={stop}
                                  aria-label="Cancel"
                                  title="Cancel"
                                  className="text-[#707070]"
                                  style={{ marginTop: rem(12) }}
                              >
                                  <Icon name="kyc/retry" size={20} mask />
                              </button>
                          </>
                      )}

                      {phase === 'connecting' && (
                          <p className="fz-12 leading-none font-medium text-[#707070]">
                              Connecting…
                          </p>
                      )}

                      {phase === 'failed' && (
                          <>
                              <p className="fz-12 max-w-300 text-center leading-normal font-medium text-red-500">
                                  {error}
                              </p>
                              <button
                                  type="button"
                                  onClick={() => void start(facing)}
                                  aria-label="Try again"
                                  title="Try again"
                                  className="text-primary"
                                  style={{ marginTop: rem(12) }}
                              >
                                  <Icon name="kyc/retry" size={22} mask />
                              </button>
                          </>
                      )}
                  </div>,
                  frameEl,
              )
            : null;

    return (
        <>
            {overlay}

            {control && (
                <div className="absolute top-20 end-20 z-40 flex items-center gap-8" style={style}>
                    {/* Visible ONLY when the icon is the only way forward. */}
                    {/* {control.label && (
                        <span className="fz-12 leading-none font-medium text-[#707070]">
                            {control.label}
                        </span>
                    )} */}
                    {/*
                      A real button, with a size and an edge.

                      It was a bare <Icon> with no padding and no bounds: the
                      target was a 22px glyph with transparent gaps, so where it
                      began and ended was a matter of opinion, and the <p> it sat
                      in stretched the row far wider than anything clickable.
                      A bordered 40px box states its own hit area — and at that
                      size it is a deliberate press rather than something you
                      find by accident.
                    */}
                    <button
                        type="button"
                        onClick={control.onClick}
                        title={control.title}
                        aria-label={control.title}
                        className={`flex h-40 w-40 shrink-0 items-center justify-center rad-12 border bg-white/90 transition-colors ${
                            stuck
                                ? 'text-primary border-primary'
                                : 'text-[#5D5C5D] border-[#5D5C5D]/40 hover:text-primary hover:border-primary'
                        }`}
                    >
                        <Icon name={control.icon} size={22} mask />
                    </button>
                </div>
            )}
        </>
    );
}
