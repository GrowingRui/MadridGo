// App (iOS/Android): the map page in a WebView. The website uses mapFrame.web.tsx (an iframe).

import { type ComponentType, useImperativeHandle, useRef, type Ref } from 'react';
import { StyleSheet } from 'react-native';
import { WebView as RNWebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';

// The package's class typings collapse to `never` with strict TypeScript; type what we use.
interface WebViewHandle {
  injectJavaScript: (script: string) => void;
}
const WebView = RNWebView as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;

export interface MapHandle {
  post: (msg: object) => void;
}

export function MapFrame({
  html,
  onMessage,
  ref,
}: {
  html: string;
  onMessage: (msg: { type: string; [k: string]: unknown }) => void;
  ref: Ref<MapHandle>;
}) {
  const web = useRef<WebViewHandle>(null);
  useImperativeHandle(ref, () => ({
    post: (msg) => {
      web.current?.injectJavaScript(`window.madridgoMap && window.madridgoMap(${JSON.stringify(msg)}); true;`);
    },
  }));
  return (
    <WebView
      ref={web}
      originWhitelist={['*']}
      source={{ html, baseUrl: 'https://madridgo.local/' }}
      style={StyleSheet.absoluteFill}
      onMessage={(e: WebViewMessageEvent) => {
        try {
          onMessage(JSON.parse(e.nativeEvent.data));
        } catch {
          // not one of ours
        }
      }}
    />
  );
}
