import { redirect } from "next/navigation";
import { PasswordStep } from "@/features/auth/components/LoginSteps";
import { readLoginFlow } from "@/lib/auth/login-flow";
import { redirectIfAuthenticated, resetFlowOnFullLoad } from "@/lib/auth/guards";

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/**
 * Login — step 2: enter password. Identical layout to the private-code step.
 *
 * The name line is blank until sign-in resolves: `/v1/registration` is the
 * first call, and it needs the password this screen is still collecting, so
 * nothing about the admin is known yet. The guard is the carried private code.
 */
export default async function PasswordPage() {
  // Already signed in — never show a sign-in step.
  await redirectIfAuthenticated();
  // A refresh at this step abandons the sign-in (no OTP sent yet).
  await resetFlowOnFullLoad();
  const flow = await readLoginFlow();
  if (!flow.privateCode) redirect("/login");

  return (
    <main className="flex h-full flex-col items-center">
      <div
        className="flex flex-col items-center justify-end"
        style={{ flexGrow: 2 }}
      >
        <h1 className="fz-30 text-ink w-full px-20 leading-none font-bold">
          Login !
        </h1>
        <p
          className="fz-16 text-ink w-full px-20 leading-none font-normal"
          style={{ marginTop: rem(12) }}
        >
          Enter Your Password
        </p>
        <p
          className="fz-14 text-ink/55 w-full px-20 leading-none font-normal"
          style={{ marginTop: rem(8) }}
        >
          {flow.name}
        </p>

        <div style={{ marginTop: rem(88) }}>
          <PasswordStep />
        </div>
      </div>

      {/* Reserved (white) space for the on-screen keyboard on mobile/tablet. */}
      <div
        className="w-full"
        style={{ flexGrow: 3, marginTop: rem(20) }}
        aria-hidden
      />
    </main>
  );
}
