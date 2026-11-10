import { Icon } from "@/components/ui/Icon";
import type { GeoImage } from "../mock-geo";

/**
 * A map or flag thumbnail: our asset through `<Icon>`, or a file the person
 * picked (`src`, a data: URL), fitted inside the same XD box. `scale` shrinks
 * it for a smaller box.
 */
export function GeoThumb({
  image,
  scale = 1,
}: {
  image: GeoImage;
  scale?: number;
}) {
  const w = image.w * scale;
  const h = image.h * scale;
  if (!image.src) return <Icon name={image.icon} width={w} height={h} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- data: URL of a picked file
    <img
      src={image.src}
      alt=""
      draggable={false}
      className="inline-block object-contain select-none"
      style={{ width: `${w * 0.0625}rem`, height: `${h * 0.0625}rem` }}
    />
  );
}
