import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <WebView 
        source={{ uri: 'https://cake-design-ai.replit.app' }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
      />
    </SafeAreaView>
  );
}