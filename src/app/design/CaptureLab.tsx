'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { CornerBrackets } from '@/features/kyc/components/CornerBrackets';
import { LivenessVerdict } from '@/features/kyc/components/LivenessVerdict';
import {
    CAPTURE_BEAUTY,
    CAPTURE_LIGHTING,
    CAPTURE_PORTRAIT,
    CAPTURE_RESOLUTION,
    CAPTURE_TONE,
} from '@/features/kyc/config/capture';
import {
    installCaptureQuality,
    uninstallCaptureQuality,
} from '@/features/kyc/handoff/cameraShim';
import {
    describeCapture,
    grabFrame,
    processFrame,
    type FaceCapture,
} from '@/features/kyc/services/faceCapture';
import { analyseTone, applyTone } from '@/features/kyc/services/captureLook';
import { applyLook, type LightingStyle } from '@/features/kyc/services/look';
import { useLivePreview } from '@/features/kyc/hooks/useLivePreview';
import { applyPortrait, kickstartSegmenter } from '@/features/kyc/services/portrait';

/**
 * The capture bench — judge the photograph without walking a sign-in.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The captured face was reported as ugly, and every previous attempt to fix
 * that was judged by running a whole sign-in: a fresh access link, a WhatsApp
 * code, a passcode, an AWS session that costs money, and a camera that had to
 * be satisfied before any picture existed at all. That is enough friction that
 * the comparison never actually got made side by side — which is most of why
 * the first attempt shipped a look that was tuned in one room and wrong in the
 * next (`git log` 554df2b, 5d7f21c).
 *
 * This page opens the camera, takes a still through the EXACT pipeline the
 * sign-in uses, and shows every stage of it against the untouched frame. No
 * challenge, no session, no Rekognition, no cost, nothing leaves the browser.
 *
 * ── Why it cannot drift from the real thing ─────────────────────────────────
 * Because it does not reimplement any of it. `grabFrame` and `processFrame` are
 * the same functions `LivenessCamera` calls, and `CAPTURE_*` are the same
 * constants both read. A stage toggled off here is skipped by re-running those
 * functions' parts by hand — see `renderStages` — but the DEFAULT column is
 * literally `processFrame`, so what you approve is what ships.
 *
 * ── The one thing it cannot reproduce ───────────────────────────────────────
 * AWS's oval. The real check demands the face fill about 97% of the frame's
 * height, which is why captures from a real run are framed tighter than
 * anything taken here. Judge SHARPNESS, COLOUR and the PORTRAIT look on this
 * page; judge FRAMING on /design/liveness-lab or a real run. The note under the
 * frame says so, because it is the one way this bench can mislead.
 */

/** XD px -> the scaling rem this project measures in (AGENTS.md §1). */
const rem = (px: number) => `${px * 0.0625}rem`;

type Source = 'camera' | 'file';

/** One rendered version of the capture, and what it cost to make. */
type Variant = {
    key: string;
    label: string;
    note: string;
    url: string;
    bytes: number;
    brightness?: number;
    sharpness?: number;
};

