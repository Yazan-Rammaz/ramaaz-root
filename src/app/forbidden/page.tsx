import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Screen } from "@/components/ui/Screen";

export default async function ForbiddenPage() {
  const t = await getTranslations("forbidden");
  return (
    <Screen variant="centered" maxW={560} gutter={24}>
      {/* min-h-full, not min-h-screen: `100vh` is iOS's large viewport. */}
      <div className="flex min-h-full flex-col items-center justify-center gap-16 text-center">
        <h1 className="fz-32 font-semibold">{t("title")}</h1>
        <p className="fz-16 opacity-70">{t("message")}</p>
        <Link href="/dashboard" className="fz-16 underline">
          {t("backToDashboard")}
        </Link>
      </div>
    </Screen>
  );
}
