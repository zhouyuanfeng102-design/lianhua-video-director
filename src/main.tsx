import React from 'react';
import ReactDOM from 'react-dom/client';
import { initializeAndroidBridge } from './platform/androidBridge';
import './styles.css';
import './appThemes.css';

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    console.error('莲华视频导演台渲染失败', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ minHeight: '100vh', padding: 32, background: '#f2f4f7', color: '#26212d', fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif' }}>
        <section style={{ maxWidth: 720, margin: '60px auto', padding: 24, border: '1px solid rgba(48,42,59,.16)', borderRadius: 8, background: '#fff' }}>
          <h1 style={{ fontSize: 22 }}>莲华视频导演台界面加载失败</h1>
          <p>请把下面错误内容发给开发者，应用数据不会因此删除。</p>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#96394a' }}>{this.state.error}</pre>
        </section>
      </main>
    );
  }
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
const start = async () => {
  // Install native persistence before App's state initializer can read storage.
  await initializeAndroidBridge();
  const { default: App } = await import('./App');
  await import('./mobile.css');
  root.render(
    <React.StrictMode>
      <AppErrorBoundary><App /></AppErrorBoundary>
    </React.StrictMode>
  );
};
void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.render(<main style={{ padding: 24, fontFamily: 'sans-serif' }}><h1>应用启动失败</h1><p>本地存档未被覆盖。请重新打开应用。</p><pre style={{ whiteSpace: 'pre-wrap' }}>{message}</pre></main>);
});
