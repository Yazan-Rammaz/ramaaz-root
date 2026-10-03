"use client";

import { useState } from "react";
import { PasscodeLockGate } from "@/features/passcode/components/PasscodeLockGate";

/**
 * The lock gate, for the gallery.
 *
 * A client wrapper for the same reason `<FaceLivenessPreview>` is one:
 * `screens.tsx` is a Server Component and the gate takes two callbacks, which
 * cannot cross that boundary as props.
 *
 * ── Unlocking has to DO something here ──────────────────────────────────────
 * Both callbacks used to be `() => {}`, on the reasoning that this entry exists
 * to look at a locked screen and dismissing it would take the subject away.
 * That was wrong the moment the passkey landed: the whole thing being tested is
 * "Face ID opens, and I am through", and with a no-op the prompt appeared, the
 * person authenticated, and the screen sat there — indistinguishable from the
 * ceremony having failed.
 *
 * So it dismisses, and offers to lock again.
 *
 * ⚠️ No passkey here any more. It runs on the backend's WebAuthn now, which
 * needs a session this gallery does not have — exercise it on the real lock.
 */
export function PasscodeLockPreview() {
  const [locked, setLocked] = useState(true);

  if (!locked) {
    return (
      <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-16 bg-white/90">
        <p className="fz-18 text-ink leading-none font-semibold">Unlocked</p>
        <button
          type="button"
          onClick={() => setLocked(true)}
          className="fz-14 leading-none font-medium text-[#388CFF] underline"
        >
          Lock again
        </button>
      </div>
    );
  }

  return (
    <PasscodeLockGate
      name="Mohamad Katmawi"
      // Any six digits reach the green state — there is no passcode stored in
      // a reviewer's browser. See the prop's note.
      preview
      onUnlocked={() => setLocked(false)}
      // Signing out of a session that does not exist would only blank the
      // gallery, so this lands in the same place an unlock does.
      onSignOut={() => setLocked(false)}
    />
  );
}