export function CaptureLab() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    /** The untouched frame every variant below is built from. */
    const frameRef = useRef<HTMLCanvasElement | null>(null);
    /** The retouched live view, painted over the camera. */
    const liveCanvasRef = useRef<HTMLCanvasElement>(null);

    const [source, setSource] = useState<Source>('camera');
    // Explicitly `boolean`: `CAPTURE_RESOLUTION` is `as const`, so the initial
    // value narrows to the literal `true` and the toggle below cannot set it.
    const [boost, setBoost] = useState<boolean>(CAPTURE_RESOLUTION.enabled);
    const [streamSize, setStreamSize] = useState<{ w: number; h: number } | null>(null);
    const [cameraError, setCameraError] = useState<string | null>(null);

    const [variants, setVariants] = useState<Variant[]>([]);
    const [shipped, setShipped] = useState<FaceCapture | null>(null);
    const [busy, setBusy] = useState(false);
    /** Which variant the 350x400 frame is showing. */
    const [showing, setShowing] = useState(0);
    const [mirror, setMirror] = useState(true);
    /** Paint the selected variant into the real verdict chrome. */
    const [inChrome, setInChrome] = useState(false);
    /**
     * Beauty strength, live.
     *
     * A slider rather than a toggle because this is the one setting whose right
     * value is a judgement call about a specific face in specific light, and no
     * amount of reasoning in `config/capture.ts` substitutes for moving it and
     * looking. What is chosen here goes into `CAPTURE_BEAUTY.strength`.
     */
    const [beautyStrength, setBeautyStrength] = useState<number>(CAPTURE_BEAUTY.strength);
    /**
     * Portrait Lighting style, the way the iPhone offers them.
     *
     * `natural` is Apple's "no effect" and means the same here. Stage Light is
     * absent on purpose — it needs the background dropped to black, which means
     * trusting the segmentation mask absolutely, and a flat background was
     * already tried here and read as a cut-out (`git log` 5d7f21c).
     */
    const [lightStyle, setLightStyle] = useState<LightingStyle>(CAPTURE_LIGHTING.style);
    /**
     * Background defocus on the LIVE view.
     *
     * Separate from the stage list below, which always renders it: this one
     * costs a segmentation pass per 150ms and is the most likely thing to push
     * a weaker device into the governor's lap. Being able to turn it off alone
     * is how you find out whether it is what made the preview stutter.
     */
    const [livePortrait, setLivePortrait] = useState<boolean>(CAPTURE_PORTRAIT.enabled);

    /**
     * The live look, driven by the same sliders as the stages below.
     *
     * The point of having it HERE as well as in the flow is that the governor
     * is invisible until you watch it work: this prints the measured frame cost
     * and the resolution it settled on, so "is this affordable on the devices
     * the admins actually use" is a number rather than a hope.
     */
    const live = useLivePreview({
        videoRef,
        canvasRef: liveCanvasRef,
        enabled: source === 'camera' && variants.length === 0,
        beauty: beautyStrength,
        lighting: lightStyle,
        portrait: livePortrait,
    });

    // Unconditionally, unlike the flow: this page forces the portrait stage so
    // it can be judged, so it always needs the model.
    useEffect(() => kickstartSegmenter(), []);

    // ── The camera ──────────────────────────────────────────────────────────
    /*
     * Opened with AWS's own constraints, deliberately.
     *
     * The point of this bench is the picture the LIVENESS path produces, and
     * that path does not get to choose its camera settings — AWS asks for
     * 640x480 and `installCaptureQuality` raises it. Opening this page's camera
     * any other way would be benchmarking a camera nobody uses.
     */
    const stopCamera = useCallback(() => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
    }, []);

    const startCamera = useCallback(async () => {
        setCameraError(null);
        stopCamera();
        if (boost) {
            installCaptureQuality({
                width: CAPTURE_RESOLUTION.width,
                height: CAPTURE_RESOLUTION.height,
            });
        } else {
            uninstallCaptureQuality();
        }
        try {
            // AWS's STATIC_VIDEO_CONSTRAINTS, verbatim. The boost above edits
            // these on the way past, exactly as it does for the real check.
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { min: 320, ideal: 640 },
                    height: { min: 240, ideal: 480 },
                    frameRate: { min: 15, ideal: 30, max: 60 },
                    facingMode: 'user',
                },
                audio: false,
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            const s = stream.getVideoTracks()[0]?.getSettings();
            setStreamSize({ w: s?.width ?? 0, h: s?.height ?? 0 });
        } catch (err) {
            setCameraError(err instanceof Error ? err.message : 'could not open camera');
        }
    }, [boost, stopCamera]);

    useEffect(() => {
        if (source !== 'camera') {
            stopCamera();
            return;
        }
        // Deferred a frame, the same way LivenessLab starts its first run.
        // `startCamera` sets state — the error line, the delivered stream size
        // — and doing that synchronously in an effect body is the cascading
        // render the lint rule refuses. The KYC folder has that rule downgraded
        // to a warning; `app/design` does not, and should not.
        const raf = requestAnimationFrame(() => void startCamera());
        return () => {
            cancelAnimationFrame(raf);
            stopCamera();
            uninstallCaptureQuality();
        };
    }, [source, startCamera, stopCamera]);

    // ── Building the variants ───────────────────────────────────────────────
    /**
     * Every stage, separately, from one frame.
     *
     * The stages are re-run by hand here rather than being switched off inside
     * `processFrame`, because a config flag read at module scope cannot be
     * toggled from a page. What that costs is the risk of this list drifting
     * from the real pipeline — so the LAST variant is `processFrame` itself,
     * unmodified, and it is the one labelled "ships". If it ever stops matching
     * the stage-by-stage build above it, that difference is the bug.
     */
    const renderStages = useCallback(
        async (frame: HTMLCanvasElement, beauty: number, light: LightingStyle) => {
        const out: Variant[] = [];
        const q = 0.92;

        const copy = () => {
            const c = document.createElement('canvas');
            c.width = frame.width;
            c.height = frame.height;
            c.getContext('2d')?.drawImage(frame, 0, 0);
            return c;
        };

        const push = (key: string, label: string, note: string, c: HTMLCanvasElement) => {
            const url = c.toDataURL('image/jpeg', q);
            const d = describeCapture(c);
            out.push({
                key,
                label,
                note,
                url,
                bytes: Math.round((url.length * 3) / 4),
                brightness: d?.brightness,
                sharpness: d?.sharpness,
            });
        };

        // 1. Raw — what shipped before any of this.
        push('raw', 'Raw', 'The frame exactly as the camera gave it.', copy());

        // 2. Tone only.
        const toned = copy();
        const tone = analyseTone(frame);
        if (tone) applyTone(toned, tone);
        push(
            'tone',
            'Tone',
            tone
                ? `exposure ×${tone.exposure.toFixed(2)} · levels ${tone.black}–${tone.white}` +
                      ` · face luma ${(tone.faceLuma * 100).toFixed(0)}%` +
                      (tone.flat ? ' · flat frame, stretch capped' : '')
                : 'could not measure this frame',
            toned,
        );

        // 3. Tone + beauty.
        const beautyCanvas = copy();
        if (tone) applyTone(beautyCanvas, tone);
        const bty = applyLook(beautyCanvas, { beauty, lighting: false, force: true });
        push(
            'beauty',
            '+ beauty',
            bty.beautyApplied
                ? `strength ${beauty.toFixed(2)} · radius ${bty.radius}px · skin ` +
                      `${((bty.skinShare ?? 0) * 100).toFixed(0)}% of frame`
                : `skipped — ${bty.reason ?? 'no change'}`,
            beautyCanvas,
        );

        // 4. …and the lighting style on top. This is what ships.
        const lightCanvas = copy();
        if (tone) applyTone(lightCanvas, tone);
        const lit = applyLook(lightCanvas, { beauty, lighting: light, force: true });
        push(
            'light',
            `+ ${light}`,
            lit.lightingApplied
                ? `Portrait Lighting: ${light} · skin ${((lit.skinShare ?? 0) * 100).toFixed(0)}%`
                : `no lighting — ${lit.reason ?? light}`,
            lightCanvas,
        );

        // 5. …and portrait blur last. Forced, because the whole reason this
        // stage is on the bench is to judge it BEFORE committing to it in
        // config — see the `force` note in applyPortrait. It is off by default.
        const portraitCanvas = copy();
        if (tone) applyTone(portraitCanvas, tone);
        applyLook(portraitCanvas, { beauty, lighting: light, force: true });
        const p = await applyPortrait(portraitCanvas, { force: true });
        push(
            'portrait',
            '+ portrait',
            p.applied
                ? `blur ${p.blurRadius}px · subject ${((p.subjectShare ?? 0) * 100).toFixed(0)}%` +
                      ` of frame` +
                      (CAPTURE_PORTRAIT.enabled ? '' : ' · forced here, OFF in the flow')
                : `skipped — ${p.reason}`,
            portraitCanvas,
        );

            return out;
        },
        [],
    );

    const capture = useCallback(
        async (frame: HTMLCanvasElement, beauty: number, light: LightingStyle) => {
            setBusy(true);
            frameRef.current = frame;
            try {
                const [stages, real] = await Promise.all([
                    renderStages(frame, beauty, light),
                    // The real thing, unmodified — see renderStages.
                    processFrame(frame),
                ]);
                setVariants(stages);
                setShipped(real);
                /*
                 * RAW first, always.
                 *
                 * This opened on the last stage — tone + portrait, forced on
                 * here — which is the single worst default for the job this
                 * page exists to do. When the capture came back black there was
                 * no way to tell from the screen whether the camera, the tone
                 * pass or the portrait pass had produced it, because only one
                 * of the three was ever on display.
                 *
                 * Starting from the untouched frame means the first thing seen
                 * is what the camera actually gave, and the strip below walks
                 * forward from there. If raw is right and a later stage is not,
                 * the page now says which.
                 */
                setShowing(0);
            } finally {
                setBusy(false);
            }
        },
        [renderStages],
    );

    const shoot = useCallback(() => {
        const video = videoRef.current;
        if (!video?.videoWidth) return;
        const frame = grabFrame(video);
        if (frame) void capture(frame, beautyStrength, lightStyle);
    }, [capture, beautyStrength, lightStyle]);

    /**
     * Load a photograph from disk instead of the camera.
     *
     * The colour work is the part that behaves differently in every room, and
     * a laptop webcam in an office cannot reproduce a phone in a stairwell at
     * night. Being able to drop in a frame captured somewhere else — including
     * one saved off /design/liveness-lab — is how a look gets judged against
     * more than one lighting situation in an afternoon.
     */
    const loadFile = useCallback(
        (file: File) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext('2d')?.drawImage(img, 0, 0);
                    void capture(c, beautyStrength, lightStyle);
                };
                img.src = String(reader.result);
            };
            reader.readAsDataURL(file);
        },
        [capture, beautyStrength, lightStyle],
    );

    /**
     * Re-run the stages over the frame already captured.
     *
     * Deliberately NOT re-shooting. Changing the strength and taking a new
     * photograph changes the pose, the expression and the light along with the
     * number, so the two versions differ in four ways and the slider gets
     * credit or blame for all of them. Reprocessing the same frame isolates the
     * one variable being judged.
     */
    const reprocess = useCallback(() => {
        const frame = frameRef.current;
        if (frame) void capture(frame, beautyStrength, lightStyle);
    }, [capture, beautyStrength, lightStyle]);

    /**
     * Same, for a lighting style change.
     *
     * ⚠️ Takes the style as an ARGUMENT rather than reading `lightStyle`. The
     * setter has not committed by the time the click handler runs, so reading
     * the state here would reprocess with the PREVIOUS style and the buttons
     * would appear to lag one click behind — which reads as the effect being
     * broken rather than as a stale read.
     */
    const relight = useCallback(
        (style: LightingStyle) => {
            const frame = frameRef.current;
            if (frame) void capture(frame, beautyStrength, style);
        },
        [capture, beautyStrength],
    );

    const current = variants[showing];

    return (
        <div className="mx-auto flex h-full w-390 flex-col py-24">
            <h1 className="fz-20 font-bold text-[#1D1D1D]">Capture bench</h1>
            <p className="fz-12 mt-4 leading-normal text-[#707070]">
                The captured face, stage by stage, with no sign-in and no AWS session.
                Runs the same <code>processFrame</code> the liveness check runs.
                Nothing leaves the browser.
            </p>

            {/* ── Source ─────────────────────────────────────────────────── */}
            <div className="mt-12 flex gap-6">
                {(['camera', 'file'] as Source[]).map((s) => (
                    <button
                        key={s}
                        type="button"
                        onClick={() => setSource(s)}
                        className="fz-11 h-28 flex-1 rad-8 border font-semibold"
                        style={{
                            borderColor: source === s ? '#3066CC' : '#d5d5d5',
                            color: source === s ? '#3066CC' : '#1D1D1D',
                        }}
                    >
                        {s === 'camera' ? 'Camera' : 'Load a photo'}
                    </button>
                ))}
            </div>

            {/* ── The frame ──────────────────────────────────────────────── */}
            <div className="relative mt-12 h-400 w-350 shrink-0 self-center overflow-hidden rad-30 bg-black">
                {/* ⚠️ Mounted for as long as the camera is the source, NOT only
                    until the first capture. It used to unmount the moment a
                    capture existed, which left `videoRef.current` null — so
                    "Capture again" did nothing at all, silently, and the only
                    way to take a second shot was to reload the page. The
                    capture below simply covers it. */}
                {source === 'camera' && (
                    <>
                        <video
                            ref={videoRef}
                            playsInline
                            muted
                            // Transparent, not hidden, while the retouched
                            // canvas is painting — the element must keep
                            // decoding, because `grabFrame` draws from it.
                            className="h-full w-full -scale-x-100 object-cover"
                            style={live.active && !current ? { opacity: 0 } : undefined}
                        />
                        <canvas
                            ref={liveCanvasRef}
                            aria-hidden
                            className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100 object-cover"
                            style={live.active && !current ? undefined : { display: 'none' }}
                        />
                        {!current && <CornerBrackets color="#FFEB00" inset={22} />}
                    </>
                )}

                {current && !inChrome && (
                    // eslint-disable-next-line @next/next/no-img-element -- data URL
                    <img
                        src={current.url}
                        alt={current.label}
                        className="absolute inset-0 h-full w-full object-cover"
                        style={{ transform: mirror ? 'scaleX(-1)' : undefined }}
                    />
                )}

                {/* The real verdict chrome, around the selected variant — so the
                    frame's design can be judged on a real photograph rather
                    than described. This is the component the flow mounts. */}
                {current && inChrome && (
                    <LivenessVerdict
                        phase="checking"
                        snapshot={current.url}
                        onRetry={() => undefined}
                    />
                )}

                {cameraError && (
                    <div className="absolute inset-0 flex items-center justify-center px-20">
                        <span className="fz-12 text-center text-white/80">{cameraError}</span>
                    </div>
                )}
            </div>

            {/* ⚠️ The one way this bench can mislead. */}
            <p
                className="fz-10 w-350 self-center leading-normal text-[#707070]"
                style={{ marginTop: rem(6) }}
            >
                Framing here is not the real framing — AWS&apos;s oval makes the person fill
                about 97% of the frame height, and nothing on this page enforces that. Judge
                sharpness, colour and the portrait look here; judge framing on a real run.
            </p>

            {/* ── Shoot ──────────────────────────────────────────────────── */}
            {source === 'camera' ? (
                <button
                    type="button"
                    onClick={shoot}
                    disabled={busy || !!cameraError}
                    className="fz-14 mt-12 h-48 w-350 shrink-0 self-center rad-12 bg-primary font-semibold text-white disabled:opacity-40"
                >
                    {busy ? 'Processing…' : current ? 'Capture again' : 'Capture'}
                </button>
            ) : (
                <label className="fz-14 mt-12 flex h-48 w-350 shrink-0 cursor-pointer items-center justify-center self-center rad-12 bg-primary font-semibold text-white">
                    Choose a photo
                    <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) loadFile(f);
                        }}
                    />
                </label>
            )}

            {/* ── Stream facts ───────────────────────────────────────────── */}
            {source === 'camera' && (
                <div className="mt-12 flex w-350 flex-col gap-6 self-center">
                    <button
                        type="button"
                        onClick={() => setBoost((b) => !b)}
                        className="fz-11 h-28 rad-8 border border-[#d5d5d5] font-semibold text-[#1D1D1D]"
                    >
                        {boost
                            ? `Resolution lift ON — asking ${CAPTURE_RESOLUTION.width}×${CAPTURE_RESOLUTION.height}`
                            : "Resolution lift OFF — AWS's 640×480"}
                    </button>
                    <p className="fz-10 leading-normal text-[#707070]">
                        Camera is delivering{' '}
                        <strong>
                            {streamSize ? `${streamSize.w} × ${streamSize.h}` : '…'}
                        </strong>
                        . If this stays at 640×480 with the lift on, this device refused it
                        — that is the whole story of whether the photo can be sharper here.
                    </p>

                    {/* ── The governor, made visible ───────────────────────
                        The live look steps itself down rather than compete
                        with the liveness check for CPU, and that is invisible
                        until you watch it. These are the numbers that answer
                        "can the devices the admins actually use afford this",
                        which is otherwise a hope rather than a measurement.

                        A surrender here is not a bug — it is the design
                        working. It means this device could not hold the budget
                        and chose the check over the cosmetics. */}
                    {variants.length === 0 && (
                        <p className="fz-10 leading-normal text-[#707070]">
                            Live look:{' '}
                            <strong>
                                {live.surrendered
                                    ? 'gave up — plain camera'
                                    : live.active
                                      ? `${live.frameMs.toFixed(1)}ms/frame at ${Math.round(
                                            live.scale * 100,
                                        )}% scale`
                                      : 'starting…'}
                            </strong>
                            . It steps down — resolution, then frame rate, then off — rather
                            than starve the liveness check, which AWS fails below 15fps.
                        </p>
                    )}
                </div>
            )}

            {/* ── The variants ───────────────────────────────────────────── */}
            {variants.length > 0 && (
                <div className="mt-16 flex w-350 flex-col gap-8 self-center">
                    <p className="fz-11 font-bold text-[#707070]">Stages</p>

                    {/* ── All of them at once ──────────────────────────────
                        The strip is the diagnostic. A stage that comes out
                        black is obvious here and nowhere else — the big frame
                        shows one variant at a time, so a pipeline that fails
                        at step three looks exactly like a camera that never
                        worked. Three thumbnails side by side say which. */}
                    <div className="flex gap-6">
                        {variants.map((v, i) => (
                            <button
                                key={`thumb-${v.key}`}
                                type="button"
                                onClick={() => setShowing(i)}
                                className="flex flex-1 flex-col gap-3"
                                title={v.label}
                            >
                                <span
                                    className="relative block h-120 w-full overflow-hidden rad-8 border bg-black"
                                    style={{
                                        borderColor: showing === i ? '#3066CC' : '#ececec',
                                    }}
                                >
                                    {/* eslint-disable-next-line @next/next/no-img-element -- data URL */}
                                    <img
                                        src={v.url}
                                        alt={v.label}
                                        className="absolute inset-0 h-full w-full object-cover"
                                        style={{
                                            transform: mirror ? 'scaleX(-1)' : undefined,
                                        }}
                                    />
                                </span>
                                <span
                                    className="fz-10 text-center font-semibold"
                                    style={{ color: showing === i ? '#3066CC' : '#707070' }}
                                >
                                    {v.label}
                                </span>
                                {/* The number that settles an argument about
                                    whether a thumbnail is "dark" or empty. */}
                                <span className="fz-10 text-center text-[#707070]">
                                    {v.brightness !== undefined
                                        ? v.brightness < 2
                                            ? 'BLANK'
                                            : `lum ${v.brightness.toFixed(0)}`
                                        : '—'}
                                </span>
                            </button>
                        ))}
                    </div>

                    {variants.map((v, i) => (
                        <button
                            key={v.key}
                            type="button"
                            onClick={() => setShowing(i)}
                            className="flex flex-col gap-3 rad-8 border p-8 text-start"
                            style={{
                                borderColor: showing === i ? '#3066CC' : '#ececec',
                                background: showing === i ? '#F4F8FF' : undefined,
                            }}
                        >
                            <span className="fz-12 font-semibold text-[#1D1D1D]">
                                {v.label}
                                {i === variants.length - 1 && CAPTURE_TONE.enabled ? ' · ships' : ''}
                            </span>
                            <span className="fz-10 leading-normal text-[#707070]">{v.note}</span>
                            <span className="fz-10 text-[#707070]">
                                {Math.round(v.bytes / 1024)} KB
                                {v.brightness !== undefined
                                    ? ` · brightness ${v.brightness.toFixed(0)}`
                                    : ''}
                                {v.sharpness !== undefined
                                    ? ` · sharpness ${v.sharpness.toFixed(0)}`
                                    : ''}
                            </span>
                        </button>
                    ))}

                    {/* ── Portrait Lighting ────────────────────────────────
                        Apple's styles, minus the two that need the background
                        replaced. Switching re-runs from the SAME frame, so the
                        three are directly comparable — which is the only way
                        to pick between them honestly. */}
                    <div className="flex flex-col gap-4">
                        <p className="fz-11 font-semibold text-[#1D1D1D]">Portrait Lighting</p>
                        <div className="flex gap-6">
                            {(['natural', 'studio', 'contour'] as LightingStyle[]).map((st) => (
                                <button
                                    key={st}
                                    type="button"
                                    onClick={() => {
                                        setLightStyle(st);
                                        relight(st);
                                    }}
                                    className="fz-11 h-28 flex-1 rad-8 border font-semibold capitalize"
                                    style={{
                                        borderColor: lightStyle === st ? '#3066CC' : '#d5d5d5',
                                        color: lightStyle === st ? '#3066CC' : '#1D1D1D',
                                    }}
                                >
                                    {st}
                                </button>
                            ))}
                        </div>
                        <p className="fz-10 leading-normal text-[#707070]">
                            Studio fills the shadowed side of the face so harsh modelling
                            softens out — that asymmetry is what reads as a soft light
                            rather than as the brightness slider. Natural is Apple&apos;s
                            &ldquo;no effect&rdquo;. Stage Light is not offered: it needs the
                            background dropped to black, and a flat background was already
                            tried here and read as a cut-out.
                        </p>
                    </div>

                    {/* ── Beauty strength, live ────────────────────────────
                        The one setting whose right value is a judgement about
                        a specific face in specific light. Releasing the slider
                        re-runs the stages from the SAME captured frame, so the
                        comparison is like for like — re-shooting between
                        settings would change the pose and the light along with
                        the number, which is how you talk yourself into the
                        wrong one. */}
                    <div className="flex flex-col gap-4">
                        <div className="fz-11 flex items-center justify-between font-semibold text-[#1D1D1D]">
                            <span>Beauty strength</span>
                            <span className="text-[#707070]">
                                {beautyStrength.toFixed(2)}
                                {Math.abs(beautyStrength - CAPTURE_BEAUTY.strength) > 0.001
                                    ? ` (config: ${CAPTURE_BEAUTY.strength})`
                                    : ''}
                            </span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={beautyStrength}
                            onChange={(e) => setBeautyStrength(Number(e.target.value))}
                            onMouseUp={() => reprocess()}
                            onTouchEnd={() => reprocess()}
                            onKeyUp={() => reprocess()}
                            className="w-full accent-[#3066CC]"
                        />
                        <p className="fz-10 leading-normal text-[#707070]">
                            0 is the untouched frame. Past about 0.7 it starts reading as a
                            filter rather than as good light. Put the value you settle on
                            into <code>CAPTURE_BEAUTY.strength</code>.
                        </p>
                    </div>

                    <div className="flex gap-6">
                        <button
                            type="button"
                            onClick={() => setMirror((m) => !m)}
                            className="fz-11 h-28 flex-1 rad-8 border border-[#d5d5d5] font-semibold text-[#1D1D1D]"
                        >
                            {mirror ? 'Mirrored' : 'Raw side'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setLivePortrait((p) => !p)}
                            className="fz-11 h-28 flex-1 rad-8 border border-[#d5d5d5] font-semibold text-[#1D1D1D]"
                        >
                            {livePortrait ? 'Live blur on' : 'Live blur off'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setInChrome((c) => !c)}
                            className="fz-11 h-28 flex-1 rad-8 border border-[#d5d5d5] font-semibold text-[#1D1D1D]"
                        >
                            {inChrome ? 'In verdict chrome' : 'Bare frame'}
                        </button>
                    </div>

                    {/* The capture is unmirrored — `drawImage` reads raw pixels,
                        so the CSS mirror the user watched themselves in is not
                        in it. Mirroring back is the default because a face one
                        has only ever seen mirrored looks subtly wrong
                        otherwise, and that reads as a quality problem. */}

                    {shipped && (
                        <div className="fz-10 flex flex-col gap-3 text-[#707070]">
                            <span>
                                captured {shipped.width} × {shipped.height} ·{' '}
                                {Math.round(shipped.storedBytes / 1024)} KB submitted
                                {shipped.display === shipped.stored
                                    ? ' · display identical'
                                    : ' · display differs (portrait is not baked)'}
                            </span>
                            <div className="flex gap-12">
                                <a
                                    href={shipped.stored}
                                    download="capture-stored.jpg"
                                    className="font-semibold text-primary underline"
                                >
                                    save submitted
                                </a>
                                <a
                                    href={shipped.display}
                                    download="capture-display.jpg"
                                    className="font-semibold text-primary underline"
                                >
                                    save displayed
                                </a>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Where the knobs are ────────────────────────────────────── */}
            <p
                className="fz-10 w-350 self-center leading-normal text-[#707070]"
                style={{ marginTop: rem(16) }}
            >
                Every number these stages use is in{' '}
                <code>src/features/kyc/config/capture.ts</code>, with the reasoning beside
                it. Portrait is{' '}
                <strong>{CAPTURE_PORTRAIT.enabled ? 'on' : 'off'}</strong> by default — it
                is the one stage here that is a look rather than a correction, and the one
                that was reverted once before.
            </p>
        </div>
    );
}
