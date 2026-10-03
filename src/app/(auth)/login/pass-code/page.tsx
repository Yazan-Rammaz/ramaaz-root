import { Screen } from "@/components/ui/Screen";
import { PassCodeStep } from "@/features/passcode/components/PassCodeStep";
import { readChallenge, requireStage, UnknownStageError } from "@/lib/auth/challenge";
import { PASS_CODE_MODES, STAGES } from "@/lib/auth/endpoints";
import { getSession } from "@/lib/auth/session";
import { cfEnv } from "@/lib/cf-env";

/**
 * Stage `PASS_CODE_REQUIRED` — set the PIN (first login) or prove it (every
 * later one). See `PassCodeStep`.
 *
 * `requireStage` bounces anyone whose challenge is elsewhere, so this step can
 * never be answered out of order.
 *
 * ── Why a signed-in visitor is NOT redirected from here ─────────────────────
 * Every other step screen calls `redirectIfAuthenticated()`. This one cannot,
 * because of what finishing it does: `submitPassCodeAction` stores the session
 * cookies, and a Server Action that sets cookies RE-RENDERS the current page.
 * That render finds a session and no challenge — and a redirect there would
 * yank the person to the dashboard mid-animation, before the row has turned
 * green.
 *
 * So it renders the same `<PassCodeStep>` in the same place with no mode. React
 * keeps the mounted instance (same type, same position), which remembers its
 * mode and plays its success frame, then leaves on its own. A FRESH visit in
 * that state — the back button after signing in — has no mode to remember, and
 * the step sends it to the dashboard itself.
 */
export default async function PassCodePage() {
  const challenge = await readChallenge();
  if (!challenge.challengeToken && (await getSession())) {
    return (
      <Screen variant="centered" maxW={430} gutter={0} className="h-full">
        <PassCodeStep />
      </Screen>
    );
  }

  const {
    passCodeMode: mode,
    passCodeLength,
    passCodeDeviceAvailable,
    passCodeDeviceEnrolAvailable,
    fullName,
  } = await requireStage(STAGES.passCode);
  // An unknown mode is a backend newer than this screen. Refuse it loudly
  // rather than guess which of the two it resembles.
  if (mode !== PASS_CODE_MODES.set && mode !== PASS_CODE_MODES.verify) {
    throw new UnknownStageError(`${STAGES.passCode}:${mode ?? "no mode"}`);
  }

  return (
    <Screen variant="centered" maxW={430} gutter={0} className="h-full">
      <PassCodeStep
        mode={mode}
        length={passCodeLength}
        deviceAvailable={mode === PASS_CODE_MODES.verify && passCodeDeviceAvailable === true}
        deviceEnrolAvailable={
          mode === PASS_CODE_MODES.verify && passCodeDeviceEnrolAvailable === true
        }
        name={fullName}
        rpId={cfEnv("WEBAUTHN_RP_ID")}
      />
    </Screen>
  );
}
