import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '24px', fontFamily: 'sans-serif', color: '#0f2a3d' }}>
          <h2 style={{ margin: '0 0 8px', color: '#b91c1c' }}>অ্যাপ চালু করতে সমস্যা হয়েছে</h2>
          <p style={{ margin: '0 0 12px', fontSize: '14px', color: '#5d7283' }}>
            {this.state.error.message || 'Unknown error'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ background: '#0a7c73', color: '#fff', border: 0, padding: '10px 16px', borderRadius: '8px' }}
          >
            আবার চেষ্টা করুন
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
