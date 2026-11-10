import { redirect } from "next/navigation";
import { AddActionProvider } from "@/features/shell/add-action";
import { Shell } from "@/features/shell/components/Shell";
import { UnlockScreen } from "@/features/passcode/components/UnlockScreen";
import { safeNextPath } from "@/features/passcode/schema";
import {
  getAccessToken,
  getRefreshToken,
  readDeviceHint,
  readEnrolHint,
  readLockHolder,
  readPinLength,
} from "@/lib/auth/cookies";
import { cfEnv } from "@/lib/cf-env";
import { sessionFromCookie } from "@/lib/auth/session";

/**
 * Where middleware sends a PIN-locked session — see `UnlockScreen`.
 *
 * ── Gated by the REFRESH cookie, not by `requireSession()` ──────────────────
 * The whole reason somebody is here is that there is no access token, so the
 * session gate would bounce every visitor to /login. Holding a refresh token
 * is what makes this the right screen; without one there is nothing to unlock
 * and the splash decides where to go.
 *
 * That is also why this is not the redirect loop the dashboard overlay was
 * built to avoid: that loop was dashboard → passcode route → dashboard, both
 * gated on the same session. This one is gated on something the dashboard is
 * not, and middleware never refreshes on it.
 */
export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);

  if (!(await getRefreshToken())) redirect("/");
  // Not locked after all — unlocked in another tab, or the setting was
  // switched off. Nothing to prove.
  if (await getAccessToken()) redirect(next);

  // Display only: the name on the refusal that raised this lock, else the
  // snapshot from sign-in — there is no token to ask the backend with.
  const name = (await readLockHolder())?.name ?? (await sessionFromCookie())?.name;

  // Behind the glass: the dashboard's frame, so this looks like every other
  // lock — the workspace under a pane — rather than a page of its own. Only
  // the frame: the page that was asked for can't render without an access
  // token, and the selected system can't be read either (that needs the
  // backend too), so the shell shows the nothing-selected state.
  return (
    <AddActionProvider>
      <Shell systemCode={null} />
      <UnlockScreen
        name={name}
        next={next}
        length={await readPinLength()}
        deviceBound={await readDeviceHint()}
        enrolAvailable={await readEnrolHint()}
        rpId={cfEnv("WEBAUTHN_RP_ID")}
      />
    </AddActionProvider>
  );
}
