import { EntryRedirect } from "@/features/splash/components/EntryRedirect";

/**
 * Entry point ("/"). No content — it auth-checks and redirects to /dashboard or
 * /login, with the splash covering the hop.
 *
 * The splash is mounted HERE, not in the root layout. In the root layout it
 * remounted whenever the router cache was invalidated — which every Server
 * Action that writes a cookie does — and replayed its 4.5s animation, so each
 * step of the login flow looked like a page reload. Scoped to this route it
 * cannot: nothing else mounts it.
 */
export default function RootPage() {
  return (
    <>
      <EntryRedirect />
    </>
  );
}
