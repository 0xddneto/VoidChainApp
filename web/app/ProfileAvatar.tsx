'use client';

import { useState } from 'react';

/**
 * A profile image is user supplied, so an unavailable remote image must never
 * leave a browser "broken image" glyph in the interface. In that case the
 * normal avatar placeholder is kept instead.
 */
export function ProfileAvatar({
  src,
  className,
  blankClassName,
  alt = '',
}: {
  src: string | null | undefined;
  className: string;
  blankClassName?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return <div className={[className, blankClassName].filter(Boolean).join(' ')} aria-hidden="true" />;
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={src} alt={alt} onError={() => setFailed(true)} />;
}
