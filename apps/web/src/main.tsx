import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="boot-screen failure-screen"><h1>故事暂时停了一下。</h1><p>界面遇到问题，请重新打开。不会自动清除你的本地进度。</p><button className="button button-dark" onClick={() => location.reload()}>重新打开</button></div> : this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><AppBoundary><App /></AppBoundary></StrictMode>);
