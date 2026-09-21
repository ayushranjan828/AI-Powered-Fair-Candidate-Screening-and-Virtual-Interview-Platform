import { useEffect, useState } from "react";

import { englishVoices, speech } from "../lib/legacy.js";

/**
 * The installed English speech voices.
 *
 * getVoices() is empty until the engine has loaded them, so this listens for
 * `voiceschanged` and also re-reads once shortly after mount - some browsers
 * populate the list without ever firing the event.
 */
export default function useVoices() {
  const [voices, setVoices] = useState(() => englishVoices());
  const [preferred, setPreferred] = useState(() => speech().pickVoice());

  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      if (cancelled) return;
      const list = englishVoices();
      if (!list.length) return;
      setVoices(list);
      setPreferred(speech().pickVoice());
    };

    refresh();
    const synth = window.speechSynthesis;
    synth?.addEventListener?.("voiceschanged", refresh);
    const timer = setTimeout(refresh, 900);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      synth?.removeEventListener?.("voiceschanged", refresh);
      
    };
  }, []);

  return { voices, preferred };
}
