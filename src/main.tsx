import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
);
