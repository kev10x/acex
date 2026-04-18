import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 14,
  themeVariables: {
    primaryColor: '#047857',
    secondaryColor: '#22c55e',
    tertiaryColor: '#f8fafc',
    primaryTextColor: '#0f172a',
    secondaryTextColor: '#1f2937',
    border1: '#059669',
    border2: '#10b981',
    lineColor: '#059669',
    clusterBkg: '#ecfdf5',
    clusterBorder: '#6ee7b7',
    noteBkgColor: '#d1fae5',
    noteTextColor: '#065f46',
    edgeLabelBackground: '#ecfccb',
  },
  flowchart: { curve: 'basis', padding: 24, nodeSpacing: 60, rankSpacing: 60, useMaxWidth: true },
  sequence: { actorMargin: 50, useMaxWidth: true },
});

interface MermaidDiagramProps {
  code: string;
  className?: string;
}

const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code, className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Assign a stable ID once on mount using a lazy initializer so StrictMode
  // double-invocation doesn't consume two counter slots for a single instance.
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) {
    idRef.current = `mermaid-${crypto.randomUUID().slice(0, 8)}`;
  }

  useEffect(() => {
    if (!containerRef.current || !code?.trim()) return;
    setError(null);
    const id = idRef.current!;

    mermaid.render(id, code.trim())
      .then(({ svg }) => {
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
          const svgEl = containerRef.current.querySelector('svg');
          if (svgEl) {
            svgEl.removeAttribute('height');
            svgEl.style.maxWidth = '100%';
            svgEl.style.width = '100%';
          }
        }
      })
      .catch((err: { message?: string }) => {
        setError(err?.message || 'Diagram rendering failed');
      });
  }, [code]);

  if (error) {
    return (
      <div className={`flex items-center justify-center bg-gray-50 rounded-lg border border-dashed border-gray-300 p-6 text-sm text-gray-500 ${className}`}>
        Diagram unavailable
      </div>
    );
  }

  return <div ref={containerRef} className={`mermaid-container overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-3 shadow-sm ${className}`} />;
};

export default MermaidDiagram;
