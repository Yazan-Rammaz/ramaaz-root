'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { VerdictMark } from '@/features/kyc/components/VerdictMark';
import { CAPTURE_CHECKING_GLASS } from '@/features/kyc/config/capture';
import { PhotoGlass } from '@/features/kyc/components/PhotoGlass';
import { MIRROR_CLASS } from '@/features/kyc/config/capture';

/**
 * What fills the frame once the camera has stopped.
 *
 * The liveness stream ends, and from then until the backend has decided there
 * is a gap of a second or two — the session result is fetched from AWS and the
 * face compared against the enrolled selfie, both server-side. This is that gap
 * and its outcome, over a frozen frame of the user's own face.
 *
 * ── Why a still and not the live camera ─────────────────────────────────────
 * The camera is gone by this point: AWS tears its widget down when the stream
 * completes, taking the video element with it. The still is grabbed in
 * `LivenessCamera` on the last frame, for this.
 *
 * ⚠️ It is NOT the image being judged. AWS chooses the reference image from the
 * stream server-side and our Worker fetches it from them — the browser never
 * sees it, which is the property that stops a tampered client choosing who gets
 * compared. This is a picture of the same moment, shown so the user has
 * something to watch. Nothing here is measured.
 *
 * ── No text, on purpose ─────────────────────────────────────────────────────
 * Colour and motion carry all three states. That is what the design asks for,
 * and it is the version that needs no translation — but it is also why every
 * state carries an ARIA label, since none of it exists for a screen reader.
 *
 * ── Checking hides the face. On purpose ─────────────────────────────────────
 * This used to be a scan bar travelling over a sharp still. Fine as motion and
 * wrong as a proposition: it invited somebody to study their own face at the
 * one moment they can do nothing about it, and an unflattering frozen frame is
 * what a person remembers from a check that then passed.
 *
 * So the still goes under glass — blurred past recognition, desaturated, the
 * background colour pulled down with it — and the only legible thing left is
 * that work is happening.
 *
 * `passed` and `failed` keep the sharp frame. The verdict is ABOUT that face,
 * and obscuring it while announcing a result would be the opposite trade.
 */

/**
 * How long the refusal is SHOWN before the retry takes the frame.
 *
 * Two seconds, and the length is the argument. Long enough to read the red
 * Face ID over your own face and understand that YOUR check was refused —
 * short enough that somebody who already knows what happened is not made to
 * watch it. Cutting straight to a retry button reads as the app having failed
 * rather than the check, which sends people to support instead of to the
 * button.
 */
const FAIL_HOLD_MS = 2000;

export type VerdictPhase = 'checking' | 'passed' | 'failed';

