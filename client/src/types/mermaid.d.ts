declare module 'mermaid' {
  interface MermaidRenderResult {
    svg: string;
    bindFunctions?: (element: Element) => void;
  }

  interface MermaidAPI {
    initialize: (config: Record<string, unknown>) => void;
    render: (id: string, code: string) => Promise<MermaidRenderResult>;
  }

  const mermaid: MermaidAPI;
  export default mermaid;
}
