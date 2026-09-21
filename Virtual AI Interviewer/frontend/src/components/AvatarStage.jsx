import { useEffect, useRef } from "react";

import { avatar } from "../lib/legacy.js";

/**
 * Mounts the interviewer rig into a plain div.
 *
 * The rig owns everything inside this element and animates it on its own rAF
 * loop, so React must never re-render its children - hence the empty div and
 * the mount-once effect.
 *
 * Two rigs, in sequence. The SVG one (public/avatar.js) is already on
 * `window.Avatar` when React mounts, so it goes up immediately and there is
 * never an empty frame. The 3D backend is imported dynamically: it pulls in
 * three, which is far too big to load on pages that never show an avatar, and
 * it replaces `window.Avatar` as soon as it evaluates. Everything driving the
 * avatar resolves `window.Avatar` per call, so the handover needs no
 * co-ordination beyond mounting the new rig into the same element.
 */
export default function AvatarStage({ badge, className = "" }) {
  const host = useRef(null);

  useEffect(() => {
    if (!host.current) return undefined;
    let live = true;

    avatar().mount(host.current);

    import("../avatar/index.js")
      .then(({ default: rig }) => {
        if (live && host.current) rig.mount(host.current);
      })
      .catch((err) => {
        // The 2D rig is already on screen, so this is a downgrade, not a break.
        console.warn("Avatar: 3D backend unavailable, staying on the 2D rig", err);
      });

    return () => {
      live = false;
    };
  }, []);

  return (
    <div className={`avatar-frame ${className}`}>
      <div className="avatar-stage" ref={host} />
      {badge && (
        <div className="avatar-badge">
          <span className="rec-dot" />
          <span>{badge}</span>
        </div>
      )}
    </div>
  );
}
