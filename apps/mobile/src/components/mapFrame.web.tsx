// Website: the map page in an iframe; messages go through window.postMessage.

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';

import type { MapHandle } from './mapFrame';

export type { MapHandle } from './mapFrame';

export function MapFrame({
  html,
  onMessage,
  ref,
}: {
  html: string;
  onMessage: (msg: { type: string; [k: string]: unknown }) => void;
  ref: Ref<MapHandle>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });

  useImperativeHandle(ref, () => ({
    post: (msg) =>
      frame.current?.contentWindow?.postMessage({ madridgoApp: JSON.stringify(msg) }, '*'),
  }));

  useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const data = e.data as { madridgoMap?: string } | null;
      if (typeof data?.madridgoMap !== 'string') return;
      try {
        handler.current(JSON.parse(data.madridgoMap));
      } catch {
        // not one of ours
      }
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, []);

  return (
    <iframe
      ref={frame}
      srcDoc={html}
      title="Map"
      style={{ border: 0, width: '100%', height: '100%', position: 'absolute', inset: 0 }}
    />
  );
}
