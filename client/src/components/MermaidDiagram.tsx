import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 14,
  flowchart: { curve: 'basis', padding: 20 },
  sequence: { actorMargin: 50 },
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
      .catch((err) => {
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

  return <div ref={containerRef} className={`mermaid-container overflow-auto ${className}`} />;
};

export default MermaidDiagram;