export function LivenessVerdict({
    phase,
    snapshot,
    plainSnapshot,
    onRetry,
}: {
    phase: VerdictPhase;
    /** Data URL of the last camera frame, or null if it could not be grabbed. */
    snapshot: string | null;
    /**
     * The same frame WITHOUT the portrait blur, for the checking state.
     *
     * ── Why two frames ──────────────────────────────────────────────────────
     * `snapshot` is the display frame, and the display frame has the background
     * defocused — that is the portrait look, and on a verdict it is the right
     * picture to show.
     *
     * Under glass it is the wrong one, and visibly so. Two softenings compound:
     * the room gets the portrait blur AND the glass, the face gets only the
     * glass, and the result reads as a pane that covers the background but not
     * the person — the opposite of a sheet laid over a photograph. The face
     * looks sharper the more glass is added, which is the giveaway.
     *
     * So the checking state uses the unretouched frame and lets the glass be
     * the only thing softening anything. Optional: a caller that has no plain
     * frame falls back to `snapshot`, which is the old behaviour.
     */
    plainSnapshot?: string | null;
    /** Start again. Only reachable from the failed state. */
    onRetry: () => void;
}) {
    const t = useTranslations('auth');

    /**
     * The failure has two beats: the red ring over the face, then the face
     * replaced by a retry. Three seconds is long enough to register that it was
     * YOUR face that failed rather than the app breaking, which is the whole
     * reason for holding rather than cutting straight to the retry.
     */
    const [showRetry, setShowRetry] = useState(false);
    useEffect(() => {
        if (phase !== 'failed') return;
        const id = setTimeout(() => setShowRetry(true), FAIL_HOLD_MS);
        // Reset in the CLEANUP, not in an early return. Both undo the retry
        // when the phase moves off `failed`, but a bare `setShowRetry(false)`
        // in the effect body is a synchronous setState during render — the
        // cascading-render rule the KYC folder already carries too much of.
        return () => {
            clearTimeout(id);
            setShowRetry(false);
        };
    }, [phase]);

    /**
     * The picture the pane stands over — the same string the sharp image below
     * it renders, because the glass works by drawing a filtered COPY and the
     * two have to be the same picture. See `.verdict-glass` in globals.css.
     */
    /**
     * The picture the pane stands over — the same string the sharp image below
     * it renders, because the glass works by drawing a filtered COPY and the
     * two have to be the same picture.
     *
     * ⚠️ `null`, never `''`. An empty `src` is not "no image": the browser
     * resolves it against the current URL and re-downloads the PAGE, which is
     * both a real request and a console error on every render. It also hid the
     * actual problem — the pane looked like it had failed when in fact it had
     * nothing to show.
     */
    const glassSrc = (phase === 'checking' ? (plainSnapshot ?? snapshot) : snapshot) ?? null;

    /*
     * The one state that has no honest picture: a phase that shows a face, with
     * no face to show. The frame falls back to its own black, which is correct
     * and is also indistinguishable from the glass having failed — so it says
     * so rather than leaving the next person to guess.
     */
    if (!snapshot && !showRetry) {
        console.warn(`[liveness] verdict has no snapshot to draw (phase: ${phase})`);
    }

    const label =
        phase === 'checking'
            ? t('faceChecking')
            : phase === 'passed'
              ? t('faceVerified')
              : t('faceVerifyFailed');

    return (
        <div
            className="verdict-layer absolute inset-0 overflow-hidden bg-black"
            role="status"
            aria-label={label}
        >
            {/* The frozen face, flipped exactly as the preview was — see
                `MIRROR_CLASS`. The two must agree: a picture that changes
                handedness at the moment of capture reads as a different
                person's photograph, not as a transform. */}
            {snapshot && !showRetry && (
                // A plain <img>, not next/image: this is a data URL held in
                // memory, and the optimiser has nothing to fetch or resize.
                //
                // Shown exactly as captured in every phase — no filter, no
                // retouching. That matters on a verdict because this is also
                // the frame CompareFaces is given at `face-match`, and the
                // screen should not announce a result over something other than
                // what was submitted.
                //
                // While checking, the glass over it is what softens the face;
                // the image itself is left alone. An earlier version blurred
                // the source as well and it was too much — a face nobody could
                // read at all, which is a different thing from a face behind
                // frosted glass.
                //
                // The unretouched frame while checking, the display frame on a
                // verdict — see `plainSnapshot`. The glass must be the only
                // thing softening the picture, or it covers the room and not
                // the person.
                // eslint-disable-next-line @next/next/no-img-element -- data URL
                <img
                    src={
                        phase === 'checking' ? (plainSnapshot ?? snapshot) : snapshot
                    }
                    alt=""
                    className={`absolute inset-0 h-full w-full object-cover ${MIRROR_CLASS}`}
                />
            )}

            {/* The viewfinder's falloff, over the frozen face — the same
                treatment the live frame carries, so the picture does not change
                appearance at the moment the camera stops. Gradient only, well
                short of the middle; the face is untouched. See globals.css.

                Not while checking: the glass below already darkens the whole
                frame, and the two together crush the foot of the picture to
                flat black. */}
            {snapshot && !showRetry && phase !== 'checking' && (
                <span aria-hidden className="frame-scrim pointer-events-none absolute inset-0" />
            )}

            {/* ── Checking: the pane, the light crossing it, and one line ─────
                Rendered whether or not a snapshot was grabbed. With one it is
                glass over an obscured face; without it, glass over black — and
                either way the screen is doing something, which is the whole
                complaint about what used to be here. */}
            {/* ── The pane, and whatever sits on it ──────────────────────
                Rendered for every state that shows a face, not just checking.
                A verdict under the same glass as the wait is one continuous
                screen: the picture does not snap back into focus at the moment
                a result lands, which read as two different screens fighting
                over the frame.

                Drawn whether or not a snapshot was grabbed. With one it is
                glass over an obscured face; without it, glass over black — and
                either way the screen is doing something. */}
            {!showRetry && (
                <>
                    {/* The pane. See PhotoGlass — the layers, the copy and the
                        refraction are shared with every other still in this
                        flow; what is local to the verdict is the TABLE it is
                        drawn from and the fact that it is at full strength.
                        The intro and the comparison stage pass a percentage.

                        `rad-30` matches the frame both callers draw. Without it
                        the pane's rim is a rectangle clipped square by the
                        parent's rounded corners, and the bevel — the one thing
                        carrying the material — dies exactly at the corners
                        where glass is most obviously glass.

                        With no picture it is frost over the frame's own black,
                        which is the honest thing to show when no frame was ever
                        kept. */}
                    <PhotoGlass
                        src={glassSrc}
                        amount={100}
                        className="rad-30"
                        /*
                         * ── The pane breathes while the servers decide ──────
                         *
                         * The same travel the comparison screen carries, and
                         * here for the same reason: this wait has no progress
                         * to report — AWS is uploading and analysing and will
                         * answer when it answers — so what is drawn has to read
                         * as activity without implying a position on a bar.
                         * Glass thickening and thinning does that; a pane at a
                         * fixed weight over a frozen face is a photograph with
                         * a filter on it.
                         *
                         * ⚠️ CHECKING ONLY, and the mark is the tell: the AI
                         * star means a model is working. `passed` and `failed`
                         * hold still, because by then the screen is announcing
                         * a RESULT and motion under a verdict reads as the
                         * verdict still being decided.
                         *
                         * ⚠️ AND IT NEVER CLEARS — see `waveFloor`. This pane's
                         * whole job is to stop somebody studying their own
                         * unflattering frozen frame at the one moment they can
                         * do nothing about it, and a trough at zero would serve
                         * them exactly that on every cycle.
                         *
                         * 20 to 100: a wide travel, and still a face behind
                         * glass at the bottom of it. Wider than the comparison
                         * screen's 10-to-50 because this pane starts at full
                         * strength — the same proportion of the same material,
                         * over a picture that is being withheld rather than
                         * dressed.
                         */
                        wave={phase === 'checking'}
                        waveFloor={20}
                        tuning={{
                            warp: CAPTURE_CHECKING_GLASS.scale,
                            warpBlur: CAPTURE_CHECKING_GLASS.blur,
                            frostBlur: CAPTURE_CHECKING_GLASS.frostBlur,
                            saturation: CAPTURE_CHECKING_GLASS.saturation,
                            frost: CAPTURE_CHECKING_GLASS.frost,
                        }}
                    />

                    {/* The mark, its light and the frame's edge — see
                        VerdictMark. Keyed by phase so the verdict animations
                        replay from their first frame on every transition
                        rather than being skipped because the element already
                        existed. */}
                    <VerdictMark key={phase} phase={phase} />
                </>
            )}

            {/* After the hold: the face is gone and there is one thing to do. */}
            {showRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    aria-label={t('deviceRetry')}
                    className="absolute inset-0 flex items-center justify-center"
                >
                    <span className="flex h-64 w-64 items-center justify-center rounded-full bg-white/10 text-white">
                        <Icon name="kyc/retry" size={30} mask alt="" />
                    </span>
                </button>
            )}
        </div>
    );
}
