import { notFound } from 'next/navigation';
import { DESIGN_CATALOG } from '../catalog';
import { SCREENS } from '../screens';

/**
 * One screen, rendered bare — no gallery chrome, nothing around it.
 *
 * This is what the gallery frames, and it is also worth opening directly: at a
 * browser window of exactly the canvas width, devtools reports XD pixels with no
 * conversion, which is the most direct way to check a measurement.
 */
export default async function DesignScreenPage({
    params,
}: {
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;

    const entry = DESIGN_CATALOG.find((e) => e.slug === slug);
    const render = SCREENS[slug];
    // A catalog entry with no render function (or the reverse) is a typo in one
    // of the two files. 404 rather than render half of it.
    if (!entry || !render) notFound();

    return (
        <>
            {/*
              Next's dev-tools badge is fixed to the bottom corner of the page,
              which inside the frame is the bottom corner of the CANVAS — right
              where the mobile screens put their primary action. It covers the
              thing being measured and reads as part of the design.

              Hidden from inside the framed document rather than injected from
              the gallery: the portal is created after load, so a one-shot
              injection races it, and a screen opened directly (`Open alone`)
              would keep the badge anyway. This whole route 404s outside
              development, so nothing about normal dev changes.
            */}
            <style>{`nextjs-portal{display:none!important}`}</style>
            {render()}
        </>
    );
}

export function generateStaticParams() {
    return DESIGN_CATALOG.map((e) => ({ slug: e.slug }));
}
